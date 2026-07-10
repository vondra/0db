//! Airport aeroway writers: `airport_areas.arrow` (polygon aprons/runways with
//! identity tags) and `airport_lines.arrow` (≤250m runway/taxiway microsegments).
//! See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use std::path::Path;
use std::sync::Arc;

use super::{polygon_row_bbox, segment_row_bbox, write_arrow_spatially_batched};
use crate::spill::hex_decode;

pub(super) fn write_airport_areas(rows: &[Vec<String>], path: &Path) -> Result<()> {
    let n = rows.len();
    let schema = Schema::new(vec![
        Field::new("osm_id", DataType::Int64, false),
        Field::new("centroid_lat", DataType::Float64, false),
        Field::new("centroid_lon", DataType::Float64, false),
        Field::new("aeroway_type", DataType::UInt8, false),
        Field::new("name", DataType::Utf8, true),
        Field::new("ref", DataType::Utf8, true),
        Field::new("icao", DataType::Utf8, true),
        Field::new("iata", DataType::Utf8, true),
        Field::new("operator", DataType::Utf8, true),
        Field::new("surface", DataType::Utf8, true),
        Field::new("width_m", DataType::Float32, true),
        Field::new("aerodrome_type", DataType::Utf8, true),
        Field::new("access", DataType::Utf8, true),
        Field::new("polygon_wkb", DataType::Binary, true),
        Field::new("area_m2", DataType::Float32, true),
    ]);

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut aeroway_type = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 10);
    let mut ref_col = StringBuilder::with_capacity(n, n * 6);
    let mut icao = StringBuilder::with_capacity(n, n * 4);
    let mut iata = StringBuilder::with_capacity(n, n * 4);
    let mut operator = StringBuilder::with_capacity(n, n * 10);
    let mut surface = StringBuilder::with_capacity(n, n * 8);
    let mut width_m = Float32Builder::with_capacity(n);
    let mut aerodrome_type = StringBuilder::with_capacity(n, n * 8);
    let mut access = StringBuilder::with_capacity(n, n * 8);
    let mut wkb = BinaryBuilder::with_capacity(n, n * 100);
    let mut area_m2 = Float32Builder::with_capacity(n);
    let mut row_bboxes = Vec::with_capacity(n);

    for row in rows {
        // TSV: hex_id(0) osm_id(1) clat(2) clon(3) aeroway_type(4) name(5) ref(6) icao(7)
        //      iata(8) operator(9) surface(10) width_m(11) aerodrome_type(12) access(13) wkb(14)
        if row.len() < 14 {
            continue;
        }
        let c_lat: f64 = row[2].parse().unwrap_or(0.0);
        let c_lon: f64 = row[3].parse().unwrap_or(0.0);
        row_bboxes.push(polygon_row_bbox(
            row.get(14).map(|s| s.as_str()).unwrap_or(""),
            c_lat,
            c_lon,
        ));
        osm_id.append_value(row[1].parse().unwrap_or(0));
        clat.append_value(c_lat);
        clon.append_value(c_lon);
        aeroway_type.append_value(row[4].parse().unwrap_or(255));
        name.append_value(row.get(5).map(|s| s.as_str()).unwrap_or(""));
        ref_col.append_value(row.get(6).map(|s| s.as_str()).unwrap_or(""));
        icao.append_value(row.get(7).map(|s| s.as_str()).unwrap_or(""));
        iata.append_value(row.get(8).map(|s| s.as_str()).unwrap_or(""));
        operator.append_value(row.get(9).map(|s| s.as_str()).unwrap_or(""));
        surface.append_value(row.get(10).map(|s| s.as_str()).unwrap_or(""));
        let width: f32 = row.get(11).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if width > 0.0 {
            width_m.append_value(width);
        } else {
            width_m.append_null();
        }
        aerodrome_type.append_value(row.get(12).map(|s| s.as_str()).unwrap_or(""));
        access.append_value(row.get(13).map(|s| s.as_str()).unwrap_or(""));
        if let Some(wkb_hex) = row.get(14) {
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
            Arc::new(aeroway_type.finish()),
            Arc::new(name.finish()),
            Arc::new(ref_col.finish()),
            Arc::new(icao.finish()),
            Arc::new(iata.finish()),
            Arc::new(operator.finish()),
            Arc::new(surface.finish()),
            Arc::new(width_m.finish()),
            Arc::new(aerodrome_type.finish()),
            Arc::new(access.finish()),
            Arc::new(wkb.finish()),
            Arc::new(area_m2.finish()),
        ],
        &row_bboxes,
    )
}

