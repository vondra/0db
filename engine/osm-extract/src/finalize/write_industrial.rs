//! `industrial.arrow` writer: one row per industrial/power site footprint with
//! source type + optional hub-height/rated-power. See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use crate::spill::hex_decode;

pub(super) fn write_industrial(rows: &[Vec<String>], path: &Path) -> Result<()> {
    let n = rows.len();
    let schema = Schema::new(vec![
        Field::new("osm_id", DataType::Int64, false),
        Field::new("centroid_lat", DataType::Float64, false),
        Field::new("centroid_lon", DataType::Float64, false),
        Field::new("source_type", DataType::UInt8, false),
        Field::new("site_subtype", DataType::UInt8, false),
        Field::new("name", DataType::Utf8, true),
        Field::new("hub_height", DataType::Float32, true),
        Field::new("rated_power_kw", DataType::Float32, true),
        Field::new("polygon_wkb", DataType::Binary, true),
        Field::new("area_m2", DataType::Float32, true),
        // Dataset provenance — 0 = unspecified, populated by `enrich-industrial-*.ts`
        // scripts writing directly to this Arrow file (paired with nace_4digit below).
        Field::new("source_id", DataType::UInt16, false),
    ]);

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut stype = UInt8Builder::with_capacity(n);
    let mut subtype = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 10);
    let mut hub_h = Float32Builder::with_capacity(n);
    let mut power = Float32Builder::with_capacity(n);
    let mut wkb = BinaryBuilder::with_capacity(n, n * 100);
    let mut ind_area = Float32Builder::with_capacity(n);
    let mut source_id = UInt16Builder::with_capacity(n);

    for row in rows {
        // TSV: hex_id(0) osm_id(1) clat(2) clon(3) stype(4) subtype(5) name(6) hub_h(7) power(8) wkb(9)
        if row.len() < 9 {
            continue;
        }
        osm_id.append_value(row[1].parse().unwrap_or(0));
        clat.append_value(row[2].parse().unwrap_or(0.0));
        clon.append_value(row[3].parse().unwrap_or(0.0));
        stype.append_value(row[4].parse().unwrap_or(0));
        subtype.append_value(row[5].parse().unwrap_or(0));
        name.append_value(row.get(6).unwrap_or(&String::new()));
        let h: f32 = row.get(7).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if h > 0.0 {
            hub_h.append_value(h);
        } else {
            hub_h.append_null();
        }
        let p: f32 = row.get(8).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if p > 0.0 {
            power.append_value(p);
        } else {
            power.append_null();
        }
        if let Some(wkb_hex) = row.get(9) {
            if let Some(bytes) = hex_decode(wkb_hex) {
                if let Some(a) = noise_compute::wkb::wkb_area_m2(wkb_hex) {
                    ind_area.append_value(a as f32);
                } else {
                    ind_area.append_null();
                }
                wkb.append_value(&bytes);
            } else {
                wkb.append_null();
                ind_area.append_null();
            }
        } else {
            wkb.append_null();
            ind_area.append_null();
        }
        source_id.append_value(0);
    }

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(clat.finish()),
            Arc::new(clon.finish()),
            Arc::new(stype.finish()),
            Arc::new(subtype.finish()),
            Arc::new(name.finish()),
            Arc::new(hub_h.finish()),
            Arc::new(power.finish()),
            Arc::new(wkb.finish()),
            Arc::new(ind_area.finish()),
            Arc::new(source_id.finish()),
        ],
    )?;

    let file = File::create(path)?;
    let mut writer = FileWriter::try_new(file, &batch.schema())?;
    writer.write(&batch)?;
    writer.finish()?;
    Ok(())
}
