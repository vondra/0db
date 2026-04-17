//! source-reader: mmap'd Arrow IPC reader for noise popup.
//! Zero-copy: data stays in mmap'd pages, queries iterate directly over Arrow columns.

mod geo;
mod hex_store;

#[cfg(feature = "node")]
use napi::{Error, Status};
#[cfg(feature = "node")]
use napi_derive::napi;
#[cfg(feature = "node")]
use std::collections::HashMap;
use std::path::Path;
#[cfg(feature = "node")]
use std::sync::RwLock;

#[cfg(feature = "node")]
use hex_store::HexData;
use hex_store::{
    hex_encode, load_hex, query_airport_areas_from_batches, query_airport_lines_from_batches,
    query_barriers_from_batches, query_buildings_from_batches, query_railways_from_batches,
    query_roads_from_batches, visit_aircraft_from_batches,
};

#[cfg(feature = "node")]
static STORE: std::sync::LazyLock<RwLock<HexStore>> =
    std::sync::LazyLock::new(|| RwLock::new(HexStore::new()));

#[cfg(feature = "node")]
static RASTERS: std::sync::OnceLock<raster_reader::RealRasters> = std::sync::OnceLock::new();

// NACE codes are now baked into industrial.arrow (nace_4digit UInt16 column).
// No global lookup needed at runtime.

const AIRCRAFT_QUERY_MAX_RADIUS_M: f64 =
    noise_compute::emission::aircraft::AIRCRAFT_NPD_REACH_CAP_M;
const AIRPORT_CONTEXT_RADIUS_M: f64 = 5_000.0;

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

#[cfg(feature = "node")]
struct HexStore {
    hexes: HashMap<String, HexData>,
    h3r4_dir: String,
}

#[cfg(feature = "node")]
impl HexStore {
    fn new() -> Self {
        HexStore {
            hexes: HashMap::new(),
            h3r4_dir: String::new(),
        }
    }

    fn ensure_hex(&mut self, hex_id: &str) -> &HexData {
        if !self.hexes.contains_key(hex_id) {
            let dir = format!("{}/{}", self.h3r4_dir, hex_id);
            match load_hex(&dir) {
                Ok(data) => {
                    self.hexes.insert(hex_id.to_string(), data);
                }
                Err(e) => {
                    eprintln!("  source-reader: failed to load hex {}: {}", hex_id, e);
                    self.hexes.insert(hex_id.to_string(), HexData::empty());
                }
            }
        }
        self.hexes.get(hex_id).unwrap()
    }
}

#[derive(Debug)]
pub struct PointQueryData {
    pub roads: Vec<noise_compute::types::RoadSegment>,
    pub railways: Vec<noise_compute::types::RailSegment>,
    pub buildings: Vec<noise_compute::types::PointSource>,
    pub industrial: Vec<noise_compute::types::PointSource>,
    pub aircraft: Vec<noise_compute::types::AircraftSegment>,
    pub airport_lines: Vec<noise_compute::types::AirportLine>,
    pub airport_areas: Vec<noise_compute::types::AirportArea>,
    pub barriers: Vec<noise_compute::types::Barrier>,
    pub n_days: u16,
}

// load_nace_lookup_json removed — NACE codes baked into industrial.arrow

pub fn collect_sources_at_point(
    h3r4_dir: &Path,
    lat: f64,
    lng: f64,
) -> Result<PointQueryData, String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let data_dir = h3r4_dir
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(Path::new("."));
    let rasters = raster_reader::RealRasters::new(data_dir);

    let loaded: Vec<hex_store::HexData> = hex_ids
        .iter()
        .map(|id| load_hex(&h3r4_dir.join(id).to_string_lossy()))
        .collect::<Result<_, _>>()?;
    let refs: Vec<&hex_store::HexData> = loaded.iter().collect();

    Ok(collect_from_hex_data(
        &refs,
        lat,
        lng,
        &rasters,
    ))
}

