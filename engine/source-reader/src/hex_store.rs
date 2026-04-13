//! Load Arrow IPC File-format files via mmap. Zero-copy — data stays in mmap'd pages.
//!
//! Instead of copying into Vec<Struct>, we keep arrow RecordBatch references.
//! Queries iterate directly over mmap'd column arrays.

use arrow::array::*;
use arrow::ipc::reader::FileReader;
use arrow::record_batch::RecordBatch;
use memmap2::Mmap;
use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

/// All source data for one H3 res-4 hex — mmap'd Arrow IPC files.
pub struct HexData {
    _mmaps: Vec<Arc<Mmap>>,
    pub road_batches: Vec<RecordBatch>,
    pub railway_batches: Vec<RecordBatch>,
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    pub airport_line_batches: Vec<RecordBatch>,
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    pub airport_area_batches: Vec<RecordBatch>,
    pub building_batches: Vec<RecordBatch>,
    pub barrier_batches: Vec<RecordBatch>,
    pub industrial_batches: Vec<RecordBatch>,
    pub aircraft_batches: Vec<RecordBatch>,
}

impl HexData {
    pub fn empty() -> Self {
        HexData {
            _mmaps: vec![],
            road_batches: vec![],
            railway_batches: vec![],
            airport_line_batches: vec![],
            airport_area_batches: vec![],
            building_batches: vec![],
            barrier_batches: vec![],
            industrial_batches: vec![],
            aircraft_batches: vec![],
        }
    }
}

/// Load all source data from a hex directory via mmap (zero-copy).
pub fn load_hex(dir: &str) -> Result<HexData, String> {
    let path = Path::new(dir);
    if !path.exists() {
        return Ok(HexData::empty());
    }

    let mut mmaps = Vec::new();

    let road_batches = load_arrow_mmap(&path.join("roads.arrow"), &mut mmaps);
    let railway_batches = load_arrow_mmap(&path.join("railways.arrow"), &mut mmaps);
    let airport_line_batches = load_arrow_mmap(&path.join("airport_lines.arrow"), &mut mmaps);
    let airport_area_batches = load_arrow_mmap(&path.join("airport_areas.arrow"), &mut mmaps);
    let building_batches = load_arrow_mmap(&path.join("buildings.arrow"), &mut mmaps);
    let barrier_batches = load_arrow_mmap(&path.join("barriers.arrow"), &mut mmaps);
    let industrial_batches = load_arrow_mmap(&path.join("industrial.arrow"), &mut mmaps);
    let aircraft_batches = load_arrow_mmap(&path.join("aircraft.arrow"), &mut mmaps);

    Ok(HexData {
        _mmaps: mmaps,
        road_batches,
        railway_batches,
        airport_line_batches,
        airport_area_batches,
        building_batches,
        barrier_batches,
        industrial_batches,
        aircraft_batches,
    })
}

/// Mmap an Arrow IPC File and return its RecordBatches (zero-copy).
fn load_arrow_mmap(path: &Path, mmaps: &mut Vec<Arc<Mmap>>) -> Vec<RecordBatch> {
    if !path.exists() {
        return vec![];
    }

    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let mmap = match unsafe { Mmap::map(&file) } {
        Ok(m) => Arc::new(m),
        Err(_) => return vec![],
    };

    // FileReader can read from a Cursor over the mmap'd bytes
    let cursor = Cursor::new(mmap.as_ref().as_ref());
    let reader = match FileReader::try_new(cursor, None) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("  source-reader: failed to read {}: {}", path.display(), e);
            return vec![];
        }
    };

    let batches: Vec<RecordBatch> = reader.filter_map(|r| r.ok()).collect();

    // Keep mmap alive
    mmaps.push(mmap);

    batches
}

pub fn aircraft_ground_model_v2(batches: &[RecordBatch]) -> bool {
    batches.iter().any(|batch| {
        batch
            .schema_ref()
            .metadata()
            .get("aircraft_ground_model")
            .map(|v| v == "v2")
            .unwrap_or(false)
    })
}

// ── Query helpers: iterate over mmap'd Arrow columns directly ──