/// `airport_lines.arrow`: one row per ≤250m microsegment of OSM aeroway
/// runway/taxiway/stopway/airstrip lines. Geometry-only — airport identity
/// is computed downstream by aircraft-extract Stage 2C via the existing
/// `nearest_aerodrome_within` snap (area-aware radius with 3km LKPR floor).
/// Closed-ring runway ways are rerouted to airport_areas; multipolygon
/// members are skipped (relation handler already produces the area).
pub(super) fn write_airport_lines(rows: &[Vec<String>], path: &Path) -> Result<()> {
    let n = rows.len();
    let schema = Schema::new(vec![
        Field::new("osm_id", DataType::Int64, false),
        Field::new("segment_idx", DataType::Int16, false),
        Field::new("start_lat", DataType::Float64, false),
        Field::new("start_lon", DataType::Float64, false),
        Field::new("end_lat", DataType::Float64, false),
        Field::new("end_lon", DataType::Float64, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("heading_deg", DataType::Float32, false),
        // 0=runway, 1=taxiway, 6=stopway, 7=airstrip
        // (matches airport_areas.arrow convention)
        Field::new("aeroway_type", DataType::UInt8, false),
        Field::new("ref", DataType::Utf8, true),
        Field::new("surface", DataType::Utf8, true),
        Field::new("width_m", DataType::Float32, true),
    ]);

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut seg_idx = Int16Builder::with_capacity(n);
    let mut slat = Float64Builder::with_capacity(n);
    let mut slon = Float64Builder::with_capacity(n);
    let mut elat = Float64Builder::with_capacity(n);
    let mut elon = Float64Builder::with_capacity(n);
    let mut len = Float32Builder::with_capacity(n);
    let mut heading = Float32Builder::with_capacity(n);
    let mut atype = UInt8Builder::with_capacity(n);
    let mut ref_col = StringBuilder::with_capacity(n, n * 4);
    let mut surface = StringBuilder::with_capacity(n, n * 8);
    let mut width_m = Float32Builder::with_capacity(n);
    let mut row_bboxes = Vec::with_capacity(n);

    for row in rows {
        // TSV: hex_id(0) osm_id(1) seg_idx(2) slat(3) slon(4) elat(5) elon(6)
        //      len(7) heading(8) aeroway_type(9) ref(10) surface(11) width(12)
        if row.len() < 12 {
            continue;
        }
        let s_lat: f64 = row[3].parse().unwrap_or(0.0);
        let s_lon: f64 = row[4].parse().unwrap_or(0.0);
        let e_lat: f64 = row[5].parse().unwrap_or(0.0);
        let e_lon: f64 = row[6].parse().unwrap_or(0.0);
        row_bboxes.push(segment_row_bbox(s_lat, s_lon, e_lat, e_lon));
        osm_id.append_value(row[1].parse().unwrap_or(0));
        seg_idx.append_value(row[2].parse().unwrap_or(0));
        slat.append_value(s_lat);
        slon.append_value(s_lon);
        elat.append_value(e_lat);
        elon.append_value(e_lon);
        len.append_value(row[7].parse().unwrap_or(0.0));
        heading.append_value(row[8].parse().unwrap_or(0.0));
        // 255 = "other" sentinel matching airport_areas convention
        // (see classify::aeroway_type docstring).
        atype.append_value(row[9].parse().unwrap_or(255));
        // Nullable Utf8 columns: emit null for empty, not "".
        match row.get(10).map(|s| s.as_str()).filter(|s| !s.is_empty()) {
            Some(v) => ref_col.append_value(v),
            None => ref_col.append_null(),
        }
        match row.get(11).map(|s| s.as_str()).filter(|s| !s.is_empty()) {
            Some(v) => surface.append_value(v),
            None => surface.append_null(),
        }
        match row
            .get(12)
            .and_then(|s| if s.is_empty() { None } else { s.parse().ok() })
        {
            Some(v) => width_m.append_value(v),
            None => width_m.append_null(),
        }
    }

    write_arrow_spatially_batched(
        path,
        schema,
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(seg_idx.finish()),
            Arc::new(slat.finish()),
            Arc::new(slon.finish()),
            Arc::new(elat.finish()),
            Arc::new(elon.finish()),
            Arc::new(len.finish()),
            Arc::new(heading.finish()),
            Arc::new(atype.finish()),
            Arc::new(ref_col.finish()),
            Arc::new(surface.finish()),
            Arc::new(width_m.finish()),
        ],
        &row_bboxes,
    )
}
