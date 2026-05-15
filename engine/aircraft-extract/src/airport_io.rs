//! Read OSM-derived `airport_areas.arrow` files prepared by
//! `osm-extract`. Stage 2C aggregates them across every per-R4 prepared
//! dir so the nearest-aerodrome identity lookup sees a global airport
//! set even when an airport's polygon is split across R4 boundaries.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::Result;
use arrow::array::{
    Array, BinaryArray, Float32Array, Float64Array, Int16Array, Int64Array, StringArray,
    UInt8Array,
};
use arrow::ipc::reader::FileReader;
use arrow::record_batch::RecordBatch;
use noise_compute::types::AirportArea;

const AERODROME_AEROWAY_TYPE: u8 = 5;

fn read_batches(path: &Path) -> Result<Vec<RecordBatch>> {
    let f = File::open(path)?;
    let r = FileReader::try_new(BufReader::new(f), None)?;
    let mut out = Vec::new();
    for b in r {
        out.push(b?);
    }
    Ok(out)
}

fn col_str<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a StringArray> {
    batch.column_by_name(name)?.as_any().downcast_ref::<StringArray>()
}
fn col_i64<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Int64Array> {
    batch.column_by_name(name)?.as_any().downcast_ref::<Int64Array>()
}
fn col_f64<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Float64Array> {
    batch.column_by_name(name)?.as_any().downcast_ref::<Float64Array>()
}
fn col_f32<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Float32Array> {
    batch.column_by_name(name)?.as_any().downcast_ref::<Float32Array>()
}
fn col_u8<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a UInt8Array> {
    batch.column_by_name(name)?.as_any().downcast_ref::<UInt8Array>()
}
fn col_i16<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Int16Array> {
    batch.column_by_name(name)?.as_any().downcast_ref::<Int16Array>()
}
fn col_binary<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a BinaryArray> {
    batch.column_by_name(name)?.as_any().downcast_ref::<BinaryArray>()
}

fn airport_key(name: &str, icao: &str, iata: &str) -> String {
    let key = if !icao.is_empty() {
        icao
    } else if !iata.is_empty() {
        iata
    } else {
        name
    };
    key.trim().to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02X}", b));
    }
    s
}

pub fn read_airport_areas(path: &Path) -> Result<Vec<AirportArea>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let batches = read_batches(path)?;
    let mut out = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(&batch, "osm_id");
        let clat = col_f64(&batch, "centroid_lat");
        let clon = col_f64(&batch, "centroid_lon");
        let aeroway_type = col_u8(&batch, "aeroway_type");
        let name = col_str(&batch, "name");
        let icao = col_str(&batch, "icao");
        let iata = col_str(&batch, "iata");
        let wkb = col_binary(&batch, "polygon_wkb");
        let area_m2 = col_f32(&batch, "area_m2");

        let (Some(osm_id), Some(clat), Some(clon)) = (osm_id, clat, clon) else {
            continue;
        };

        for i in 0..n {
            out.push(AirportArea::new(
                osm_id.value(i),
                aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_key(
                    name.map(|a| a.value(i)).unwrap_or(""),
                    icao.map(|a| a.value(i)).unwrap_or(""),
                    iata.map(|a| a.value(i)).unwrap_or(""),
                ),
                clat.value(i),
                clon.value(i),
                wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default(),
                area_m2.map(|a| a.value(i)).unwrap_or(0.0),
            ));
        }
    }
    Ok(out)
}

/// Read `airport_lines.arrow` per-R4 microsegment table. Phase 3d
/// aggregator consumes this to project ADS-B legs onto OSM aeroway
/// microsegments. `aeroway_type` (0=runway, 1=taxiway, 6=stopway,
/// 7=airstrip) is preserved so Phase 3d can derive ops_kind without
/// re-classifying from speed alone.
pub struct AirportLineRow {
    pub osm_id: u64,
    pub segment_idx: u16,
    pub start_lat: f32,
    pub start_lon: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    pub length_m: f32,
    pub aeroway_type: u8,
}

pub fn read_airport_lines(path: &Path) -> Result<Vec<AirportLineRow>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let batches = read_batches(path)?;
    let mut out = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let (Some(osm_id), Some(seg_idx), Some(sla), Some(slo), Some(ela), Some(elo), Some(len)) = (
            col_i64(&batch, "osm_id"),
            col_i16(&batch, "segment_idx"),
            col_f64(&batch, "start_lat"),
            col_f64(&batch, "start_lon"),
            col_f64(&batch, "end_lat"),
            col_f64(&batch, "end_lon"),
            col_f32(&batch, "length_m"),
        ) else {
            continue;
        };
        let atype = col_u8(&batch, "aeroway_type");
        for i in 0..n {
            out.push(AirportLineRow {
                osm_id: osm_id.value(i) as u64,
                segment_idx: seg_idx.value(i).max(0) as u16,
                start_lat: sla.value(i) as f32,
                start_lon: slo.value(i) as f32,
                end_lat: ela.value(i) as f32,
                end_lon: elo.value(i) as f32,
                length_m: len.value(i),
                aeroway_type: atype.map(|a| a.value(i)).unwrap_or(255),
            });
        }
    }
    Ok(out)
}

/// Walk every `<h3r4_dir>/<R4>/airport_areas.arrow` and merge into a
/// single global set, filtered to `aeroway_type == AERODROME` so the
/// nearest-aerodrome lookup never picks up a stand-alone apron / taxi
/// polygon as an airport identity. Returns the deduped polygon list.
pub fn read_global_airports(h3r4_dir: &Path) -> Result<Vec<AirportArea>> {
    let mut areas = Vec::new();
    if !h3r4_dir.exists() {
        return Ok(areas);
    }
    for entry in std::fs::read_dir(h3r4_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        for area in read_airport_areas(&path.join("airport_areas.arrow"))? {
            if area.aeroway_type == AERODROME_AEROWAY_TYPE {
                areas.push(area);
            }
        }
    }
    Ok(areas)
}