/// Road segment query result (references into mmap'd data, minimal copy).
#[derive(serde::Serialize)]
pub struct RoadResult {
    pub osm_id: i64,
    pub segment_idx: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub road_class: u8,
    pub speed_limit: u8,
    pub surface_type: u8,
    pub oneway: bool,
    pub lanes: u8,
    pub name: String,
    #[serde(rename = "ref")]
    pub road_ref: String,
    pub bridge: bool,
    pub tunnel: bool,
    pub access: u8,
    pub junction: u8,
    pub aadt_light: i32,
    pub aadt_medium: i32,
    pub aadt_heavy: i32,
    pub aadt_moto: i32,
    pub traffic_source: u8,
    pub dist_m: f64,
    pub cp_lat: f64,
    pub cp_lon: f64,
    pub fraction: f64,
}

/// Scan road batches, filter by distance, return results.
pub fn query_roads_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<RoadResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let seg_idx = col_i16(batch, "segment_idx");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");
        let len = col_f32(batch, "length_m");
        let rclass = col_u8(batch, "road_class");
        let speed = col_u8(batch, "speed_limit");
        let surface = col_u8(batch, "surface_type");
        let ow = col_bool(batch, "oneway");
        let lanes = col_u8(batch, "lanes");
        let name = col_str(batch, "name");
        let road_ref = col_str(batch, "ref");
        let bridge_col: Option<&arrow::array::BooleanArray> = batch
            .column_by_name("bridge")
            .and_then(|c| c.as_any().downcast_ref());
        let tunnel_col: Option<&arrow::array::BooleanArray> = batch
            .column_by_name("tunnel")
            .and_then(|c| c.as_any().downcast_ref());
        let access_col = col_u8(batch, "access");
        let junction_col = col_u8(batch, "junction");
        let aadt_l = col_i32(batch, "aadt_light");
        let aadt_m = col_i32(batch, "aadt_medium");
        let aadt_h = col_i32(batch, "aadt_heavy");
        let aadt_mo = col_i32(batch, "aadt_moto");
        let tsrc = col_u8(batch, "traffic_source");

        // All required columns must be present
        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            let raw = noise_compute::normalize::RawRoadInput {
                road_class: rclass.map(|a| a.value(i)).unwrap_or(0),
                speed_limit: speed.map(|a| a.value(i)).unwrap_or(0),
                surface_type: surface.map(|a| a.value(i)).unwrap_or(0),
                oneway: ow.map(|a| a.value(i)).unwrap_or(false),
                lanes: lanes.map(|a| a.value(i)).unwrap_or(0),
                aadt_light: aadt_l.map(|a| a.value(i)).unwrap_or(0),
                aadt_medium: aadt_m.map(|a| a.value(i)).unwrap_or(0),
                aadt_heavy: aadt_h.map(|a| a.value(i)).unwrap_or(0),
                aadt_moto: aadt_mo.map(|a| a.value(i)).unwrap_or(0),
                traffic_source: tsrc.map(|a| a.value(i)).unwrap_or(0),
                tunnel: tunnel_col.map(|a| a.value(i)).unwrap_or(false),
                access: access_col.map(|a| a.value(i)).unwrap_or(0),
                junction: junction_col.map(|a| a.value(i)).unwrap_or(0),
            };
            let Some(norm) = noise_compute::normalize::normalize_road(raw) else {
                continue;
            };
            let effective_radius = max_radius.min(norm.max_distance_m);

            let s_lat = slat.value(i);
            let s_lon = slon.value(i);
            let e_lat = elat.value(i);
            let e_lon = elon.value(i);

            // Quick bbox reject
            let mid_lat = (s_lat + e_lat) / 2.0;
            let mid_lon = (s_lon + e_lon) / 2.0;
            let dlat = (lat - mid_lat).abs() * 110_540.0;
            if dlat > effective_radius * 1.5 {
                continue;
            }
            let dlon = (lon - mid_lon).abs() * 111_320.0 * mid_lat.to_radians().cos();
            if dlon > effective_radius * 1.5 {
                continue;
            }

            // Exact closest point on segment
            let cp = crate::geo::closest_point_on_segment(lat, lon, s_lat, s_lon, e_lat, e_lon);
            if cp.dist_m > effective_radius {
                continue;
            }

            results.push(RoadResult {
                osm_id: osm_id.value(i),
                segment_idx: seg_idx.map(|a| a.value(i)).unwrap_or(0),
                start_lat: s_lat,
                start_lon: s_lon,
                end_lat: e_lat,
                end_lon: e_lon,
                length_m: len.map(|a| a.value(i)).unwrap_or(0.0),
                road_class: raw.road_class,
                speed_limit: raw.speed_limit,
                surface_type: raw.surface_type,
                oneway: raw.oneway,
                lanes: raw.lanes,
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                road_ref: road_ref.map(|a| a.value(i).to_string()).unwrap_or_default(),
                bridge: bridge_col.map(|a| a.value(i)).unwrap_or(false),
                tunnel: raw.tunnel,
                access: raw.access,
                junction: raw.junction,
                aadt_light: raw.aadt_light,
                aadt_medium: raw.aadt_medium,
                aadt_heavy: raw.aadt_heavy,
                aadt_moto: raw.aadt_moto,
                traffic_source: raw.traffic_source,
                dist_m: cp.dist_m,
                cp_lat: cp.lat,
                cp_lon: cp.lon,
                fraction: cp.fraction,
            });
        }
    }

    results
}

