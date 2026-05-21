//! `airport_summary.arrow` — global single-row-per-airport with truly
//! unique counts UNIONed across all R4s. Produced by Stage 2C v5
//! reduce phase from per-airport per-R4 `airport_summary_parts/`
//! dumps. Loaded once at popup query time.
//!
//! `airport_summary_part.arrow` is the per-R4 intermediate carrying
//! raw fid sets that the reduce phase UNIONs to produce the global
//! `airport_summary.arrow`.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    Array, ArrayRef, FixedSizeListArray, ListArray, StringArray, StringBuilder, UInt32Array,
    UInt32Builder, UInt64Array, UInt64Builder,
};
use arrow::buffer::OffsetBuffer;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;
use crate::stage_2c::airport_traffic_writer::AirportSummaryPartRow;

use super::{read_all_batches, write_record_batches};

/// Output of Stage 2C v5 reduce phase. One row per `airport_key`
/// carrying truly unique counts across all R4s.
#[derive(Clone)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct AirportSummaryRow {
    pub airport_key: String,
    pub airport_unique_arr_count: u32,
    pub airport_unique_dep_count: u32,
    pub airport_unique_gse_count_per_class: [u32; arrow_schemas::NUM_GSE_CLASSES as usize],
    pub airport_unique_ops_count_per_kind: [u32; arrow_schemas::NUM_OPS_KINDS as usize],
}

pub fn write_airport_summary(path: &Path, rows: &[AirportSummaryRow]) -> Result<()> {
    let schema = arrow_schemas::airport_summary_schema();
    let n = rows.len();
    let mut airport_key = StringBuilder::with_capacity(n, 8 * n);
    let mut arr = UInt32Builder::with_capacity(n);
    let mut dep = UInt32Builder::with_capacity(n);
    let gse_classes = arrow_schemas::NUM_GSE_CLASSES as usize;
    let ops_kinds = arrow_schemas::NUM_OPS_KINDS as usize;
    let mut gse_values: Vec<u32> = Vec::with_capacity(n * gse_classes);
    let mut ops_values: Vec<u32> = Vec::with_capacity(n * ops_kinds);

    for r in rows {
        airport_key.append_value(&r.airport_key);
        arr.append_value(r.airport_unique_arr_count);
        dep.append_value(r.airport_unique_dep_count);
        gse_values.extend_from_slice(&r.airport_unique_gse_count_per_class);
        ops_values.extend_from_slice(&r.airport_unique_ops_count_per_kind);
    }

    let item = Arc::new(Field::new("item", DataType::UInt32, false));
    let gse_list = FixedSizeListArray::new(
        item.clone(),
        arrow_schemas::NUM_GSE_CLASSES,
        Arc::new(UInt32Array::from(gse_values)),
        None,
    );
    let ops_list = FixedSizeListArray::new(
        item,
        arrow_schemas::NUM_OPS_KINDS,
        Arc::new(UInt32Array::from(ops_values)),
        None,
    );

    let columns: Vec<ArrayRef> = vec![
        Arc::new(airport_key.finish()),
        Arc::new(arr.finish()),
        Arc::new(dep.finish()),
        Arc::new(gse_list),
        Arc::new(ops_list),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    write_record_batches(path, &schema, &[batch])
}

pub fn read_airport_summary(path: &Path) -> Result<Vec<AirportSummaryRow>> {
    let (schema, batches) = read_all_batches(path)?;
    arrow_schemas::assert_airport_summary_contract_v1(schema.metadata())?;
    let gse_classes = arrow_schemas::NUM_GSE_CLASSES as usize;
    let ops_kinds = arrow_schemas::NUM_OPS_KINDS as usize;
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let mut out = Vec::with_capacity(total_rows);
    for b in batches {
        let airport_key = column::<StringArray>(&b, "airport_key")?;
        let arr = column::<UInt32Array>(&b, "airport_unique_arr_count")?;
        let dep = column::<UInt32Array>(&b, "airport_unique_dep_count")?;
        let gse_list = column::<FixedSizeListArray>(&b, "airport_unique_gse_count_per_class")?;
        let gse_buf = gse_list
            .values()
            .as_any()
            .downcast_ref::<UInt32Array>()
            .ok_or_else(|| anyhow::anyhow!("airport_unique_gse_count_per_class inner type"))?
            .values();
        let ops_list = column::<FixedSizeListArray>(&b, "airport_unique_ops_count_per_kind")?;
        let ops_buf = ops_list
            .values()
            .as_any()
            .downcast_ref::<UInt32Array>()
            .ok_or_else(|| anyhow::anyhow!("airport_unique_ops_count_per_kind inner type"))?
            .values();
        for i in 0..b.num_rows() {
            let lo_g = i * gse_classes;
            let mut gse = [0u32; arrow_schemas::NUM_GSE_CLASSES as usize];
            gse.copy_from_slice(&gse_buf[lo_g..lo_g + gse_classes]);
            let lo_o = i * ops_kinds;
            let mut ops = [0u32; arrow_schemas::NUM_OPS_KINDS as usize];
            ops.copy_from_slice(&ops_buf[lo_o..lo_o + ops_kinds]);
            out.push(AirportSummaryRow {
                airport_key: airport_key.value(i).to_string(),
                airport_unique_arr_count: arr.value(i),
                airport_unique_dep_count: dep.value(i),
                airport_unique_gse_count_per_class: gse,
                airport_unique_ops_count_per_kind: ops,
            });
        }
    }
    Ok(out)
}

fn column<'a, T: arrow::array::Array + 'static>(
    batch: &'a RecordBatch,
    name: &str,
) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .ok_or_else(|| anyhow::anyhow!("missing column {name}"))?
        .as_any()
        .downcast_ref::<T>()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "column {name} type mismatch (expected {})",
                std::any::type_name::<T>()
            )
        })
}

