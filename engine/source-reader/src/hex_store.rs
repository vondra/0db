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
    pub building_batches: Vec<RecordBatch>,
    pub barrier_batches: Vec<RecordBatch>,
    pub industrial_batches: Vec<RecordBatch>,
    /// Leisure AREA sources (`leisure.arrow`, settlement v2 phase 2) — sports
    /// pitch / playground / pool / beer garden. Folded into the building
    /// (settlement) layer in the popup.
    pub leisure_batches: Vec<RecordBatch>,
    pub aircraft_airborne_batches: Vec<RecordBatch>,
    pub aircraft_cruise_batches: Vec<RecordBatch>,
    /// Per-microsegment sparse traffic counters
    /// (`airport_traffic.arrow`). See [`add_v6_aircraft_to_result`].
    pub aircraft_airport_traffic_batches: Vec<RecordBatch>,
    /// OSM aeroway microsegments (`airport_lines.arrow`). Carries
    /// `osm_id` + `segment_idx` + nullable `ref` (e.g. "RWY 06/24")
    /// per microsegment. Source-reader uses this to map per-row
    /// airport_traffic.arrow rows back to their OSM way identifier so
    /// the popup can label SegmentTraces "LKPR RWY 06/24" instead of
    /// the generic "LKPR runway-roll". The same batches feed the
    /// per-osm_id runway-end anchor extractor that gates the airborne
    /// 6 km airport-context test.
    pub airport_lines_batches: Vec<RecordBatch>,
    /// Stage 1.5 DBSCAN-discovered airstrips
    /// (`synth_airport_lines.arrow`). Same microsegment shape as the
    /// real OSM lines but with `osm_id: UInt64` (high-bit-set)
    /// and an explicit `airport_key` column. Fed to the runway-end
    /// anchor extractor alongside the real lines so auto-discovered
    /// strips contribute to the airborne airport-context gate.
    pub synth_airport_lines_batches: Vec<RecordBatch>,
}