#[derive(serde::Serialize)]
pub struct BuildingResult {
    pub osm_id: i64,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub height: f32,
    pub floors: u8,
    pub area_m2: f32,
    pub building_type: u8,
    pub building_use: u8,
    pub name: String,
    pub addr_street: String,
    pub addr_housenumber: String,
    pub polygon_wkb: String,
    pub dist_m: f64,
}

/// Railway segment query result.
#[derive(serde::Serialize)]
pub struct RailResult {
    pub osm_id: i64,
    pub segment_idx: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub rail_type: u8,
    pub usage: u8,
    pub maxspeed: u8,
    pub name: String,
    pub rail_ref: String,
    pub bridge: bool,
    pub tunnel: bool,
    pub service: u8,
    pub highspeed: bool,
    pub trains_passenger: i32,
    pub trains_freight: i32,
    pub parallel_divisor: u8,
    pub dist_m: f64,
    pub cp_lat: f64,
    pub cp_lon: f64,
    pub fraction: f64,
}

pub fn query_railways_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<RailResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");

        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        let seg_idx = col_i16(batch, "segment_idx");
        let len = col_f32(batch, "length_m");
        let rtype = col_u8(batch, "rail_type");
        let usage = col_u8(batch, "usage");
        let maxspd = col_u8(batch, "maxspeed");
        let name = col_str(batch, "name");
        let rail_ref = col_str(batch, "ref");
        let bridge_col = col_bool(batch, "bridge");
        let tunnel_col = col_bool(batch, "tunnel");
        let service_col = col_u8(batch, "service");
        let highspeed_col = col_bool(batch, "highspeed");
        let trains_pax = col_i32(batch, "trains_passenger");
        let trains_frt = col_i32(batch, "trains_freight");
        let par_div = col_u8(batch, "parallel_divisor");

        for i in 0..n {
            let s_lat = slat.value(i);
            let s_lon = slon.value(i);
            let e_lat = elat.value(i);
            let e_lon = elon.value(i);

            let mid_lat = (s_lat + e_lat) / 2.0;
            let mid_lon = (s_lon + e_lon) / 2.0;
            let dlat = (lat - mid_lat).abs() * 110_540.0;
            if dlat > max_radius * 1.5 {
                continue;
            }
            let dlon = (lon - mid_lon).abs() * 111_320.0 * mid_lat.to_radians().cos();
            if dlon > max_radius * 1.5 {
                continue;
            }

            let cp = crate::geo::closest_point_on_segment(lat, lon, s_lat, s_lon, e_lat, e_lon);
            if cp.dist_m > max_radius {
                continue;
            }

            results.push(RailResult {
                osm_id: osm_id.value(i),
                segment_idx: seg_idx.map(|a| a.value(i)).unwrap_or(0),
                start_lat: s_lat,
                start_lon: s_lon,
                end_lat: e_lat,
                end_lon: e_lon,
                length_m: len.map(|a| a.value(i)).unwrap_or(0.0),
                rail_type: rtype.map(|a| a.value(i)).unwrap_or(0),
                usage: usage.map(|a| a.value(i)).unwrap_or(0),
                maxspeed: maxspd.map(|a| a.value(i)).unwrap_or(0),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                rail_ref: rail_ref.map(|a| a.value(i).to_string()).unwrap_or_default(),
                bridge: bridge_col.map(|a| a.value(i)).unwrap_or(false),
                tunnel: tunnel_col.map(|a| a.value(i)).unwrap_or(false),
                service: service_col.map(|a| a.value(i)).unwrap_or(0),
                highspeed: highspeed_col.map(|a| a.value(i)).unwrap_or(false),
                trains_passenger: trains_pax.map(|a| a.value(i)).unwrap_or(0),
                trains_freight: trains_frt.map(|a| a.value(i)).unwrap_or(0),
                parallel_divisor: par_div.map(|a| a.value(i)).unwrap_or(1),
                dist_m: cp.dist_m,
                cp_lat: cp.lat,
                cp_lon: cp.lon,
                fraction: cp.fraction,
            });
        }
    }
    results
}

