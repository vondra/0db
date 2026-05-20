//! Stage 2B disk-spill IPC format.
//!
//! Spill rows persist a **raw `CruiseAccum`** (weighted numerators +
//! per-fid metadata) tagged with its target R4 — the merge step
//! reconstructs the same `(R4, CruiseKey) → CruiseAccum` map the old
//! in-memory fold/reduce produced. Distinct from `cruise.arrow`,
//! which only stores finalised `CruiseBucket` (averages), because
//! finalisation is one-way and merging averages would corrupt the
//! per-energy means.
//!
//! No `schema_version` metadata: spill files are intra-process scratch,
//! never read by a different binary. Bypasses
//! [`arrow_io::read_record_batches`] (which asserts the version) via a
//! local reader.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use arrow::array::{
    Array, FixedSizeBinaryArray, FixedSizeBinaryBuilder, Float32Array, Float32Builder, ListArray,
    StringArray, StringBuilder, UInt64Array, UInt64Builder, UInt8Array, UInt8Builder,
};
use arrow::buffer::OffsetBuffer;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::ipc::reader::FileReader;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;

/// One spilled `(R4, CruiseKey, CruiseAccum)` triple. Field order
/// mirrors the writer schema so column-by-column build/read stays
/// trivially auditable.
pub(crate) struct CruiseSpillRow {
    pub r4: u64,
    pub r8_hex: u64,
    pub class: u8,
    pub fl_bin: u8,
    pub period: u8,
    pub rep_profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    pub sum_length_m: f32,
    pub weight: f32,
    pub rep_alt_m: f32,
    pub rep_speed_kt: f32,
    pub rep_len_m: f32,
    pub rep_len_w: f32,
    pub flight_ids: Vec<u64>,
    pub aircraft_types: Vec<[u8; 4]>,
    pub callsigns: Vec<String>,
}

fn spill_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("r4", DataType::UInt64, false),
        Field::new("r8_hex", DataType::UInt64, false),
        Field::new("class", DataType::UInt8, false),
        Field::new("fl_bin", DataType::UInt8, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("rep_profile_idx", DataType::UInt8, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
        Field::new("sum_length_m", DataType::Float32, false),
        Field::new("weight", DataType::Float32, false),
        Field::new("rep_alt_m", DataType::Float32, false),
        Field::new("rep_speed_kt", DataType::Float32, false),
        Field::new("rep_len_m", DataType::Float32, false),
        Field::new("rep_len_w", DataType::Float32, false),
        Field::new(
            "flight_ids",
            DataType::List(Arc::new(Field::new("item", DataType::UInt64, false))),
            false,
        ),
        Field::new(
            "aircraft_types",
            DataType::List(Arc::new(Field::new(
                "item",
                DataType::FixedSizeBinary(4),
                false,
            ))),
            false,
        ),
        Field::new(
            "callsigns",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, false))),
            false,
        ),
    ]))
}

