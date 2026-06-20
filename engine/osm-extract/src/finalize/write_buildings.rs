//! `buildings.arrow` writer (settlement v2 phase 2): one row per building
//! footprint with the POI-footprint join applied and area pre-computed from WKB.
//! Stamps the `buildings_v2` per-file contract. See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use super::{schema_with_contract, BUILDINGS_CONTRACT_V2};
use crate::poi_join::{joined_building_type, JoinStats, PoiIndex};
use crate::spill::hex_decode;

pub(super) fn write_buildings(
    rows: &[Vec<String>],
    path: &Path,
    hex: u64,
    poi_index: &PoiIndex,
    join_stats: &JoinStats,
) -> Result<()> {
    let n = rows.len();
    let schema = schema_with_contract(
        vec![
            Field::new("osm_id", DataType::Int64, false),
            Field::new("centroid_lat", DataType::Float64, false),
            Field::new("centroid_lon", DataType::Float64, false),
            Field::new("building_type", DataType::UInt8, false),
            Field::new("building_use", DataType::UInt8, false),
            Field::new("height", DataType::Float32, true),
            Field::new("floors", DataType::UInt8, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("addr_street", DataType::Utf8, true),
            Field::new("addr_housenumber", DataType::Utf8, true),
            Field::new("polygon_wkb", DataType::Binary, true),
            // area_m2: pre-computed from WKB polygon with cos(lat) Shoelace.
            // WHY: Runtime WKB decode is slow; pre-compute once at extract time.
            Field::new("area_m2", DataType::Float32, true),
            // Dataset provenance — 0 = unspecified, populated by enrich-buildings-*.ts.
            Field::new("source_id", DataType::UInt16, false),
            // settlement v2 phase 2: opening_hours day-fraction
            // (0=unknown,1=24/7,2=day,3=evening/night). See
            // classify::opening_hours_fraction.
            Field::new("opening_hours_frac", DataType::UInt8, false),
        ],
        "buildings_contract",
        BUILDINGS_CONTRACT_V2,
    );

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut btype = UInt8Builder::with_capacity(n);
    let mut buse = UInt8Builder::with_capacity(n);
    let mut height = Float32Builder::with_capacity(n);
    let mut floors = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 8);
    let mut street = StringBuilder::with_capacity(n, n * 12);
    let mut housenumber = StringBuilder::with_capacity(n, n * 4);
    let mut area_m2 = Float32Builder::with_capacity(n);
    let mut source_id = UInt16Builder::with_capacity(n);
    let mut wkb = BinaryBuilder::with_capacity(n, n * 100);
    let mut opening = UInt8Builder::with_capacity(n);

    for row in rows {
        // TSV: hex_id(0) osm_id(1) clat(2) clon(3) btype(4) buse(5) height(6) floors(7)
        //      name(8) street(9) housenumber(10) opening_hours(11) wkb_hex(12)
        // Require the full v2 layout (13 fields incl. the always-present trailing
        // WKB) so a stale v1 spill row (12 fields, WKB at 11) can't be misparsed
        // as opening_hours and still stamped buildings_v2 (Codex finalize-only note).
        if row.len() < 13 {
            continue;
        }
        let wkb_hex = row.get(12).map(|s| s.as_str()).unwrap_or("");
        // POI footprint join (settlement v2 phase 2): reclassify `building=yes`
        // when a function POI sits inside it.
        let bt = joined_building_type(
            row[4].parse().unwrap_or(0),
            wkb_hex,
            hex,
            poi_index,
            join_stats,
        );
        osm_id.append_value(row[1].parse().unwrap_or(0));
        clat.append_value(row[2].parse().unwrap_or(0.0));
        clon.append_value(row[3].parse().unwrap_or(0.0));
        btype.append_value(bt);
        buse.append_value(row[5].parse().unwrap_or(0));
        let h: f32 = row[6].parse().unwrap_or(0.0);
        if h > 0.0 {
            height.append_value(h);
        } else {
            height.append_null();
        }
        floors.append_value(row[7].parse().unwrap_or(0));
        name.append_value(row.get(8).unwrap_or(&String::new()));
        street.append_value(row.get(9).unwrap_or(&String::new()));
        housenumber.append_value(row.get(10).unwrap_or(&String::new()));
        opening.append_value(row[11].parse().unwrap_or(0));
        if !wkb_hex.is_empty() {
            if let Some(bytes) = hex_decode(wkb_hex) {
                // Compute area from WKB before storing
                if let Some(a) = noise_compute::wkb::wkb_area_m2(wkb_hex) {
                    area_m2.append_value(a as f32);
                } else {
                    area_m2.append_null();
                }
                wkb.append_value(&bytes);
            } else {
                wkb.append_null();
                area_m2.append_null();
            }
        } else {
            wkb.append_null();
            area_m2.append_null();
        }
        source_id.append_value(0);
    }

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(clat.finish()),
            Arc::new(clon.finish()),
            Arc::new(btype.finish()),
            Arc::new(buse.finish()),
            Arc::new(height.finish()),
            Arc::new(floors.finish()),
            Arc::new(name.finish()),
            Arc::new(street.finish()),
            Arc::new(housenumber.finish()),
            Arc::new(wkb.finish()),
            Arc::new(area_m2.finish()),
            Arc::new(source_id.finish()),
            Arc::new(opening.finish()),
        ],
    )?;

    let file = File::create(path)?;
    let mut writer = FileWriter::try_new(file, &batch.schema())?;
    writer.write(&batch)?;
    writer.finish()?;
    Ok(())
}
