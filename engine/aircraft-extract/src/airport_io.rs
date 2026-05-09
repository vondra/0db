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
                parsed: Default::default(),
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
    // Effective polygon radius — `area_m2 = 0` means osm-extract didn't
    // write the field, so use a generous 500 m default to give the
    // containment test something to clamp against.
    fn area_radius_m(area: &AirportArea) -> f64 {
        if area.area_m2 > 0.0 {
            (area.area_m2 as f64 / std::f64::consts::PI).sqrt()
        } else {
            500.0
        }
    }
    fn area_has_identity(area: &AirportArea) -> bool {
        !area.airport_key.is_empty() || !area.name.is_empty()
    }
    fn copy_identity(line: &mut AirportLine, parent: &AirportArea) {
        if line.airport_key.is_empty() {
            line.airport_key = parent.airport_key.clone();
        }
        if line.name.is_empty() {
            line.name = parent.name.clone();
        }
    }

    for line in lines.iter_mut() {
        if !line.airport_key.is_empty() && !line.name.is_empty() {
            continue;
        }
        let mid_lat = (line.start_lat + line.end_lat) * 0.5;
        let mid_lon = (line.start_lon + line.end_lon) * 0.5;

        // Pass 1: smallest containing polygon (any aeroway_type). Smaller
        // wins so a runway inside both the outer aerodrome boundary and
        // an inner apron picks up the more specific name.
        let mut best_contain: Option<(usize, f64)> = None;
        for (idx, area) in areas.iter().enumerate() {
            if !area_has_identity(area) {
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
            // Use the cached `ParsedPolygon` so the same WKB hex isn't
            // re-parsed for every (line, area) pair (~5k lines × ~50
            // areas per popup before this commit). `parsed_polygon`
            // returns `None` for empty / malformed WKB; fall back to
            // the centroid-radius gate then.
            let inside = match area.parsed_polygon() {
                Some(parsed) => noise_compute::wkb::rings_contain_any_point(
                    &parsed.outer,
                    &parsed.holes,
                    &[(mid_lat, mid_lon)],
                ),
                None => cx <= r,
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
            copy_identity(line, &areas[idx]);
            continue;
        }

        // Pass 2: nearest aerodrome polygon within proximity radius.
        // Restricted to `aeroway_type = 5` so taxiway / apron polygons
        // don't claim distant runway lines.
        let mut best_prox: Option<(usize, f64)> = None;
        for (idx, area) in areas.iter().enumerate() {
            if area.aeroway_type != AERODROME_AEROWAY_TYPE {
                continue;
            }
            if !area_has_identity(area) {
                continue;
            }
            let cx = noise_compute::propagation::geo::flat_dist(
                mid_lat,
                mid_lon,
                area.centroid_lat,
                area.centroid_lon,
            );
            // Same multiplier (1.5×) as `aeroway_snap::try_snap_to_aerodrome_proximity`
            // so a line and the segments running along it both get
            // assigned to the same aerodrome at the same proximity boundary.
            // /gg (Gemini) caught a 1.5× vs 2.0× mismatch that would have
            // tagged a runway line at 1.8× radius with the parent's
            // identity while the segment running along that line still
            // fell back to anonymous R10 — propagation and identity must
            // agree on which lines belong to which airport.
            let radius = PROXIMITY_RADIUS_M.max(area_radius_m(area) * 1.5);
            if cx > radius {
                continue;
            }
            if best_prox.map(|(_, d)| cx < d).unwrap_or(true) {
                best_prox = Some((idx, cx));
            }
        }
        if let Some((idx, _)) = best_prox {
            copy_identity(line, &areas[idx]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an `AirportLine` with empty identity (the OSM tagging
    /// pattern that propagation is designed to fix).
    fn line(start_lat: f64, start_lon: f64, end_lat: f64, end_lon: f64) -> AirportLine {
        AirportLine {
            osm_id: 1,
            aeroway_type: 0, // runway
            name: String::new(),
            airport_key: String::new(),
            start_lat,
            start_lon,
            end_lat,
            end_lon,
            width_m: 45.0,
        }
    }

    fn aerodrome(
        osm_id: i64,
        icao: &str,
        clat: f64,
        clon: f64,
        area_m2: f32,
        polygon_wkb: &str,
    ) -> AirportArea {
        AirportArea {
            osm_id,
            aeroway_type: 5, // aerodrome
            name: format!("Letiště {}", icao),
            airport_key: icao.to_string(),
            centroid_lat: clat,
            centroid_lon: clon,
            polygon_wkb: polygon_wkb.to_string(),
            area_m2,
            parsed: Default::default(),
        }
    }

    fn apron(name: &str, clat: f64, clon: f64, area_m2: f32) -> AirportArea {
        AirportArea {
            osm_id: 9,
            aeroway_type: 2, // apron
            name: name.to_string(),
            airport_key: String::new(),
            centroid_lat: clat,
            centroid_lon: clon,
            polygon_wkb: String::new(),
            area_m2,
            parsed: Default::default(),
        }
    }

    #[test]
    fn proximity_propagates_lkpr_identity_to_runway_centerline() {
        // Ruzyně canonical case: the airport polygon is small (37 525 m²)
        // and a 3 km runway centerline sits a kilometre to the
        // south-west. Pass-1 polygon containment misses it; pass-2
        // proximity should attach LKPR.
        let mut lines = vec![line(50.105, 14.250, 50.110, 14.270)];
        let areas = vec![aerodrome(42, "LKPR", 50.119, 14.283, 37_525.0, "")];
        propagate_aerodrome_identity_to_lines(&mut lines, &areas);
        assert_eq!(lines[0].airport_key, "LKPR");
        assert!(lines[0].name.contains("LKPR"));
    }

    #[test]
    fn unnamed_apron_does_not_donate_identity() {
        // An apron polygon without name/icao must not claim a runway
        // line — pass-1 was previously called the "smallest containing
        // polygon (any type)" and could have matched here. Passes both
        // skip-empty filters now.
        let mut lines = vec![line(50.105, 14.250, 50.110, 14.270)];
        let areas = vec![apron("", 50.107, 14.260, 5_000.0)];
        propagate_aerodrome_identity_to_lines(&mut lines, &areas);
        assert!(lines[0].airport_key.is_empty());
        assert!(lines[0].name.is_empty());
    }

    #[test]
    fn distant_aerodrome_does_not_donate_identity() {
        // Two airports 30 km apart — the propagation pass must not
        // claim each other's lines (3 km radius guard + per-area
        // 1.5×polygon-radius cap).
        let mut lines = vec![line(50.10, 14.27, 50.11, 14.28)];
        let areas = vec![aerodrome(99, "LKKB", 50.12, 14.55, 1_800_000.0, "")];
        propagate_aerodrome_identity_to_lines(&mut lines, &areas);
        assert!(
            lines[0].airport_key.is_empty(),
            "30 km is well outside the 3 km guard"
        );
    }

    #[test]
    fn nearer_airport_wins_over_farther() {
        // A line equidistant-ish to two airports should pick up the
        // closer one.
        let mut lines = vec![line(50.10, 14.27, 50.11, 14.28)];
        let areas = vec![
            aerodrome(42, "LKPR", 50.119, 14.283, 37_525.0, ""), // ~1 km
            aerodrome(99, "LKKB", 50.12, 14.55, 1_800_000.0, ""), // ~20 km
        ];
        propagate_aerodrome_identity_to_lines(&mut lines, &areas);
        assert_eq!(lines[0].airport_key, "LKPR");
    }
}