pub(crate) fn write_cruise_spill(path: &Path, rows: &[CruiseSpillRow]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let schema = spill_schema();
    let n = rows.len();
    let mut r4 = UInt64Builder::with_capacity(n);
    let mut r8 = UInt64Builder::with_capacity(n);
    let mut class = UInt8Builder::with_capacity(n);
    let mut fl_bin = UInt8Builder::with_capacity(n);
    let mut period = UInt8Builder::with_capacity(n);
    let mut rep_pi = UInt8Builder::with_capacity(n);
    let mut source_id = UInt8Builder::with_capacity(n);
    let mut origin = UInt8Builder::with_capacity(n);
    let mut sum_len = Float32Builder::with_capacity(n);
    let mut weight = Float32Builder::with_capacity(n);
    let mut rep_alt = Float32Builder::with_capacity(n);
    let mut rep_speed = Float32Builder::with_capacity(n);
    let mut rep_len = Float32Builder::with_capacity(n);
    let mut rep_len_w = Float32Builder::with_capacity(n);

    let total_fids: usize = rows.iter().map(|r| r.flight_ids.len()).sum();
    let mut fid_off: Vec<i32> = Vec::with_capacity(n + 1);
    fid_off.push(0);
    let mut fid_vals = UInt64Builder::with_capacity(total_fids);
    let mut typecode_vals = FixedSizeBinaryBuilder::with_capacity(total_fids, 4);
    let mut callsign_vals = StringBuilder::with_capacity(total_fids, total_fids * 8);
    let mut running = 0usize;

    for row in rows {
        r4.append_value(row.r4);
        r8.append_value(row.r8_hex);
        class.append_value(row.class);
        fl_bin.append_value(row.fl_bin);
        period.append_value(row.period);
        rep_pi.append_value(row.rep_profile_idx);
        source_id.append_value(row.source_id);
        origin.append_value(row.origin);
        sum_len.append_value(row.sum_length_m);
        weight.append_value(row.weight);
        rep_alt.append_value(row.rep_alt_m);
        rep_speed.append_value(row.rep_speed_kt);
        rep_len.append_value(row.rep_len_m);
        rep_len_w.append_value(row.rep_len_w);
        debug_assert_eq!(row.flight_ids.len(), row.aircraft_types.len());
        debug_assert_eq!(row.flight_ids.len(), row.callsigns.len());
        for ((&fid, tc), cs) in row
            .flight_ids
            .iter()
            .zip(row.aircraft_types.iter())
            .zip(row.callsigns.iter())
        {
            fid_vals.append_value(fid);
            typecode_vals.append_value(tc)?;
            callsign_vals.append_value(cs);
        }
        running += row.flight_ids.len();
        fid_off.push(running as i32);
    }

    let offset_buf = OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(fid_off));
    let fid_list = ListArray::new(
        Arc::new(Field::new("item", DataType::UInt64, false)),
        offset_buf.clone(),
        Arc::new(fid_vals.finish()),
        None,
    );
    let typecode_list = ListArray::new(
        Arc::new(Field::new("item", DataType::FixedSizeBinary(4), false)),
        offset_buf.clone(),
        Arc::new(typecode_vals.finish()),
        None,
    );
    let callsign_list = ListArray::new(
        Arc::new(Field::new("item", DataType::Utf8, false)),
        offset_buf,
        Arc::new(callsign_vals.finish()),
        None,
    );

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(r4.finish()),
            Arc::new(r8.finish()),
            Arc::new(class.finish()),
            Arc::new(fl_bin.finish()),
            Arc::new(period.finish()),
            Arc::new(rep_pi.finish()),
            Arc::new(source_id.finish()),
            Arc::new(origin.finish()),
            Arc::new(sum_len.finish()),
            Arc::new(weight.finish()),
            Arc::new(rep_alt.finish()),
            Arc::new(rep_speed.finish()),
            Arc::new(rep_len.finish()),
            Arc::new(rep_len_w.finish()),
            Arc::new(fid_list),
            Arc::new(typecode_list),
            Arc::new(callsign_list),
        ],
    )?;

    let f = File::create(path)
        .with_context(|| format!("create spill {}", path.display()))?;
    // BufWriter coalesces FileWriter's many small writes into one
    // syscall per ~8 KB — meaningful at 1024 small files per flush.
    let mut w = FileWriter::try_new(BufWriter::new(f), &schema)?;
    if batch.num_rows() > 0 {
        w.write(&batch)?;
    }
    w.finish()?;
    Ok(())
}