pub fn query_buildings_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<BuildingResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let clat = col_f64(batch, "centroid_lat");
        let clon = col_f64(batch, "centroid_lon");

        let (Some(osm_id), Some(clat), Some(clon)) = (osm_id, clat, clon) else {
            continue;
        };

        let height = col_f32(batch, "height");
        let floors = col_u8(batch, "floors");
        let area = col_f32(batch, "area_m2");
        let btype = col_u8(batch, "building_type");
        let buse = col_u8(batch, "building_use");
        let name = col_str(batch, "name");
        let street = col_str(batch, "addr_street");
        let house = col_str(batch, "addr_housenumber");
        let wkb = col_binary(batch, "polygon_wkb");

        for i in 0..n {
            let c_lat = clat.value(i);
            let c_lon = clon.value(i);
            let dist = crate::geo::flat_dist(lat, lon, c_lat, c_lon);
            if dist > max_radius {
                continue;
            }

            results.push(BuildingResult {
                osm_id: osm_id.value(i),
                centroid_lat: c_lat,
                centroid_lon: c_lon,
                height: height.map(|a| a.value(i)).unwrap_or(0.0),
                floors: floors.map(|a| a.value(i)).unwrap_or(0),
                area_m2: area.map(|a| a.value(i)).unwrap_or(0.0),
                building_type: btype.map(|a| a.value(i)).unwrap_or(0),
                building_use: buse.map(|a| a.value(i)).unwrap_or(0),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                addr_street: street.map(|a| a.value(i).to_string()).unwrap_or_default(),
                addr_housenumber: house.map(|a| a.value(i).to_string()).unwrap_or_default(),
                polygon_wkb: wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default(),
                dist_m: dist,
            });
        }
    }

    results
}

