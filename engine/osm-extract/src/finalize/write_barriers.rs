//! `barriers.arrow` writer: one row per barrier microsegment (walls/fences/noise
//! barriers) with geometry + height + material. See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

pub(super) fn write_barriers(rows: &[Vec<String>], path: &Path) -> Result<()> {
    let n = rows.len();
    let schema = Schema::new(vec![
        Field::new("osm_id", DataType::Int64, false),
        Field::new("segment_idx", DataType::Int16, false),
        Field::new("start_lat", DataType::Float64, false),
        Field::new("start_lon", DataType::Float64, false),
        Field::new("end_lat", DataType::Float64, false),
        Field::new("end_lon", DataType::Float64, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("height", DataType::Float32, false),
        Field::new("material", DataType::UInt8, false),
    ]);

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut seg_idx = Int16Builder::with_capacity(n);
    let mut slat = Float64Builder::with_capacity(n);
    let mut slon = Float64Builder::with_capacity(n);
    let mut elat = Float64Builder::with_capacity(n);
    let mut elon = Float64Builder::with_capacity(n);
    let mut len = Float32Builder::with_capacity(n);
    let mut height = Float32Builder::with_capacity(n);
    let mut material = UInt8Builder::with_capacity(n);

    for row in rows {
        if row.len() < 10 {
            continue;
        }
        osm_id.append_value(row[1].parse().unwrap_or(0));
        seg_idx.append_value(row[2].parse().unwrap_or(0));
        slat.append_value(row[3].parse().unwrap_or(0.0));
        slon.append_value(row[4].parse().unwrap_or(0.0));
        elat.append_value(row[5].parse().unwrap_or(0.0));
        elon.append_value(row[6].parse().unwrap_or(0.0));
        len.append_value(row[7].parse().unwrap_or(0.0));
        height.append_value(row[8].parse().unwrap_or(3.0));
        material.append_value(row[9].parse().unwrap_or(0));
    }

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(seg_idx.finish()),
            Arc::new(slat.finish()),
            Arc::new(slon.finish()),
            Arc::new(elat.finish()),
            Arc::new(elon.finish()),
            Arc::new(len.finish()),
            Arc::new(height.finish()),
            Arc::new(material.finish()),
        ],
    )?;

    let file = File::create(path)?;
    let mut writer = FileWriter::try_new(file, &batch.schema())?;
    writer.write(&batch)?;
    writer.finish()?;
    Ok(())
}