impl HexData {
    pub fn empty() -> Self {
        HexData {
            _mmaps: vec![],
            road_batches: vec![],
            railway_batches: vec![],
            building_batches: vec![],
            barrier_batches: vec![],
            industrial_batches: vec![],
            leisure_batches: vec![],
            aircraft_airborne_batches: vec![],
            aircraft_cruise_batches: vec![],
            aircraft_airport_traffic_batches: vec![],
            airport_lines_batches: vec![],
            synth_airport_lines_batches: vec![],
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
    let building_batches = load_arrow_mmap(&path.join("buildings.arrow"), &mut mmaps);
    let barrier_batches = load_arrow_mmap(&path.join("barriers.arrow"), &mut mmaps);
    let industrial_batches = load_arrow_mmap(&path.join("industrial.arrow"), &mut mmaps);
    let leisure_batches = load_arrow_mmap(&path.join("leisure.arrow"), &mut mmaps);
    // settlement v2 phase 2: buildings re-numbered building_type + added columns,
    // leisure is a NEW file. A stale v1 buildings.arrow would feed OLD type ids
    // through the NEW emission profiles → silently wrong popup numbers. Fail loud
    // (Convention-B per-file contract); the fix is re-extract.
    let building_batches = check_contract(
        building_batches,
        "buildings_contract",
        BUILDINGS_CONTRACT_V2,
        "buildings.arrow",
    )?;
    let leisure_batches = check_contract(
        leisure_batches,
        "leisure_contract",
        LEISURE_CONTRACT_V1,
        "leisure.arrow",
    )?;
    let aircraft_airborne_batches = load_arrow_mmap(&path.join("airborne.arrow"), &mut mmaps);
    let aircraft_cruise_batches = load_arrow_mmap(&path.join("cruise.arrow"), &mut mmaps);
    let aircraft_airport_traffic_batches =
        load_arrow_mmap(&path.join("airport_traffic.arrow"), &mut mmaps);
    let airport_lines_batches = load_arrow_mmap(&path.join("airport_lines.arrow"), &mut mmaps);
    // Stage 1.5's synth strips live alongside the real OSM lines in
    // each R4 dir. Optional — older extracts predate Stage 1.5; the
    // loader returns an empty vec when the file is absent.
    let synth_airport_lines_batches =
        load_arrow_mmap(&path.join("synth_airport_lines.arrow"), &mut mmaps);

    Ok(HexData {
        _mmaps: mmaps,
        road_batches,
        railway_batches,
        building_batches,
        barrier_batches,
        industrial_batches,
        leisure_batches,
        aircraft_airborne_batches,
        aircraft_cruise_batches,
        aircraft_airport_traffic_batches,
        airport_lines_batches,
        synth_airport_lines_batches,
    })
}

/// settlement v2 phase 2 per-file contracts (source of truth:
/// `osm-extract::finalize`). Mirrored here so the popup rejects a stale
/// buildings.arrow whose `building_type` ids predate the re-numbering.
pub const BUILDINGS_CONTRACT_V2: &str = "buildings_v2";
pub const LEISURE_CONTRACT_V1: &str = "leisure_v1";

/// Verify every batch of a settlement arrow carries the expected per-file
/// contract stamp (Convention-B). Empty input passes (missing file is fine).
/// Returns the batches unchanged on success, an `Err(String)` on mismatch so
/// `load_hex` fails loud rather than serving mis-profiled buildings.
fn check_contract(
    batches: Vec<RecordBatch>,
    key: &str,
    expected: &str,
    label: &str,
) -> Result<Vec<RecordBatch>, String> {
    for batch in &batches {
        let c = batch.schema_ref().metadata().get(key).map(String::as_str);
        if c != Some(expected) {
            return Err(format!(
                "{label} {key} mismatch (expected {expected}, got {c:?}) — \
                 re-extract OSM (settlement v2 phase 2)"
            ));
        }
    }
    Ok(batches)
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
    pub source_id: u16,
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

    // Admin resolved once per popup call — lat/lng is the query centre.
    // Falls back to UNKNOWN → WORLD_DEFAULT when the table isn't loaded.
    let admin = noise_compute::admin::admin_for_latlng(lat, lon);

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
        // Single `source_id` column; provenance via
        // `noise_compute::sources::provenance_of(source_id)`.
        let source_id_col = col_u16(batch, "source_id");

        // All required columns must be present
        let (Some(osm_id), Some(slat), Some(slon), Some(elat), Some(elon)) =
            (osm_id, slat, slon, elat, elon)
        else {
            continue;
        };

        for i in 0..n {
            // Cheap bbox reject FIRST, before the per-row normalize cascade.
            // ~99% of rows are far from the popup point (popup hits ~1-2 k of
            // ~900 k road segments per R4 ring); running normalize_road on all
            // of them was the dominant cost in collect_from_hex_data
            // (~160 ms warm). max_radius is the upper bound — final accept
            // uses effective_radius after normalize.
            let s_lat = slat.value(i);
            let e_lat = elat.value(i);
            let mid_lat = (s_lat + e_lat) * 0.5;
            let dlat = (lat - mid_lat).abs() * 110_540.0;
            if dlat > max_radius * 1.5 {
                continue;
            }
            let s_lon = slon.value(i);
            let e_lon = elon.value(i);
            let mid_lon = (s_lon + e_lon) * 0.5;
            let dlon = (lon - mid_lon).abs() * 111_320.0 * mid_lat.to_radians().cos();
            if dlon > max_radius * 1.5 {
                continue;
            }

            let source_id = source_id_col.map(|a| a.value(i)).unwrap_or(0);
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
                provenance: noise_compute::sources::provenance_of(source_id),
                tunnel: tunnel_col.map(|a| a.value(i)).unwrap_or(false),
                access: access_col.map(|a| a.value(i)).unwrap_or(0),
                junction: junction_col.map(|a| a.value(i)).unwrap_or(0),
            };
            let Some(norm) = noise_compute::normalize::normalize_road(raw, admin) else {
                continue;
            };
            let effective_radius = max_radius.min(norm.max_distance_m);

            // Tighter bbox reject using effective_radius (per-class).
            if dlat > effective_radius * 1.5 || dlon > effective_radius * 1.5 {
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
                source_id,
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
    pub maxspeed: u16,
    pub name: String,
    pub rail_ref: String,
    pub bridge: bool,
    pub tunnel: bool,
    pub service: u8,
    pub highspeed: bool,
    pub trains_passenger: i32,
    pub trains_freight: i32,
    pub parallel_divisor: u8,
    pub source_id: u16,
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
        let maxspd = col_u16_or_u8(batch, "maxspeed");
        let name = col_str(batch, "name");
        let rail_ref = col_str(batch, "ref");
        let bridge_col = col_bool(batch, "bridge");
        let tunnel_col = col_bool(batch, "tunnel");
        let service_col = col_u8(batch, "service");
        let highspeed_col = col_bool(batch, "highspeed");
        let trains_pax = col_i32(batch, "trains_passenger");
        let trains_frt = col_i32(batch, "trains_freight");
        let par_div = col_u8(batch, "parallel_divisor");
        let source_id_col = col_u16(batch, "source_id");

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
                maxspeed: maxspd.as_ref().map(|a| a.value(i)).unwrap_or(0),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                rail_ref: rail_ref.map(|a| a.value(i).to_string()).unwrap_or_default(),
                bridge: bridge_col.map(|a| a.value(i)).unwrap_or(false),
                tunnel: tunnel_col.map(|a| a.value(i)).unwrap_or(false),
                service: service_col.map(|a| a.value(i)).unwrap_or(0),
                highspeed: highspeed_col.map(|a| a.value(i)).unwrap_or(false),
                trains_passenger: trains_pax.map(|a| a.value(i)).unwrap_or(0),
                trains_freight: trains_frt.map(|a| a.value(i)).unwrap_or(0),
                parallel_divisor: par_div.map(|a| a.value(i)).unwrap_or(1),
                source_id: source_id_col.map(|a| a.value(i)).unwrap_or(0),
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

/// One `leisure.arrow` row near the receiver (settlement v2 phase 2).
#[derive(serde::Serialize)]
pub struct LeisureResult {
    pub osm_id: i64,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    /// `emission::leisure` class id (PITCH/PADEL/…).
    pub sport: u8,
    pub capacity: u32,
    pub area_m2: f32,
    pub name: String,
    pub polygon_wkb: String,
    pub dist_m: f64,
}

pub fn query_leisure_from_batches(
    batches: &[RecordBatch],
    lat: f64,
    lon: f64,
    max_radius: f64,
) -> Vec<LeisureResult> {
    let mut results = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let (Some(osm_id), Some(clat), Some(clon)) = (
            col_i64(batch, "osm_id"),
            col_f64(batch, "centroid_lat"),
            col_f64(batch, "centroid_lon"),
        ) else {
            continue;
        };
        let sport = col_u8(batch, "sport");
        let capacity = col_u32(batch, "capacity");
        let area = col_f32(batch, "area_m2");
        let name = col_str(batch, "name");
        let wkb = col_binary(batch, "polygon_wkb");

        for i in 0..n {
            let c_lat = clat.value(i);
            let c_lon = clon.value(i);
            let dist = crate::geo::flat_dist(lat, lon, c_lat, c_lon);
            if dist > max_radius {
                continue;
            }
            results.push(LeisureResult {
                osm_id: osm_id.value(i),
                centroid_lat: c_lat,
                centroid_lon: c_lon,
                sport: sport.map(|a| a.value(i)).unwrap_or(0),
                capacity: capacity.map(|a| a.value(i)).unwrap_or(0),
                area_m2: area.map(|a| a.value(i)).unwrap_or(0.0),
                name: name.map(|a| a.value(i).to_string()).unwrap_or_default(),
                polygon_wkb: wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default(),
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

pub fn col_i64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_i32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_i16<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Int16Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_f64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_f32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_u8<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a UInt8Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_u16<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a UInt16Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_u32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a UInt32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_bool<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a BooleanArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}

/// Width-tolerant accessor for columns migrated u8 → u16 (rail `maxspeed`,
/// 2026-06: 300+ km/h overflowed u8). Old arrows keep UInt8 until the next
/// world OSM re-extract; this reader is the migration. Module-private —
/// a one-column shim, not part of the general `col_*` accessor surface.
enum ColU16OrU8<'a> {
    U16(&'a UInt16Array),
    U8(&'a UInt8Array),
}

impl ColU16OrU8<'_> {
    fn value(&self, i: usize) -> u16 {
        match self {
            Self::U16(a) => a.value(i),
            Self::U8(a) => a.value(i) as u16,
        }
    }
}

fn col_u16_or_u8<'a>(b: &'a RecordBatch, name: &str) -> Option<ColU16OrU8<'a>> {
    let col = b.column_by_name(name)?.as_any();
    if let Some(a) = col.downcast_ref::<UInt16Array>() {
        return Some(ColU16OrU8::U16(a));
    }
    col.downcast_ref::<UInt8Array>().map(ColU16OrU8::U8)
}
pub fn col_str<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a StringArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_binary<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a BinaryArray> {
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

#[cfg(test)]
mod synth_load_tests {
    use super::*;
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::ipc::writer::FileWriter;
    use std::sync::Arc;

    /// Write a minimal synth_airport_lines.arrow file at `path`.
    /// Schema matches `aircraft-extract::arrow_schemas::synth_airport_lines_schema`
    /// for the column subset Step 1's runway-end resolver consults
    /// (start_lat / start_lon / end_lat / end_lon / aeroway_type +
    /// osm_id / segment_idx for grouping).
    fn write_synth(path: &Path) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("osm_id", DataType::UInt64, false),
            Field::new("segment_idx", DataType::UInt16, false),
            Field::new("airport_key", DataType::Utf8, false),
            Field::new("start_lat", DataType::Float64, false),
            Field::new("start_lon", DataType::Float64, false),
            Field::new("end_lat", DataType::Float64, false),
            Field::new("end_lon", DataType::Float64, false),
            Field::new("length_m", DataType::Float32, false),
            Field::new("heading_deg", DataType::Float32, false),
            Field::new("aeroway_type", DataType::UInt8, false),
            Field::new("name", DataType::Utf8, false),
        ]));
        let osm_id = UInt64Array::from(vec![1u64 << 63]);
        let seg_idx = UInt16Array::from(vec![0u16]);
        let key = StringArray::from(vec!["auto-x"]);
        let slat = Float64Array::from(vec![50.0_f64]);
        let slon = Float64Array::from(vec![14.0_f64]);
        let elat = Float64Array::from(vec![50.001_f64]);
        let elon = Float64Array::from(vec![14.0_f64]);
        let len = Float32Array::from(vec![100.0_f32]);
        let head = Float32Array::from(vec![0.0_f32]);
        let atype = UInt8Array::from(vec![7u8]);
        let name = StringArray::from(vec!["synth"]);
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(osm_id),
                Arc::new(seg_idx),
                Arc::new(key),
                Arc::new(slat),
                Arc::new(slon),
                Arc::new(elat),
                Arc::new(elon),
                Arc::new(len),
                Arc::new(head),
                Arc::new(atype),
                Arc::new(name),
            ],
        )
        .unwrap();
        let f = File::create(path).unwrap();
        let mut w = FileWriter::try_new(f, &schema).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
    }

