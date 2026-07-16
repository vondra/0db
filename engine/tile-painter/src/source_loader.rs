//! Read v6 cruise arrow files for a set of H3 R4 hex cells and surface
//! them as [`CruiseRowView`] slices the noise-compute kernel consumes.
//!
//! Mirrors the loader pattern from
//! `source-reader/src/aircraft_v6/cruise_view.rs` but lives here so
//! tile-painter has no dependency on the NAPI-shaped `source-reader`
//! crate. Schema must stay in sync — the `column_by_name` lookups are
//! the contract.
//!
//! v14: cruise schema swap drops the per-fid lists. The heatmap kernel
//! doesn't read identity fields acoustically (just `class` /
//! `rep_alt_m` etc.), so this loader skips top_candidates entirely
//! and passes an empty slice. Same outcome as v13's empty-arrays
//! fallback path.

use std::path::Path;

use anyhow::{anyhow, Result};
use arrow::array::{Array, UInt32Array};
use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{CruiseRowView, CruiseTopCandidateView};

/// Owns per-row buffers borrowed by [`Self::views`]. v14 schema.
pub struct CruiseData {
    rows: Vec<OwnedCruiseRow>,
}

struct OwnedCruiseRow {
    r7_hex: u64,
    class: u8,
    rep_profile_idx: u8,
    fl_bin: u8,
    period: u8,
    sum_length_m: f32,
    rep_len_m: f32,
    rep_alt_m: f32,
    rep_speed_kt: f32,
    source_id: u8,
    origin: u8,
    unique_count: u32,
}

impl CruiseData {
    pub fn empty() -> Self {
        Self { rows: Vec::new() }
    }

    /// Load `cruise.arrow` files for every R4 hex in `r4_hexes` from
    /// `h3r4_dir`. Missing files are silently skipped (rural R4s may
    /// have no cruise traffic). Returns an empty [`CruiseData`] if no
    /// file is found.
    pub fn load_for_r4s(h3r4_dir: &Path, r4_hexes: &[u64]) -> Result<Self> {
        let mut rows = Vec::new();
        for &r4 in r4_hexes {
            crate::schema_check::read_arrow_for_r4(
                h3r4_dir,
                r4,
                "cruise.arrow",
                crate::schema_check::check_cruise_contract,
                |batch| absorb_batch(batch, &mut rows),
            )?;
        }
        Ok(Self { rows })
    }

    /// Heatmap kernels don't read identity (callsign / typecode / fid)
    /// from cruise rows — they hash per-row geometry and class for
    /// pixel-level accumulation. v14 schema's `top_candidates` is left
    /// empty here; the kernel never iterates it.
    pub fn views(&self) -> Vec<CruiseRowView<'_>> {
        self.rows
            .iter()
            .map(|r| CruiseRowView {
                r7_hex: r.r7_hex,
                class: r.class,
                rep_profile_idx: r.rep_profile_idx,
                fl_bin: r.fl_bin,
                period: r.period,
                sum_length_m: r.sum_length_m,
                rep_len_m: r.rep_len_m,
                rep_alt_m: r.rep_alt_m,
                rep_speed_kt: r.rep_speed_kt,
                source_id: r.source_id,
                origin: r.origin,
                unique_count: r.unique_count,
                top_candidates: EMPTY_CANDS,
            })
            .collect()
    }

    pub fn n_rows(&self) -> usize {
        self.rows.len()
    }
}

const EMPTY_CANDS: &[CruiseTopCandidateView<'static>] = &[];

fn absorb_batch(batch: &RecordBatch, rows: &mut Vec<OwnedCruiseRow>) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    let r7 = col_u64(batch, "r7_hex")?;
    let class = col_u8(batch, "class")?;
    let rep_pi = col_u8(batch, "rep_profile_idx")?;
    let fl_bin = col_u8(batch, "fl_bin")?;
    let period = col_u8(batch, "period")?;
    let sum_len = col_f32(batch, "sum_length_m")?;
    let rep_len = col_f32(batch, "rep_len_m")?;
    let rep_alt = col_f32(batch, "rep_alt_m")?;
    let rep_speed = col_f32(batch, "rep_speed_kt")?;
    let unique_count = col_u32(batch, "unique_count")?;
    // `source_id` / `origin` are optional — older arrows without them
    // default to zero. Wrong-type still bails: a `UInt16` `source_id`
    // truncating to u8 would silently drop high bytes.
    let source_id = col_u8_optional(batch, "source_id")?;
    let origin = col_u8_optional(batch, "origin")?;
    for i in 0..n {
        rows.push(OwnedCruiseRow {
            r7_hex: r7.value(i),
            class: class.value(i),
            rep_profile_idx: rep_pi.value(i),
            fl_bin: fl_bin.value(i),
            period: period.value(i),
            sum_length_m: sum_len.value(i),
            rep_len_m: rep_len.value(i),
            rep_alt_m: rep_alt.value(i),
            rep_speed_kt: rep_speed.value(i),
            source_id: source_id.map(|a| a.value(i)).unwrap_or(0),
            origin: origin.map(|a| a.value(i)).unwrap_or(0),
            unique_count: unique_count.value(i),
        });
    }
    Ok(())
}

