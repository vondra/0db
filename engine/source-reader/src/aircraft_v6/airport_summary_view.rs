//! `airport_summary.arrow` sidecar loader (v5). Reads the global
//! single-row-per-airport file produced by Stage 2C v5 reduce phase
//! and builds the `AirportSummaryLookup` HashMap noise-compute's
//! `airport_traffic::run` consumes.
//!
//! Missing file → caller MUST propagate `None` to the popup so the
//! popup refuses to display airport-level arr/dep counts. Per Codex C4
//! + Claude W1; no silent fallback to per-row sum (which would
//! over-count rotations crossing N microsegments by ~N×).

use std::path::Path;

use arrow::array::Array;
use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{
    airport_traffic::AirportSummaryEntry, NUM_GSE_CLASSES,
};

use super::columns::{col_fixed_size_list, col_str, col_u32};

/// Owned per-airport buffers. The lookup HashMap borrows the
/// `airport_key` slices into this struct's `Vec<String>`.
pub struct AirportSummaryAccum {
    airport_keys: Vec<String>,
    entries: Vec<AirportSummaryEntry>,
}

impl AirportSummaryAccum {
    pub fn new(batches: &[RecordBatch]) -> Self {
        let mut accum = AirportSummaryAccum {
            airport_keys: Vec::new(),
            entries: Vec::new(),
        };
        for batch in batches {
            accum.absorb(batch);
        }
        accum
    }

    fn absorb(&mut self, batch: &RecordBatch) {
        let n = batch.num_rows();
        let (
            Some(airport_key),
            Some(arr),
            Some(dep),
            Some(gse_list),
            Some(ops_list),
        ) = (
            col_str(batch, "airport_key"),
            col_u32(batch, "airport_unique_arr_count"),
            col_u32(batch, "airport_unique_dep_count"),
            col_fixed_size_list(batch, "airport_unique_gse_count_per_class"),
            col_fixed_size_list(batch, "airport_unique_ops_count_per_kind"),
        ) else {
            return;
        };
        if gse_list.value_length() != NUM_GSE_CLASSES as i32
            || ops_list.value_length() != 3
        {
            return;
        }
        let Some(gse_buf) = gse_list
            .values()
            .as_any()
            .downcast_ref::<arrow::array::UInt32Array>()
        else {
            return;
        };
        let Some(ops_buf) = ops_list
            .values()
            .as_any()
            .downcast_ref::<arrow::array::UInt32Array>()
        else {
            return;
        };
        self.airport_keys.reserve(n);
        self.entries.reserve(n);
        for i in 0..n {
            let lo_g = i * NUM_GSE_CLASSES;
            let mut gse = [0u32; NUM_GSE_CLASSES];
            gse.copy_from_slice(&gse_buf.values()[lo_g..lo_g + NUM_GSE_CLASSES]);
            let lo_o = i * 3;
            let mut ops = [0u32; 3];
            ops.copy_from_slice(&ops_buf.values()[lo_o..lo_o + 3]);
            self.airport_keys.push(airport_key.value(i).to_string());
            self.entries.push(AirportSummaryEntry {
                arr_count: arr.value(i),
                dep_count: dep.value(i),
                gse_count_per_class: gse,
                ops_count_per_kind: ops,
            });
        }
    }

    /// Build a borrow-keyed lookup the popup compute consumes.
    pub fn lookup(
        &self,
    ) -> noise_compute::compute::aircraft_v6::airport_traffic::AirportSummaryLookup<'_> {
        self.airport_keys
            .iter()
            .zip(self.entries.iter())
            .map(|(k, e)| (k.as_str(), *e))
            .collect()
    }
}

/// Load `airport_summary.arrow` from disk. Returns `Ok(None)` when the
/// file is absent (popup MUST then refuse to populate airport-level
/// counts), `Err` only on actual read failure.
pub fn load_airport_summary(path: &Path) -> Result<Option<AirportSummaryAccum>, String> {
    if !path.exists() {
        return Ok(None);
    }
    use arrow::ipc::reader::FileReader;
    use std::fs::File;
    use std::io::BufReader;
    let f = File::open(path)
        .map_err(|e| format!("open airport_summary.arrow at {}: {e}", path.display()))?;
    let r = FileReader::try_new(BufReader::new(f), None).map_err(|e| {
        format!("arrow ipc {} (re-extract aircraft pipeline?): {e}", path.display())
    })?;
    let schema = r.schema();
    // Defence-in-depth: check both `schema_version` and the dimensional
    // `airport_summary_contract` stamps. Per /gg Codex audit, a corrupt
    // sidecar could carry one stamp but not the other; reject either
    // mismatch loud so the popup gets `Err` rather than zero counts.
    let sv = schema.metadata().get("schema_version").map(String::as_str);
    if sv != Some(super::EXPECTED_SCHEMA_VERSION) {
        return Err(format!(
            "{} schema_version mismatch (expected {}, got {:?}) \
             — re-extract aircraft pipeline",
            path.display(),
            super::EXPECTED_SCHEMA_VERSION,
            sv
        ));
    }
    let v = schema.metadata().get("airport_summary_contract");
    if v.map(String::as_str) != Some("airport_summary_v1") {
        return Err(format!(
            "{} airport_summary_contract mismatch (expected airport_summary_v1, got {:?}) \
             — re-extract aircraft pipeline",
            path.display(),
            v
        ));
    }
    let mut batches = Vec::new();
    for b in r {
        let batch = b.map_err(|e| {
            format!("read batch from {}: {e}", path.display())
        })?;
        batches.push(batch);
    }
    Ok(Some(AirportSummaryAccum::new(&batches)))
}