pub(crate) fn read_cruise_spill(path: &Path) -> Result<Vec<CruiseSpillRow>> {
    let f = File::open(path).with_context(|| format!("open spill {}", path.display()))?;
    let r = FileReader::try_new(BufReader::new(f), None)?;
    let mut out: Vec<CruiseSpillRow> = Vec::new();
    for batch in r {
        let batch = batch?;
        let r4 = downcast::<UInt64Array>(&batch, 0)?;
        let r8 = downcast::<UInt64Array>(&batch, 1)?;
        let class = downcast::<UInt8Array>(&batch, 2)?;
        let fl_bin = downcast::<UInt8Array>(&batch, 3)?;
        let period = downcast::<UInt8Array>(&batch, 4)?;
        let rep_pi = downcast::<UInt8Array>(&batch, 5)?;
        let source_id = downcast::<UInt8Array>(&batch, 6)?;
        let origin = downcast::<UInt8Array>(&batch, 7)?;
        let sum_len = downcast::<Float32Array>(&batch, 8)?;
        let weight = downcast::<Float32Array>(&batch, 9)?;
        let rep_alt = downcast::<Float32Array>(&batch, 10)?;
        let rep_speed = downcast::<Float32Array>(&batch, 11)?;
        let rep_len = downcast::<Float32Array>(&batch, 12)?;
        let rep_len_w = downcast::<Float32Array>(&batch, 13)?;
        let fid_list = downcast::<ListArray>(&batch, 14)?;
        let tc_list = downcast::<ListArray>(&batch, 15)?;
        let cs_list = downcast::<ListArray>(&batch, 16)?;
        let fid_vals = fid_list
            .values()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| anyhow::anyhow!("spill: flight_ids inner UInt64"))?;
        let tc_vals = tc_list
            .values()
            .as_any()
            .downcast_ref::<FixedSizeBinaryArray>()
            .ok_or_else(|| anyhow::anyhow!("spill: aircraft_types inner FixedSizeBinary(4)"))?;
        let cs_vals = cs_list
            .values()
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| anyhow::anyhow!("spill: callsigns inner Utf8"))?;

        let n_rows = batch.num_rows();
        out.reserve(n_rows);
        let offsets = fid_list.value_offsets();
        for i in 0..n_rows {
            let lo = offsets[i] as usize;
            let hi = offsets[i + 1] as usize;
            let mut flight_ids = Vec::with_capacity(hi - lo);
            let mut aircraft_types = Vec::with_capacity(hi - lo);
            let mut callsigns = Vec::with_capacity(hi - lo);
            for j in lo..hi {
                flight_ids.push(fid_vals.value(j));
                let tc_bytes = tc_vals.value(j);
                let mut tc = [0u8; 4];
                tc.copy_from_slice(tc_bytes);
                aircraft_types.push(tc);
                callsigns.push(cs_vals.value(j).to_string());
            }
            out.push(CruiseSpillRow {
                r4: r4.value(i),
                r8_hex: r8.value(i),
                class: class.value(i),
                fl_bin: fl_bin.value(i),
                period: period.value(i),
                rep_profile_idx: rep_pi.value(i),
                source_id: source_id.value(i),
                origin: origin.value(i),
                sum_length_m: sum_len.value(i),
                weight: weight.value(i),
                rep_alt_m: rep_alt.value(i),
                rep_speed_kt: rep_speed.value(i),
                rep_len_m: rep_len.value(i),
                rep_len_w: rep_len_w.value(i),
                flight_ids,
                aircraft_types,
                callsigns,
            });
        }
    }
    Ok(out)
}

fn downcast<T: Array + 'static>(batch: &RecordBatch, col: usize) -> Result<&T> {
    batch
        .column(col)
        .as_any()
        .downcast_ref::<T>()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "spill: column {col} type mismatch (expected {})",
                std::any::type_name::<T>()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn row(r4: u64, n_fids: usize) -> CruiseSpillRow {
        CruiseSpillRow {
            r4,
            r8_hex: r4 + 1,
            class: 5,
            fl_bin: 3,
            period: 2,
            rep_profile_idx: 7,
            source_id: 1,
            origin: 2,
            sum_length_m: 1234.5,
            weight: 2345.6,
            rep_alt_m: 11_000.0,
            rep_speed_kt: 460.0,
            rep_len_m: 800.0,
            rep_len_w: 1234.5,
            flight_ids: (0..n_fids as u64).collect(),
            aircraft_types: (0..n_fids).map(|i| [b'A', (b'0' + (i % 10) as u8), 0, 0]).collect(),
            callsigns: (0..n_fids).map(|i| format!("CALL{i}")).collect(),
        }
    }

    #[test]
    fn write_read_roundtrip() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("test.arrow");
        let rows = vec![row(0x841e3, 3), row(0x842e3, 5)];
        write_cruise_spill(&path, &rows).unwrap();
        let back = read_cruise_spill(&path).unwrap();
        assert_eq!(back.len(), 2);
        for (a, b) in rows.iter().zip(&back) {
            assert_eq!(a.r4, b.r4);
            assert_eq!(a.r8_hex, b.r8_hex);
            assert_eq!(a.flight_ids, b.flight_ids);
            assert_eq!(a.callsigns, b.callsigns);
            assert_eq!(a.aircraft_types, b.aircraft_types);
            assert!((a.sum_length_m - b.sum_length_m).abs() < 1e-3);
        }
    }

    #[test]
    fn empty_rows_writes_valid_arrow() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("empty.arrow");
        write_cruise_spill(&path, &[]).unwrap();
        let back = read_cruise_spill(&path).unwrap();
        assert!(back.is_empty());
    }
}