// ─── airport_summary_part: per-airport per-R4 raw fid sets for reduce ───

/// Schema for `airport_summary_parts/<r4>/part.arrow`. One row per
/// airport_key carrying raw List<UInt64> fid sets per dimension.
/// Stage 2C v5 reduce loops every R4 part for one airport, UNIONs
/// the HashSets, and counts to produce the global summary row.
fn part_schema() -> Arc<Schema> {
    let u64_list = DataType::List(Arc::new(Field::new("item", DataType::UInt64, false)));
    let fixed_list_of_list = DataType::FixedSizeList(
        Arc::new(Field::new("item", u64_list.clone(), false)),
        arrow_schemas::NUM_GSE_CLASSES,
    );
    let fixed_list_of_list_ops = DataType::FixedSizeList(
        Arc::new(Field::new("item", u64_list.clone(), false)),
        arrow_schemas::NUM_OPS_KINDS,
    );
    Arc::new(Schema::new(vec![
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("arr_fids", u64_list.clone(), false),
        Field::new("dep_fids", u64_list.clone(), false),
        Field::new("gse_fids_per_class", fixed_list_of_list, false),
        Field::new("ops_fids_per_kind", fixed_list_of_list_ops, false),
    ]))
}

pub(crate) fn write_airport_summary_part(
    path: &Path,
    rows: &[AirportSummaryPartRow],
) -> Result<()> {
    let schema = part_schema();
    let n = rows.len();
    let mut airport_key = StringBuilder::with_capacity(n, 8 * n);
    // arr/dep: List<UInt64> with one offsets buffer + flat values.
    let mut arr_off: Vec<i32> = Vec::with_capacity(n + 1);
    arr_off.push(0);
    let mut arr_vals = UInt64Builder::new();
    let mut dep_off: Vec<i32> = Vec::with_capacity(n + 1);
    dep_off.push(0);
    let mut dep_vals = UInt64Builder::new();
    let mut running_arr = 0usize;
    let mut running_dep = 0usize;
    let gse_classes = arrow_schemas::NUM_GSE_CLASSES as usize;
    let ops_kinds = arrow_schemas::NUM_OPS_KINDS as usize;
    // gse_fids_per_class: FixedSizeList<List<UInt64>, NUM_GSE_CLASSES>.
    // Encoded as: inner List<UInt64> values + offsets across n * GSE
    // elements. Same shape for ops_fids_per_kind.
    let mut gse_inner_off: Vec<i32> = Vec::with_capacity(n * gse_classes + 1);
    gse_inner_off.push(0);
    let mut gse_inner_vals = UInt64Builder::new();
    let mut running_gse = 0usize;
    let mut ops_inner_off: Vec<i32> = Vec::with_capacity(n * ops_kinds + 1);
    ops_inner_off.push(0);
    let mut ops_inner_vals = UInt64Builder::new();
    let mut running_ops = 0usize;

    for r in rows {
        airport_key.append_value(&r.airport_key);
        for &fid in &r.arr_fids {
            arr_vals.append_value(fid);
        }
        running_arr += r.arr_fids.len();
        arr_off.push(running_arr as i32);
        for &fid in &r.dep_fids {
            dep_vals.append_value(fid);
        }
        running_dep += r.dep_fids.len();
        dep_off.push(running_dep as i32);
        for v in &r.gse_fids_per_class {
            for &fid in v {
                gse_inner_vals.append_value(fid);
            }
            running_gse += v.len();
            gse_inner_off.push(running_gse as i32);
        }
        for v in &r.ops_fids_per_kind {
            for &fid in v {
                ops_inner_vals.append_value(fid);
            }
            running_ops += v.len();
            ops_inner_off.push(running_ops as i32);
        }
    }

    let u64_item = Arc::new(Field::new("item", DataType::UInt64, false));
    let arr_list = ListArray::new(
        u64_item.clone(),
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(arr_off)),
        Arc::new(arr_vals.finish()),
        None,
    );
    let dep_list = ListArray::new(
        u64_item.clone(),
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(dep_off)),
        Arc::new(dep_vals.finish()),
        None,
    );
    let gse_inner_list = ListArray::new(
        u64_item.clone(),
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(gse_inner_off)),
        Arc::new(gse_inner_vals.finish()),
        None,
    );
    let gse_outer_field = Arc::new(Field::new(
        "item",
        DataType::List(u64_item.clone()),
        false,
    ));
    let gse_list = FixedSizeListArray::new(
        gse_outer_field,
        arrow_schemas::NUM_GSE_CLASSES,
        Arc::new(gse_inner_list),
        None,
    );
    let ops_inner_list = ListArray::new(
        u64_item.clone(),
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(ops_inner_off)),
        Arc::new(ops_inner_vals.finish()),
        None,
    );
    let ops_outer_field = Arc::new(Field::new("item", DataType::List(u64_item), false));
    let ops_list = FixedSizeListArray::new(
        ops_outer_field,
        arrow_schemas::NUM_OPS_KINDS,
        Arc::new(ops_inner_list),
        None,
    );

    let columns: Vec<ArrayRef> = vec![
        Arc::new(airport_key.finish()),
        Arc::new(arr_list),
        Arc::new(dep_list),
        Arc::new(gse_list),
        Arc::new(ops_list),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // No schema-version stamp on parts — they're intra-process scratch
    // (analogous to `cruise_spill.rs`). Bypass the version-asserting
    // `write_record_batches` to avoid needing the
    // arrow_schemas::base_metadata header.
    use arrow::ipc::writer::FileWriter;
    use std::fs::File;
    use std::io::BufWriter;
    let f = File::create(path)?;
    let mut w = FileWriter::try_new(BufWriter::new(f), &schema)?;
    if batch.num_rows() > 0 {
        w.write(&batch)?;
    }
    w.finish()?;
    Ok(())
}

