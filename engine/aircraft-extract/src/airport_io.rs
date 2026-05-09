//! Read OSM-derived airport_lines.arrow / airport_areas.arrow files
//! prepared by `osm-extract`. Stage 2C aggregates them across every
//! per-R4 prepared dir so coverage / synth see a global airport set;
//! the partitioning back onto per-R4 ground.arrow happens after
//! bucketing.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::Result;
use arrow::array::{
    Array, BinaryArray, Float32Array, Float64Array, Int64Array, StringArray, UInt8Array,
};
use arrow::ipc::reader::FileReader;
use arrow::record_batch::RecordBatch;
use noise_compute::types::{AirportArea, AirportLine};

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

pub fn read_airport_lines(path: &Path) -> Result<Vec<AirportLine>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let batches = read_batches(path)?;
    let mut out = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(&batch, "osm_id");
        let slat = col_f64(&batch, "start_lat");
        let slon = col_f64(&batch, "start_lon");
        let elat = col_f64(&batch, "end_lat");
        let elon = col_f64(&batch, "end_lon");
        let aeroway_type = col_u8(&batch, "aeroway_type");
        let width_m = col_f32(&batch, "width_m");
        let name = col_str(&batch, "name");
        let icao = col_str(&batch, "icao");
        let iata = col_str(&batch, "iata");

        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            out.push(AirportLine {
                osm_id: osm_id.value(i),
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_key: airport_key(
                    name.map(|a| a.value(i)).unwrap_or(""),
                    icao.map(|a| a.value(i)).unwrap_or(""),
                    iata.map(|a| a.value(i)).unwrap_or(""),
                ),
                start_lat: slat.value(i),
                start_lon: slon.value(i),
                end_lat: elat.value(i),
                end_lon: elon.value(i),
                width_m: width_m.map(|a| a.value(i)).unwrap_or(0.0),
            });
        }
    }
    Ok(out)
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
            out.push(AirportArea {
                osm_id: osm_id.value(i),
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_key: airport_key(
                    name.map(|a| a.value(i)).unwrap_or(""),
                    icao.map(|a| a.value(i)).unwrap_or(""),
                    iata.map(|a| a.value(i)).unwrap_or(""),
                ),
                centroid_lat: clat.value(i),
                centroid_lon: clon.value(i),
                polygon_wkb: wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default(),
                area_m2: area_m2.map(|a| a.value(i)).unwrap_or(0.0),
            });
        }
    }
    Ok(out)
}

/// Walk every `<h3r4_dir>/<R4>/airport_{lines,areas}.arrow` and merge
/// into a single global set. Returns `(lines, areas)`.
///
/// OSM aeroway tagging convention: airport identification (name / icao /
/// iata) lives on the aerodrome polygon (`aeroway=aerodrome`), NOT on
/// the runway / taxiway lines that sit inside it. The osm-extract
/// pipeline writes each tag verbatim onto its source feature, so
/// `airport_lines.arrow` ends up with empty `airport_key` strings even
/// for runways inside Praha-Ruzyně. This function patches that gap by
/// running a midpoint-in-polygon test against every line and copying
/// the parent aerodrome's `airport_key` onto it. Without this fix the
/// popup's ground-ops bucketer aggregates 95 % of runway / taxi traffic
/// under `airport_key = ""` and the contributor list shows "Inferred
/// (lat, lon)" instead of "LKPR" / "Letiště Václava Havla Praha".
pub fn read_global_airports(h3r4_dir: &Path) -> Result<(Vec<AirportLine>, Vec<AirportArea>)> {
    let mut lines = Vec::new();
    let mut areas = Vec::new();
    if !h3r4_dir.exists() {
        return Ok((lines, areas));
    }
    for entry in std::fs::read_dir(h3r4_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        lines.extend(read_airport_lines(&path.join("airport_lines.arrow"))?);
        areas.extend(read_airport_areas(&path.join("airport_areas.arrow"))?);
    }
    propagate_aerodrome_identity_to_lines(&mut lines, &areas);
    Ok((lines, areas))
}