#[allow(dead_code)]
pub fn load_airport_lines_from_batches(
    batches: &[RecordBatch],
) -> Vec<noise_compute::types::AirportLine> {
    fn airport_key(name: &str, _airport_ref: &str, icao: &str, iata: &str) -> String {
        let key = if !icao.is_empty() {
            icao
        } else if !iata.is_empty() {
            iata
        } else {
            name
        };
        key.trim().to_string()
    }

    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");
        let aeroway_type = col_u8(batch, "aeroway_type");
        let width_m = col_f32(batch, "width_m");
        let name = col_str(batch, "name");
        let airport_ref = col_str(batch, "ref");
        let icao = col_str(batch, "icao");
        let iata = col_str(batch, "iata");

        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            results.push(noise_compute::types::AirportLine {
                osm_id: osm_id.value(i),
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_key: airport_key(
                    name.map(|a| a.value(i)).unwrap_or(""),
                    airport_ref.map(|a| a.value(i)).unwrap_or(""),
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

    results
}

#[allow(dead_code)]
pub fn load_airport_areas_from_batches(
    batches: &[RecordBatch],
) -> Vec<noise_compute::types::AirportArea> {
    fn airport_key(name: &str, _airport_ref: &str, icao: &str, iata: &str) -> String {
        let key = if !icao.is_empty() {
            icao
        } else if !iata.is_empty() {
            iata
        } else {
            name
        };
        key.trim().to_string()
    }

    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let clat = col_f64(batch, "centroid_lat");
        let clon = col_f64(batch, "centroid_lon");
        let aeroway_type = col_u8(batch, "aeroway_type");
        let name = col_str(batch, "name");
        let airport_ref = col_str(batch, "ref");
        let icao = col_str(batch, "icao");
        let iata = col_str(batch, "iata");
        let wkb = col_binary(batch, "polygon_wkb");
        let area_m2 = col_f32(batch, "area_m2");

        let (Some(osm_id), Some(clat), Some(clon)) = (osm_id, clat, clon) else {
            continue;
        };

        for i in 0..n {
            results.push(noise_compute::types::AirportArea {
                osm_id: osm_id.value(i),
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_key: airport_key(
                    name.map(|a| a.value(i)).unwrap_or(""),
                    airport_ref.map(|a| a.value(i)).unwrap_or(""),
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

    results
}

#[cfg_attr(not(feature = "node"), allow(dead_code))]
#[derive(serde::Serialize)]
pub struct AirportLineResult {
    pub osm_id: i64,
    pub segment_idx: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub aeroway_type: u8,
    pub name: String,
    #[serde(rename = "ref")]
    pub airport_ref: String,
    pub icao: String,
    pub iata: String,
    pub operator: String,
    pub surface: String,
    pub width_m: f32,
    pub aerodrome_type: String,
    pub access: String,
    pub dist_m: f64,
    pub cp_lat: f64,
    pub cp_lon: f64,
    pub fraction: f64,
}

#[cfg_attr(not(feature = "node"), allow(dead_code))]
pub fn query_airport_lines_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<AirportLineResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let seg_idx = col_i16(batch, "segment_idx");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");
        let len = col_f32(batch, "length_m");
        let aeroway_type = col_u8(batch, "aeroway_type");
        let name = col_str(batch, "name");
        let airport_ref = col_str(batch, "ref");
        let icao = col_str(batch, "icao");
        let iata = col_str(batch, "iata");
        let operator = col_str(batch, "operator");
        let surface = col_str(batch, "surface");
        let width_m = col_f32(batch, "width_m");
        let aerodrome_type = col_str(batch, "aerodrome_type");
        let access = col_str(batch, "access");

        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            let s_lat = slat.value(i);
            let s_lon = slon.value(i);
            let e_lat = elat.value(i);
            let e_lon = elon.value(i);

            let mid_lat = (s_lat + e_lat) / 2.0;
            let mid_lon = (s_lon + e_lon) / 2.0;
            let dlat = (lat - mid_lat).abs() * 110_540.0;
            if dlat > max_radius * 1.5 {
                continue;
            }
            let dlon = (lon - mid_lon).abs() * 111_320.0 * mid_lat.to_radians().cos();
            if dlon > max_radius * 1.5 {
                continue;
            }

            let cp = crate::geo::closest_point_on_segment(lat, lon, s_lat, s_lon, e_lat, e_lon);
            if cp.dist_m > max_radius {
                continue;
            }

            results.push(AirportLineResult {
                osm_id: osm_id.value(i),
                segment_idx: seg_idx.map(|a| a.value(i)).unwrap_or(0),
                start_lat: s_lat,
                start_lon: s_lon,
                end_lat: e_lat,
                end_lon: e_lon,
                length_m: len.map(|a| a.value(i)).unwrap_or(0.0),
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_ref: airport_ref
                    .map(|a| a.value(i).to_string())
                    .unwrap_or_default(),
                icao: icao.map(|a| a.value(i).to_string()).unwrap_or_default(),
                iata: iata.map(|a| a.value(i).to_string()).unwrap_or_default(),
                operator: operator.map(|a| a.value(i).to_string()).unwrap_or_default(),
                surface: surface.map(|a| a.value(i).to_string()).unwrap_or_default(),
                width_m: width_m.map(|a| a.value(i)).unwrap_or(0.0),
                aerodrome_type: aerodrome_type
                    .map(|a| a.value(i).to_string())
                    .unwrap_or_default(),
                access: access.map(|a| a.value(i).to_string()).unwrap_or_default(),
                dist_m: cp.dist_m,
                cp_lat: cp.lat,
                cp_lon: cp.lon,
                fraction: cp.fraction,
            });
        }
    }

    results
}

#[cfg_attr(not(feature = "node"), allow(dead_code))]
#[derive(serde::Serialize)]
pub struct AirportAreaResult {
    pub osm_id: i64,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub aeroway_type: u8,
    pub name: String,
    #[serde(rename = "ref")]
    pub airport_ref: String,
    pub icao: String,
    pub iata: String,
    pub operator: String,
    pub surface: String,
    pub width_m: f32,
    pub aerodrome_type: String,
    pub access: String,
    pub polygon_wkb: String,
    pub area_m2: f32,
    pub dist_m: f64,
}

#[cfg_attr(not(feature = "node"), allow(dead_code))]
pub fn query_airport_areas_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<AirportAreaResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let clat = col_f64(batch, "centroid_lat");
        let clon = col_f64(batch, "centroid_lon");
        let aeroway_type = col_u8(batch, "aeroway_type");
        let name = col_str(batch, "name");
        let airport_ref = col_str(batch, "ref");
        let icao = col_str(batch, "icao");
        let iata = col_str(batch, "iata");
        let operator = col_str(batch, "operator");
        let surface = col_str(batch, "surface");
        let width_m = col_f32(batch, "width_m");
        let aerodrome_type = col_str(batch, "aerodrome_type");
        let access = col_str(batch, "access");
        let wkb = col_binary(batch, "polygon_wkb");
        let area_m2 = col_f32(batch, "area_m2");

        let (Some(osm_id), Some(clat), Some(clon)) = (osm_id, clat, clon) else {
            continue;
        };

        for i in 0..n {
            let c_lat = clat.value(i);
            let c_lon = clon.value(i);
            let dist = crate::geo::flat_dist(lat, lon, c_lat, c_lon);
            if dist > max_radius {
                continue;
            }

            results.push(AirportAreaResult {
                osm_id: osm_id.value(i),
                centroid_lat: c_lat,
                centroid_lon: c_lon,
                aeroway_type: aeroway_type.map(|a| a.value(i)).unwrap_or(255),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                airport_ref: airport_ref
                    .map(|a| a.value(i).to_string())
                    .unwrap_or_default(),
                icao: icao.map(|a| a.value(i).to_string()).unwrap_or_default(),
                iata: iata.map(|a| a.value(i).to_string()).unwrap_or_default(),
                operator: operator.map(|a| a.value(i).to_string()).unwrap_or_default(),
                surface: surface.map(|a| a.value(i).to_string()).unwrap_or_default(),
                width_m: width_m.map(|a| a.value(i)).unwrap_or(0.0),
                aerodrome_type: aerodrome_type
                    .map(|a| a.value(i).to_string())
                    .unwrap_or_default(),
                access: access.map(|a| a.value(i).to_string()).unwrap_or_default(),
                polygon_wkb: wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default(),
                area_m2: area_m2.map(|a| a.value(i)).unwrap_or(0.0),
                dist_m: dist,
            });
        }
    }

    results
}

#[derive(serde::Serialize)]
pub struct BarrierResult {
    pub osm_id: i64,
    pub height: f32,
    pub lat: f64,
    pub lon: f64,
    pub dist_m: f64,
}

pub fn query_barriers_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<BarrierResult> {
    let mut results = Vec::new();

    for batch in batches {
        let n = batch.num_rows();
        let osm_id = col_i64(batch, "osm_id");
        let height = col_f32(batch, "height");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");

        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            let mid_lat = (slat.value(i) + elat.value(i)) / 2.0;
            let mid_lon = (slon.value(i) + elon.value(i)) / 2.0;
            let dist = crate::geo::flat_dist(lat, lon, mid_lat, mid_lon);
            if dist > max_radius {
                continue;
            }

            results.push(BarrierResult {
                osm_id: osm_id.value(i),
                height: height.map(|a| a.value(i)).unwrap_or(3.0),
                lat: mid_lat,
                lon: mid_lon,
                dist_m: dist,
            });
        }
    }

    results
}

/// Aircraft segment result.
#[derive(serde::Serialize)]
pub struct AircraftResult {
    pub flight_id: u64,
    pub profile_idx: u8,
    pub is_departure: bool,
    pub on_ground: bool,
    pub period: u8,
    pub date_id: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub start_alt_m: f32,
    pub end_lat: f64,
    pub end_lon: f64,
    pub end_alt_m: f32,
    pub speed_kt: f32,
    pub segment_length_m: f32,
}

pub fn visit_aircraft_from_batches<F>(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius_m: f64,
    receiver_elev_m: f64,
    mut visit: F,
) where
    F: FnMut(AircraftResult),
{
    let lat_pad_deg = max_radius_m / 110_540.0;
    for batch in batches {
        let n = batch.num_rows();
        let fid = col_u64(batch, "flight_id");
        let pidx = col_u8(batch, "profile_idx");
        let dep = col_bool(batch, "is_departure");
        let on_ground = col_bool(batch, "on_ground");
        let per = col_u8(batch, "period");
        let did = col_i16(batch, "date_id");
        let slat = col_f64(batch, "start_lat");
        let slon = col_f64(batch, "start_lon");
        let salt = col_f32(batch, "start_alt_m");
        let elat = col_f64(batch, "end_lat");
        let elon = col_f64(batch, "end_lon");
        let ealt = col_f32(batch, "end_alt_m");
        let spd = col_f32(batch, "speed_kt");
        let slen = col_f32(batch, "segment_length_m");

        let (Some(fid), Some(slat), Some(slon), Some(salt), Some(elat), Some(elon), Some(ealt)) =
            (fid, slat, slon, salt, elat, elon, ealt)
        else {
            continue;
        };

        for i in 0..n {
            let start_lat = slat.value(i);
            let start_lon = slon.value(i);
            let start_alt_m = salt.value(i);
            let end_lat = elat.value(i);
            let end_lon = elon.value(i);
            let end_alt_m = ealt.value(i);
            let on_ground_val = on_ground.map(|a| a.value(i)).unwrap_or(false);
            let speed_kt_val = spd.map(|a| a.value(i)).unwrap_or(0.0);

            let max_alt_m = start_alt_m.max(end_alt_m) as f64;
            if max_alt_m < receiver_elev_m - 100.0 && !on_ground_val && speed_kt_val < 60.0 {
                continue;
            }

            let min_lat = start_lat.min(end_lat);
            let max_lat = start_lat.max(end_lat);
            if lat < min_lat - lat_pad_deg || lat > max_lat + lat_pad_deg {
                continue;
            }
            let ref_lat = (min_lat + max_lat + lat) / 3.0;
            let lon_pad_deg =
                max_radius_m / (111_320.0 * ref_lat.to_radians().cos().abs().max(0.2));
            let min_lon = start_lon.min(end_lon);
            let max_lon = start_lon.max(end_lon);
            if lon < min_lon - lon_pad_deg || lon > max_lon + lon_pad_deg {
                continue;
            }

            // Keep popup semantics aligned with Doc 29 12 km cutoff, but filter before
            // expensive airport-ground matching. The midpoint box is a cheap first pass;
            // closest-point distance is the conservative geometric gate.
            let mid_lat = (start_lat + end_lat) * 0.5;
            let mid_lon = (start_lon + end_lon) * 0.5;
            let dlat = (lat - mid_lat).abs() * 110_540.0;
            if dlat > max_radius_m * 1.5 {
                continue;
            }
            let dlon = (lon - mid_lon).abs() * 111_320.0 * mid_lat.to_radians().cos();
            if dlon > max_radius_m * 1.5 {
                continue;
            }

            let cp = crate::geo::closest_point_on_segment(
                lat, lon, start_lat, start_lon, end_lat, end_lon,
            );
            if cp.dist_m > max_radius_m {
                continue;
            }

            visit(AircraftResult {
                flight_id: fid.value(i),
                profile_idx: pidx.map(|a| a.value(i)).unwrap_or(7),
                is_departure: dep.map(|a| a.value(i)).unwrap_or(false),
                on_ground: on_ground_val,
                period: per.map(|a| a.value(i)).unwrap_or(0),
                date_id: did.map(|a| a.value(i)).unwrap_or(0),
                start_lat,
                start_lon,
                start_alt_m,
                end_lat,
                end_lon,
                end_alt_m,
                speed_kt: speed_kt_val,
                segment_length_m: slen.map(|a| a.value(i)).unwrap_or(0.0),
            });
        }
    }
}

/// Query aircraft segments from batches. No distance filter — Doc 29 handles cutoff internally.
#[allow(dead_code)]
pub fn query_aircraft_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius_m: f64,
    receiver_elev_m: f64,
) -> Vec<AircraftResult> {
    let mut results = Vec::new();
    visit_aircraft_from_batches(batches, lat, lon, max_radius_m, receiver_elev_m, |row| {
        results.push(row)
    });
    results
}

// ── Column accessors ──

fn col_u64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a UInt64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_i64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_i32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_i16<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int16Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_f64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_f32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_u8<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a UInt8Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_bool<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a BooleanArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_str<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a StringArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_binary<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a BinaryArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