/// Reader half is consumed by the Stage 2C v5 reduce phase (next
/// implementation step). Kept here in lockstep with the writer so the
/// round-trip test catches schema drift early.
#[allow(dead_code)]
pub(crate) fn read_airport_summary_part(path: &Path) -> Result<Vec<AirportSummaryPartRow>> {
    use arrow::ipc::reader::FileReader;
    use std::fs::File;
    use std::io::BufReader;
    let f = File::open(path)?;
    let r = FileReader::try_new(BufReader::new(f), None)?;
    let gse_classes = arrow_schemas::NUM_GSE_CLASSES as usize;
    let ops_kinds = arrow_schemas::NUM_OPS_KINDS as usize;
    let mut out = Vec::new();
    for batch in r {
        let batch = batch?;
        let airport_key = column::<StringArray>(&batch, "airport_key")?;
        let arr_list = column::<ListArray>(&batch, "arr_fids")?;
        let dep_list = column::<ListArray>(&batch, "dep_fids")?;
        let gse_outer = column::<FixedSizeListArray>(&batch, "gse_fids_per_class")?;
        let ops_outer = column::<FixedSizeListArray>(&batch, "ops_fids_per_kind")?;

        let arr_vals = arr_list
            .values()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| anyhow::anyhow!("arr_fids inner type"))?;
        let dep_vals = dep_list
            .values()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| anyhow::anyhow!("dep_fids inner type"))?;
        let gse_inner_list = gse_outer
            .values()
            .as_any()
            .downcast_ref::<ListArray>()
            .ok_or_else(|| anyhow::anyhow!("gse_fids inner List"))?;
        let gse_inner_vals = gse_inner_list
            .values()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| anyhow::anyhow!("gse_fids inner UInt64"))?;
        let ops_inner_list = ops_outer
            .values()
            .as_any()
            .downcast_ref::<ListArray>()
            .ok_or_else(|| anyhow::anyhow!("ops_fids inner List"))?;
        let ops_inner_vals = ops_inner_list
            .values()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| anyhow::anyhow!("ops_fids inner UInt64"))?;

        let arr_off = arr_list.value_offsets();
        let dep_off = dep_list.value_offsets();
        let gse_inner_off = gse_inner_list.value_offsets();
        let ops_inner_off = ops_inner_list.value_offsets();

        for i in 0..batch.num_rows() {
            let a_lo = arr_off[i] as usize;
            let a_hi = arr_off[i + 1] as usize;
            let arr_fids: Vec<u64> = arr_vals.values()[a_lo..a_hi].to_vec();
            let d_lo = dep_off[i] as usize;
            let d_hi = dep_off[i + 1] as usize;
            let dep_fids: Vec<u64> = dep_vals.values()[d_lo..d_hi].to_vec();
            let gse_fids_per_class: [Vec<u64>; arrow_schemas::NUM_GSE_CLASSES as usize] =
                std::array::from_fn(|k| {
                    let outer_idx = i * gse_classes + k;
                    let lo = gse_inner_off[outer_idx] as usize;
                    let hi = gse_inner_off[outer_idx + 1] as usize;
                    gse_inner_vals.values()[lo..hi].to_vec()
                });
            let ops_fids_per_kind: [Vec<u64>; arrow_schemas::NUM_OPS_KINDS as usize] =
                std::array::from_fn(|k| {
                    let outer_idx = i * ops_kinds + k;
                    let lo = ops_inner_off[outer_idx] as usize;
                    let hi = ops_inner_off[outer_idx + 1] as usize;
                    ops_inner_vals.values()[lo..hi].to_vec()
                });
            out.push(AirportSummaryPartRow {
                airport_key: airport_key.value(i).to_string(),
                arr_fids,
                dep_fids,
                gse_fids_per_class,
                ops_fids_per_kind,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_row() -> AirportSummaryRow {
        AirportSummaryRow {
            airport_key: "LKPR".into(),
            airport_unique_arr_count: 100,
            airport_unique_dep_count: 105,
            airport_unique_gse_count_per_class: [12, 34, 56],
            airport_unique_ops_count_per_kind: [205, 1100, 800],
        }
    }

    #[test]
    fn airport_summary_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("airport_summary.arrow");
        let rows = vec![sample_row()];
        write_airport_summary(&path, &rows).unwrap();
        let read = read_airport_summary(&path).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0], rows[0]);
    }

    #[test]
    fn airport_summary_part_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("part.arrow");
        let rows = vec![
            AirportSummaryPartRow {
                airport_key: "LKPR".into(),
                arr_fids: vec![1, 2, 3],
                dep_fids: vec![4, 5],
                gse_fids_per_class: [vec![10, 11], vec![], vec![20]],
                ops_fids_per_kind: [vec![1, 2, 3], vec![1, 2, 3, 4], vec![]],
            },
            AirportSummaryPartRow {
                airport_key: "LKKB".into(),
                arr_fids: vec![100],
                dep_fids: vec![],
                gse_fids_per_class: [vec![], vec![], vec![]],
                ops_fids_per_kind: [vec![100], vec![], vec![]],
            },
        ];
        write_airport_summary_part(&path, &rows).unwrap();
        let read = read_airport_summary_part(&path).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].airport_key, rows[0].airport_key);
        assert_eq!(read[0].arr_fids, rows[0].arr_fids);
        assert_eq!(read[0].dep_fids, rows[0].dep_fids);
        for c in 0..arrow_schemas::NUM_GSE_CLASSES as usize {
            assert_eq!(
                read[0].gse_fids_per_class[c], rows[0].gse_fids_per_class[c],
                "gse[{c}]"
            );
        }
        for k in 0..arrow_schemas::NUM_OPS_KINDS as usize {
            assert_eq!(
                read[0].ops_fids_per_kind[k], rows[0].ops_fids_per_kind[k],
                "ops[{k}]"
            );
        }
        assert_eq!(read[1].airport_key, rows[1].airport_key);
        assert_eq!(read[1].arr_fids, rows[1].arr_fids);
    }
}