// --- Typed column downcasts (local copy of source-reader/aircraft_v6/columns.rs) ---

use arrow::array::{Float32Array, UInt64Array, UInt8Array};

fn col_u64<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt64Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_u8<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt8Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_u32<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt32Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_f32<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a Float32Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}

/// `Some(col)` if the column exists and is `UInt8`; `None` if absent.
/// Errors on a column present but a non-UInt8 type — silently dropping
/// that case would let a future `UInt16` `source_id` truncate without
/// notice. Only the optional-presence case (older arrows missing the
/// column) is tolerated.
fn col_u8_optional<'a>(b: &'a RecordBatch, n: &str) -> Result<Option<&'a UInt8Array>> {
    let Some(col) = b.column_by_name(n) else {
        return Ok(None);
    };
    col.as_any()
        .downcast_ref::<UInt8Array>()
        .map(Some)
        .ok_or_else(|| anyhow!("column {n} present but not UInt8"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Float32Array, Int32Array, UInt32Array, UInt64Array, UInt8Array};
    use arrow::datatypes::{Field, Schema};
    use std::sync::Arc;

    fn valid_columns() -> Vec<(&'static str, ArrayRef)> {
        vec![
            (
                "r7_hex",
                Arc::new(UInt64Array::from(vec![0xABCu64])) as ArrayRef,
            ),
            ("class", Arc::new(UInt8Array::from(vec![5u8])) as ArrayRef),
            (
                "rep_profile_idx",
                Arc::new(UInt8Array::from(vec![7u8])) as ArrayRef,
            ),
            ("fl_bin", Arc::new(UInt8Array::from(vec![3u8])) as ArrayRef),
            ("period", Arc::new(UInt8Array::from(vec![0u8])) as ArrayRef),
            (
                "sum_length_m",
                Arc::new(Float32Array::from(vec![5000.0f32])) as ArrayRef,
            ),
            (
                "rep_len_m",
                Arc::new(Float32Array::from(vec![1500.0f32])) as ArrayRef,
            ),
            (
                "rep_alt_m",
                Arc::new(Float32Array::from(vec![11_000.0f32])) as ArrayRef,
            ),
            (
                "rep_speed_kt",
                Arc::new(Float32Array::from(vec![460.0f32])) as ArrayRef,
            ),
            (
                "unique_count",
                Arc::new(UInt32Array::from(vec![3u32])) as ArrayRef,
            ),
        ]
    }

    fn batch_from(cols: Vec<(&str, ArrayRef)>) -> RecordBatch {
        let fields: Vec<Field> = cols
            .iter()
            .map(|(n, a)| Field::new(*n, a.data_type().clone(), false))
            .collect();
        let arrs: Vec<ArrayRef> = cols.into_iter().map(|(_, a)| a).collect();
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrs).unwrap()
    }

    #[test]
    fn cruise_valid_loads() {
        let batch = batch_from(valid_columns());
        let mut rows = Vec::new();
        absorb_batch(&batch, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].r7_hex, 0xABC);
        assert_eq!(rows[0].fl_bin, 3);
    }

    #[test]
    fn cruise_missing_required_column_bails() {
        let cols: Vec<_> = valid_columns()
            .into_iter()
            .filter(|(n, _)| *n != "fl_bin")
            .collect();
        let batch = batch_from(cols);
        let err = absorb_batch(&batch, &mut Vec::new()).unwrap_err();
        assert!(
            format!("{err:#}").contains("fl_bin"),
            "error must name dropped column: {err:#}"
        );
    }

    #[test]
    fn cruise_wrong_type_column_bails() {
        let mut cols = valid_columns();
        // r7_hex defined as UInt64; replace with Int32 → downcast fails.
        cols[0].1 = Arc::new(Int32Array::from(vec![0xABCi32])) as ArrayRef;
        let batch = batch_from(cols);
        let err = absorb_batch(&batch, &mut Vec::new()).unwrap_err();
        assert!(
            format!("{err:#}").contains("r7_hex"),
            "error must name wrong-typed column: {err:#}"
        );
    }
}