/// For every line whose `airport_key` is empty, find the smallest
/// containing aerodrome polygon and copy its identification down.
/// Two-pass match:
///   pass 1 — point-in-polygon containment (smallest polygon wins so a
///   line inside both the outer aerodrome boundary and an inner
///   apron / helipad polygon picks up the more specific name).
///   pass 2 — proximity fallback for `aeroway_type = 5` aerodrome
///   polygons (Ruzyně/LKPR's OSM polygon covers only the terminal
///   building → 37 525 m² out of ~10 km² of actual airport, so its
///   runway lines fall outside the polygon and would otherwise lose
///   their LKPR identity). Fallback radius is the larger of 3 km and
///   `2 × sqrt(area)` so well-mapped airports still anchor on
///   geometry, mis-mapped ones recover via the 3 km guard.
fn propagate_aerodrome_identity_to_lines(lines: &mut [AirportLine], areas: &[AirportArea]) {
    const AERODROME_AEROWAY_TYPE: u8 = 5;
    const PROXIMITY_RADIUS_M: f64 = 3000.0;

    if lines.is_empty() || areas.is_empty() {
        return;
    }
    let area_radius_m = |area: &AirportArea| -> f64 {
        if area.area_m2 > 0.0 {
            (area.area_m2 as f64 / std::f64::consts::PI).sqrt()
        } else {
            // Fallback when osm-extract didn't write area_m2 — use a
            // generous default so the containment test still has a
            // chance to fire.
            500.0
        }
    };
    for line in lines.iter_mut() {
        if !line.airport_key.is_empty() && !line.name.is_empty() {
            continue;
        }
        let mid_lat = (line.start_lat + line.end_lat) * 0.5;
        let mid_lon = (line.start_lon + line.end_lon) * 0.5;

        // Pass 1: smallest containing polygon (any aeroway_type).
        let mut best_contain: Option<(usize, f64)> = None;
        for (idx, area) in areas.iter().enumerate() {
            if area.airport_key.is_empty() && area.name.is_empty() {
                continue;
            }
            let cx = noise_compute::propagation::geo::flat_dist(
                mid_lat,
                mid_lon,
                area.centroid_lat,
                area.centroid_lon,
            );
            let r = area_radius_m(area) * 1.5 + 250.0;
            if cx > r {
                continue;
            }
            let inside = if !area.polygon_wkb.is_empty() {
                noise_compute::wkb::wkb_contains_point(&area.polygon_wkb, mid_lat, mid_lon)
            } else {
                cx <= r
            };
            if !inside {
                continue;
            }
            let measure = if area.area_m2 > 0.0 {
                area.area_m2 as f64
            } else {
                f64::MAX
            };
            if best_contain.map(|(_, m)| measure < m).unwrap_or(true) {
                best_contain = Some((idx, measure));
            }
        }
        if let Some((idx, _)) = best_contain {
            let parent = &areas[idx];
            if line.airport_key.is_empty() {
                line.airport_key = parent.airport_key.clone();
            }
            if line.name.is_empty() {
                line.name = parent.name.clone();
            }
            continue;
        }

        // Pass 2: nearest aerodrome polygon within proximity radius.
        // Only `aeroway_type = 5` (aerodrome) so taxiway / apron
        // polygons don't claim distant runway lines.
        let mut best_prox: Option<(usize, f64)> = None;
        for (idx, area) in areas.iter().enumerate() {
            if area.aeroway_type != AERODROME_AEROWAY_TYPE {
                continue;
            }
            if area.airport_key.is_empty() && area.name.is_empty() {
                continue;
            }
            let cx = noise_compute::propagation::geo::flat_dist(
                mid_lat,
                mid_lon,
                area.centroid_lat,
                area.centroid_lon,
            );
            let radius = PROXIMITY_RADIUS_M.max(area_radius_m(area) * 2.0);
            if cx > radius {
                continue;
            }
            if best_prox.map(|(_, d)| cx < d).unwrap_or(true) {
                best_prox = Some((idx, cx));
            }
        }
        if let Some((idx, _)) = best_prox {
            let parent = &areas[idx];
            if line.airport_key.is_empty() {
                line.airport_key = parent.airport_key.clone();
            }
            if line.name.is_empty() {
                line.name = parent.name.clone();
            }
        }
    }
}