    #[test]
    fn load_hex_reads_synth_airport_lines_when_present() {
        let dir = tempfile::tempdir().unwrap();
        write_synth(&dir.path().join("synth_airport_lines.arrow"));
        let hex = load_hex(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(hex.synth_airport_lines_batches.len(), 1);
        assert_eq!(hex.synth_airport_lines_batches[0].num_rows(), 1);
    }

    #[test]
    fn load_hex_returns_empty_synth_batches_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let hex = load_hex(dir.path().to_str().unwrap()).unwrap();
        assert!(hex.synth_airport_lines_batches.is_empty());
    }

    /// `col_u16_or_u8` must read both the new UInt16 rail `maxspeed`
    /// column and legacy UInt8 arrows (pre-2026-06 extracts) — the
    /// tolerant reader IS the schema migration.
    #[test]
    fn col_u16_or_u8_reads_both_widths() {
        let one_col = |field: Field, arr: ArrayRef| {
            RecordBatch::try_new(Arc::new(Schema::new(vec![field])), vec![arr]).unwrap()
        };
        let new = one_col(
            Field::new("maxspeed", DataType::UInt16, false),
            Arc::new(UInt16Array::from(vec![300u16])),
        );
        let legacy = one_col(
            Field::new("maxspeed", DataType::UInt8, false),
            Arc::new(UInt8Array::from(vec![120u8])),
        );
        assert_eq!(col_u16_or_u8(&new, "maxspeed").unwrap().value(0), 300);
        assert_eq!(col_u16_or_u8(&legacy, "maxspeed").unwrap().value(0), 120);
        assert!(col_u16_or_u8(&new, "missing").is_none());
    }
}
