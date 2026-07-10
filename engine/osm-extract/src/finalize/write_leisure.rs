//! `leisure.arrow` writer (settlement v2 phase 2). Its own v1 per-file contract —
//! a NEW file, never confused with buildings. See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use std::path::Path;
use std::sync::Arc;

use super::{
    polygon_row_bbox, schema_with_contract, write_arrow_spatially_batched, LEISURE_CONTRACT_V1,
};
use crate::spill::hex_decode;

/// `leisure.arrow` (settlement v2 phase 2): one row per leisure AREA source
/// (sports pitch / playground / pool / beer garden). Geometry + `sport` class
/// drive the emission; `prepare_leisure_points` now scales on `area_m2` alone.
/// Its own v1 contract — a NEW file, never confused with buildings.
pub(super) fn write_leisure(rows: &[Vec<String>], path: &Path) -> Result<()> {
    let n = rows.len();
    let schema = schema_with_contract(
        vec![
            Field::new("osm_id", DataType::Int64, false),
            Field::new("centroid_lat", DataType::Float64, false),
            Field::new("centroid_lon", DataType::Float64, false),
            // emission::leisure class id (PITCH/PADEL/…).
            Field::new("sport", DataType::UInt8, false),
            // Vestigial: still populated from the TSV (`parse_capacity`) but no
            // longer read — the area-law unification dropped capacity scaling.
            // Kept only to hold LEISURE_CONTRACT_V1; drop on the next contract
            // bump + world re-extract.
            Field::new("capacity", DataType::UInt32, false),
            Field::new("opening_hours_frac", DataType::UInt8, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("polygon_wkb", DataType::Binary, true),
            Field::new("area_m2", DataType::Float32, true),
        ],
        "leisure_contract",
        LEISURE_CONTRACT_V1,
    );

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut sport = UInt8Builder::with_capacity(n);
    let mut capacity = UInt32Builder::with_capacity(n);
    let mut opening = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 8);
    let mut wkb = BinaryBuilder::with_capacity(n, n * 100);
    let mut area_m2 = Float32Builder::with_capacity(n);
    let mut row_bboxes = Vec::with_capacity(n);

    for row in rows {
        // TSV: hex_id(0) osm_id(1) clat(2) clon(3) sport(4) capacity(5)
        //      opening_hours(6) name(7) wkb_hex(8)
        if row.len() < 8 {
            continue;
        }
        let c_lat: f64 = row[2].parse().unwrap_or(0.0);
        let c_lon: f64 = row[3].parse().unwrap_or(0.0);
        row_bboxes.push(polygon_row_bbox(
            row.get(8).map(|s| s.as_str()).unwrap_or(""),
            c_lat,
            c_lon,
        ));
        osm_id.append_value(row[1].parse().unwrap_or(0));
        clat.append_value(c_lat);
        clon.append_value(c_lon);
        sport.append_value(row[4].parse().unwrap_or(0));
        // capacity is empty-or-number in the TSV.
        capacity.append_value(row.get(5).and_then(|s| s.parse().ok()).unwrap_or(0));
        opening.append_value(row.get(6).and_then(|s| s.parse().ok()).unwrap_or(0));
        name.append_value(row.get(7).unwrap_or(&String::new()));
        if let Some(wkb_hex) = row.get(8).filter(|s| !s.is_empty()) {
            if let Some(bytes) = hex_decode(wkb_hex) {
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
    }

    write_arrow_spatially_batched(
        path,
        schema,
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(clat.finish()),
            Arc::new(clon.finish()),
            Arc::new(sport.finish()),
            Arc::new(capacity.finish()),
            Arc::new(opening.finish()),
            Arc::new(name.finish()),
            Arc::new(wkb.finish()),
            Arc::new(area_m2.finish()),
        ],
        &row_bboxes,
    )
}