/// Shared source collection logic. Takes pre-loaded hex data.
/// Both `collect_sources_at_point` and `query_noise_at_point` delegate here.
/// NACE codes are read directly from industrial.arrow nace_4digit column.
fn collect_from_hex_data(
    hex_data: &[&hex_store::HexData],
    lat: f64,
    lng: f64,
    rasters: &dyn noise_compute::types::RasterSampler,
) -> PointQueryData {
    let receiver_elev_m = rasters.elevation(lat, lng);
    let mut all_roads = Vec::new();
    let mut all_railways = Vec::new();
    let mut all_buildings = Vec::new();
    let mut all_industrial = Vec::new();
    let mut all_barriers = Vec::new();
    let mut all_aircraft = Vec::new();
    let mut all_airport_lines = Vec::new();
    let mut all_airport_areas = Vec::new();
    let mut saw_aircraft_batches = false;
    let mut any_aircraft_needs_runtime_ground_prepare = false;

    let mut date_ids = std::collections::HashSet::new();
    for data in hex_data {
        if !data.aircraft_batches.is_empty() {
            saw_aircraft_batches = true;
            any_aircraft_needs_runtime_ground_prepare |=
                !hex_store::aircraft_has_precomputed_ground(&data.aircraft_batches);
        }
        for batch in &data.aircraft_batches {
            if let Some(did) = batch
                .column_by_name("date_id")
                .and_then(|c| c.as_any().downcast_ref::<arrow::array::Int16Array>())
            {
                for i in 0..did.len() {
                    date_ids.insert(did.value(i));
                }
            }
        }
    }
    let n_days = if date_ids.is_empty() {
        365
    } else {
        date_ids.len() as u16
    };

    for data in hex_data {
        let airport_lines = query_airport_lines_from_batches(
            &data.airport_line_batches,
            lat,
            lng,
            AIRPORT_CONTEXT_RADIUS_M,
        );
        for line in airport_lines {
            all_airport_lines.push(noise_compute::types::AirportLine {
                osm_id: line.osm_id,
                aeroway_type: line.aeroway_type,
                name: line.name.clone(),
                airport_key: airport_key(&line.name, &line.airport_ref, &line.icao, &line.iata),
                start_lat: line.start_lat,
                start_lon: line.start_lon,
                end_lat: line.end_lat,
                end_lon: line.end_lon,
                width_m: line.width_m,
            });
        }

        let airport_areas = query_airport_areas_from_batches(
            &data.airport_area_batches,
            lat,
            lng,
            AIRPORT_CONTEXT_RADIUS_M,
        );
        for area in airport_areas {
            all_airport_areas.push(noise_compute::types::AirportArea {
                osm_id: area.osm_id,
                aeroway_type: area.aeroway_type,
                name: area.name.clone(),
                airport_key: airport_key(&area.name, &area.airport_ref, &area.icao, &area.iata),
                centroid_lat: area.centroid_lat,
                centroid_lon: area.centroid_lon,
                polygon_wkb: area.polygon_wkb,
                area_m2: area.area_m2,
            });
        }
    }
    for data in hex_data {
        let railways = query_railways_from_batches(&data.railway_batches, lat, lng, noise_compute::constants::RAILWAY_MAX_RADIUS);
        for r in railways {
            let norm =
                noise_compute::normalize::normalize_rail(noise_compute::normalize::RawRailInput {
                    rail_type: r.rail_type,
                    usage: r.usage,
                    maxspeed: r.maxspeed,
                    service: r.service,
                    highspeed: r.highspeed,
                    trains_passenger: r.trains_passenger,
                    trains_freight: r.trains_freight,
                    parallel_divisor: r.parallel_divisor,
                });
            let trains_passenger_source: u8 = if r.trains_passenger > 0 { 0 } else { 1 };
            let trains_freight_source: u8 = if r.trains_freight > 0 { 0 } else { 1 };
            let speed_source: u8 = if r.maxspeed > 0 {
                0
            } else if r.highspeed {
                1
            } else {
                2
            };

            all_railways.push(noise_compute::types::RailSegment {
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                start_lat: r.start_lat,
                start_lon: r.start_lon,
                end_lat: r.end_lat,
                end_lon: r.end_lon,
                length_m: r.length_m,
                rail_type: r.rail_type,
                usage: r.usage,
                maxspeed: r.maxspeed,
                trains_passenger: norm.popup_passenger_per_day(),
                trains_freight: norm.popup_freight_per_day(),
                speed_kmh: norm.speed_kmh as u8,
                track_count: 1,
                name: r.name.clone(),
                rail_ref: r.rail_ref.clone(),
                bridge: r.bridge,
                tunnel: r.tunnel,
                service: r.service > 0,
                highspeed: r.highspeed,
                parallel_divisor: r.parallel_divisor.max(1),
                speed_source,
                trains_passenger_source,
                trains_freight_source,
                dist_m: r.dist_m,
                cp_lat: r.cp_lat,
                cp_lon: r.cp_lon,
                fraction: r.fraction,
            });
        }

        let roads = query_roads_from_batches(&data.road_batches, lat, lng, noise_compute::constants::ROAD_MAX_RADIUS[0]);
        for r in roads {
            all_roads.push(noise_compute::types::RoadSegment {
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                start_lat: r.start_lat,
                start_lon: r.start_lon,
                end_lat: r.end_lat,
                end_lon: r.end_lon,
                length_m: r.length_m,
                road_class: r.road_class,
                speed_limit: r.speed_limit,
                surface_type: r.surface_type,
                oneway: r.oneway,
                lanes: r.lanes,
                aadt_light: r.aadt_light,
                aadt_medium: r.aadt_medium,
                aadt_heavy: r.aadt_heavy,
                aadt_moto: r.aadt_moto,
                traffic_source: r.traffic_source,
                name: r.name.clone(),
                road_ref: r.road_ref.clone(),
                bridge: r.bridge,
                tunnel: r.tunnel,
                access: r.access,
                junction: r.junction,
                dist_m: r.dist_m,
                cp_lat: r.cp_lat,
                cp_lon: r.cp_lon,
                fraction: r.fraction,
            });
        }

        let buildings = query_buildings_from_batches(&data.building_batches, lat, lng, 2000.0);
        for b in buildings {
            let display_name = if !b.name.is_empty() {
                b.name.clone()
            } else if !b.addr_street.is_empty() {
                if !b.addr_housenumber.is_empty() {
                    format!("{} {}", b.addr_street, b.addr_housenumber)
                } else {
                    b.addr_street.clone()
                }
            } else {
                String::new()
            };

            let prepared_points = noise_compute::normalize::prepare_building_points(
                noise_compute::normalize::RawBuildingInput {
                    centroid_lat: b.centroid_lat,
                    centroid_lon: b.centroid_lon,
                    height_m: b.height,
                    floors: b.floors,
                    building_type: b.building_type,
                    area_m2: (b.area_m2 > 0.0).then_some(b.area_m2 as f64),
                    polygon_wkb: &b.polygon_wkb,
                },
            );
            for prepared in prepared_points {
                let pt_dist = crate::geo::flat_dist(lat, lng, prepared.lat, prepared.lon);
                all_buildings.push(prepared.with_metadata(
                    b.osm_id,
                    b.building_type,
                    display_name.clone(),
                    b.polygon_wkb.clone(),
                    pt_dist,
                ));
            }
        }

        for batch in &data.industrial_batches {
            let n = batch.num_rows();
            let clat: Option<&arrow::array::Float64Array> = batch
                .column_by_name("centroid_lat")
                .and_then(|c| c.as_any().downcast_ref());
            let clon: Option<&arrow::array::Float64Array> = batch
                .column_by_name("centroid_lon")
                .and_then(|c| c.as_any().downcast_ref());
            let (Some(clat), Some(clon)) = (clat, clon) else {
                continue;
            };
            let stype: Option<&arrow::array::UInt8Array> = batch
                .column_by_name("source_type")
                .and_then(|c| c.as_any().downcast_ref());
            let hub_h: Option<&arrow::array::Float32Array> = batch
                .column_by_name("hub_height")
                .and_then(|c| c.as_any().downcast_ref());
            let power: Option<&arrow::array::Float32Array> = batch
                .column_by_name("rated_power_kw")
                .and_then(|c| c.as_any().downcast_ref());
            let ind_name: Option<&arrow::array::StringArray> = batch
                .column_by_name("name")
                .and_then(|c| c.as_any().downcast_ref());
            let wkb_col: Option<&arrow::array::BinaryArray> = batch
                .column_by_name("polygon_wkb")
                .and_then(|c| c.as_any().downcast_ref());
            let area_col: Option<&arrow::array::Float32Array> = batch
                .column_by_name("area_m2")
                .and_then(|c| c.as_any().downcast_ref());

            for i in 0..n {
                let c_lat = clat.value(i);
                let c_lon = clon.value(i);
                let dist = crate::geo::flat_dist(lat, lng, c_lat, c_lon);
                if dist > 5000.0 {
                    continue;
                }

                let st = stype.map(|a| a.value(i)).unwrap_or(0);
                let iname = ind_name.map(|a| a.value(i).to_string()).unwrap_or_default();
                let osm_id = batch
                    .column_by_name("osm_id")
                    .and_then(|c| c.as_any().downcast_ref::<arrow::array::Int64Array>())
                    .map(|a| a.value(i))
                    .unwrap_or(0);
                let wkb_hex = if st == 10 {
                    String::new()
                } else {
                    wkb_col.map(|a| hex_encode(a.value(i))).unwrap_or_default()
                };
                let area_m2 = area_col.and_then(|a| {
                    let v = a.value(i);
                    if v > 0.0 {
                        Some(v as f64)
                    } else {
                        None
                    }
                });

                let sub = batch.column_by_name("site_subtype")
                    .and_then(|c| c.as_any().downcast_ref::<arrow::array::UInt8Array>())
                    .map(|a| a.value(i))
                    .unwrap_or(0);
                let prepared_points = noise_compute::normalize::prepare_industrial_points(
                    noise_compute::normalize::RawIndustrialInput {
                        centroid_lat: c_lat,
                        centroid_lon: c_lon,
                        source_type: st,
                        site_subtype: sub,
                        hub_height_m: hub_h.and_then(|a| {
                            let value = a.value(i);
                            if value > 0.0 {
                                Some(value)
                            } else {
                                None
                            }
                        }),
                        rated_power_kw: power.and_then(|a| {
                            let value = a.value(i);
                            if value > 0.0 {
                                Some(value)
                            } else {
                                None
                            }
                        }),
                        area_m2,
                        polygon_wkb: &wkb_hex,
                        nace_4digit: batch.column_by_name("nace_4digit")
                            .and_then(|c| c.as_any().downcast_ref::<arrow::array::UInt16Array>())
                            .map(|a| a.value(i))
                            .filter(|&v| v > 0),
                    },
                );
                for prepared in prepared_points {
                    let pt_dist = crate::geo::flat_dist(lat, lng, prepared.lat, prepared.lon);
                    all_industrial.push(prepared.with_metadata(
                        osm_id,
                        st,
                        iname.clone(),
                        wkb_hex.clone(),
                        pt_dist,
                    ));
                }
            }
        }

        // 10 km matches the road source radius — barriers along the full source→receiver
        // path are needed for screening, not just near the receiver.
        let barriers = query_barriers_from_batches(&data.barrier_batches, lat, lng, 10_000.0);
        for b in barriers {
            all_barriers.push(noise_compute::types::Barrier {
                osm_id: b.osm_id,
                height_m: b.height,
                lat: b.lat,
                lon: b.lon,
                dist_m: b.dist_m,
            });
        }

        let cached_segs = data.aircraft_cache.get_or_init(|| {
            let mut hex_aircraft = Vec::new();
            
            for batch in &data.aircraft_batches {
                let n = batch.num_rows();
                let fid = hex_store::col_u64(batch, "flight_id");
                let pidx = hex_store::col_u8(batch, "profile_idx");
                let dep = hex_store::col_bool(batch, "is_departure");
                let on_ground = hex_store::col_bool(batch, "on_ground");
                let per = hex_store::col_u8(batch, "period");
                let did = hex_store::col_i16(batch, "date_id");
                let slat = hex_store::col_f64(batch, "start_lat");
                let slon = hex_store::col_f64(batch, "start_lon");
                let salt = hex_store::col_f32(batch, "start_alt_m");
                let elat = hex_store::col_f64(batch, "end_lat");
                let elon = hex_store::col_f64(batch, "end_lon");
                let ealt = hex_store::col_f32(batch, "end_alt_m");
                let spd = hex_store::col_f32(batch, "speed_kt");
                let slen = hex_store::col_f32(batch, "segment_length_m");
                let gctx = hex_store::col_u8(batch, "ground_context");
                let gops = hex_store::col_u8(batch, "ground_ops_kind");

                let (Some(fid), Some(slat), Some(slon), Some(salt), Some(elat), Some(elon), Some(ealt)) =
                    (fid, slat, slon, salt, elat, elon, ealt) else { continue; };

                for i in 0..n {
                    hex_aircraft.push(noise_compute::types::AircraftSegment {
                        flight_id: fid.value(i),
                        profile_idx: pidx.map(|a| a.value(i)).unwrap_or(0),
                        is_departure: dep.map(|a| a.value(i)).unwrap_or(false),
                        on_ground: on_ground.map(|a| a.value(i)).unwrap_or(false),
                        period: per.map(|a| a.value(i)).unwrap_or(0),
                        date_id: did.map(|a| a.value(i)).unwrap_or(0),
                        start_lat: slat.value(i),
                        start_lon: slon.value(i),
                        start_alt_m: salt.value(i),
                        end_lat: elat.value(i),
                        end_lon: elon.value(i),
                        end_alt_m: ealt.value(i),
                        speed_kt: spd.map(|a| a.value(i)).unwrap_or(0.0),
                        segment_length_m: slen.map(|a| a.value(i)).unwrap_or(0.0),
                        count_weight: 1.0,
                        surface_model: false,
                        ground_context: gctx.map(|a| a.value(i)).unwrap_or(noise_compute::emission::aircraft::GROUND_CONTEXT_NONE),
                        ground_ops_kind: gops.map(|a| a.value(i)).unwrap_or(noise_compute::emission::aircraft::GROUND_OPS_KIND_NONE),
                    });
                }
            }
            hex_aircraft
        });

        let tree = data.aircraft_tree.get_or_init(|| {
            let entries = cached_segs.iter().enumerate().map(|(idx, seg)| {
                hex_store::AircraftEntry {
                    cache_idx: idx,
                    lat: (seg.start_lat + seg.end_lat) * 0.5,
                    lon: (seg.start_lon + seg.end_lon) * 0.5,
                }
            }).collect();
            rstar::RTree::bulk_load(entries)
        });

        // To guarantee 100% accuracy matching the original flat_dist logic:
        // 1. Calculate latitude/longitude bounding box accounting for projection.
        let radius_lat_deg = AIRCRAFT_QUERY_MAX_RADIUS_M / 111_320.0;
        let cos_lat = lat.to_radians().cos().max(0.01);
        let radius_lon_deg = radius_lat_deg / cos_lat;
        
        let env = rstar::AABB::from_corners(
            [lat - radius_lat_deg, lng - radius_lon_deg],
            [lat + radius_lat_deg, lng + radius_lon_deg],
        );

        // 2. Query R-Tree and rigorously filter by exact flat_dist
        for entry in tree.locate_in_envelope_intersecting(&env) {
            let seg = &cached_segs[entry.cache_idx];
            let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
            let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
            let dist_m = crate::geo::flat_dist(lat, lng, mid_lat, mid_lon);
            if dist_m <= AIRCRAFT_QUERY_MAX_RADIUS_M {
                all_aircraft.push(seg.clone());
            }
        }
    }

    if saw_aircraft_batches && any_aircraft_needs_runtime_ground_prepare {
        noise_compute::emission::aircraft::prepare_ground_context(
            &mut all_aircraft,
            &all_airport_lines,
            &all_airport_areas,
            rasters,
            n_days,
        );
    }
    all_aircraft.retain(|seg| {
        !noise_compute::emission::aircraft::is_ground_stale_segment(seg, rasters)
    });

    let mut airport_surface =
        noise_compute::emission::aircraft::synthesize_airport_surface_segments(
            &all_aircraft,
            &all_airport_lines,
            &all_airport_areas,
            rasters,
            n_days,
        );
    all_aircraft.append(&mut airport_surface);

    all_barriers.sort_unstable_by(|a, b| {
        a.dist_m
            .partial_cmp(&b.dist_m)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    PointQueryData {
        roads: all_roads,
        railways: all_railways,
        buildings: all_buildings,
        industrial: all_industrial,
        aircraft: all_aircraft,
        airport_lines: all_airport_lines,
        airport_areas: all_airport_areas,
        barriers: all_barriers,
        n_days,
    }
}

#[cfg(feature = "node")]
#[napi]
pub fn source_init(h3r4_dir: String) -> napi::Result<String> {
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    store.h3r4_dir = h3r4_dir.clone();
    store.hexes.clear();

    // Rasters are at data/prepared/{dem,rasters}/ — two levels up from data/prepared/{year}/h3r4/
    let h3r4_path = std::path::Path::new(&h3r4_dir);
    let data_dir = h3r4_path
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(std::path::Path::new("."));
    let rasters = raster_reader::RealRasters::new(data_dir);
    let has_dem = rasters.has_data();
    RASTERS.set(rasters).ok();

    // NACE codes are baked into industrial.arrow — no global JSON needed

    Ok(format!(
        "source-reader initialized: {h3r4_dir} (DEM: {})",
        if has_dem { "loaded" } else { "stub" },
    ))
}

#[cfg(feature = "node")]
#[napi]
pub fn query_roads(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results = query_roads_from_batches(&data.road_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_airport_lines(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results =
            query_airport_lines_from_batches(&data.airport_line_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_airport_areas(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results =
            query_airport_areas_from_batches(&data.airport_area_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_buildings(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results =
            query_buildings_from_batches(&data.building_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_barriers(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results =
            query_barriers_from_batches(&data.barrier_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn reload_hexes(hex_ids: Vec<String>) -> napi::Result<u32> {
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    let mut n = 0u32;
    for hex_id in &hex_ids {
        store.hexes.remove(hex_id);
        n += 1;
    }
    Ok(n)
}

/// Compute full noise at a point using noise-compute engine.
/// Returns JSON with total Lden, per-source breakdown, top contributors.
#[cfg(feature = "node")]
#[napi]
pub fn query_noise_at_point(lat: f64, lng: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    // Pre-load all hexes, then collect refs for the shared helper.
    for hex_id in &hex_ids {
        store.ensure_hex(hex_id);
    }
    let hex_refs: Vec<&hex_store::HexData> = hex_ids
        .iter()
        .filter_map(|id| store.hexes.get(id.as_str()))
        .collect();

    let stub = StubRasters;
    let real_rasters = RASTERS.get();
    let rasters: &dyn noise_compute::types::RasterSampler = match real_rasters {
        Some(r) => r,
        None => &stub,
    };
    let sources = collect_from_hex_data(&hex_refs, lat, lng, rasters);
    drop(store);

    // Build receiver
    let elevation = rasters.elevation(lat, lng);
    let receiver = noise_compute::types::Receiver::new(lat, lng, elevation);

    let config = noise_compute::types::ComputeConfig {
        n_days: sources.n_days,
        ..Default::default()
    };
    let result = noise_compute::compute_at_point_with_airports(
        &receiver,
        &sources.roads,
        &sources.railways,
        &sources.buildings,
        &sources.industrial,
        &sources.aircraft,
        &sources.airport_lines,
        &sources.airport_areas,
        &sources.barriers,
        rasters,
        &config,
    );

    Ok(serde_json::to_string(&result).unwrap())
}

/// Stub raster sampler — flat terrain, no buildings, no vegetation.
/// Used as fallback when DEM/raster tiles are not available on disk.
#[cfg(feature = "node")]
struct StubRasters;

#[cfg(feature = "node")]
use noise_compute::types::RasterSampler;

#[cfg(feature = "node")]
impl RasterSampler for StubRasters {
    fn elevation(&self, _lat: f64, _lon: f64) -> f64 {
        200.0
    }
    fn building_height(&self, _: f64, _: f64) -> f64 {
        0.0
    }
    fn vegetation_depth(&self, _: f64, _: f64, _: f64, _: f64) -> f64 {
        0.0
    }
    fn ground_g(&self, _: f64, _: f64) -> f64 {
        0.5
    }
    fn ground_g_path(&self, _: f64, _: f64, _: f64, _: f64) -> f64 {
        0.5
    }
    fn terrain_profile(&self, _: f64, _: f64, _: f64, _: f64, steps: usize) -> Vec<f64> {
        vec![200.0; steps]
    }
    fn building_enclosure(&self, _: f64, _: f64) -> f64 {
        0.0
    }
}
