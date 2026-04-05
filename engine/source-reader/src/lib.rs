//! source-reader: mmap'd Arrow IPC reader for noise popup.
//! Zero-copy: data stays in mmap'd pages, queries iterate directly over Arrow columns.

mod hex_store;
mod geo;

use std::collections::HashMap;
use std::sync::RwLock;
use napi_derive::napi;
use napi::{Error, Status};

use hex_store::{HexData, load_hex, query_roads_from_batches, query_railways_from_batches, query_buildings_from_batches, query_barriers_from_batches, query_aircraft_from_batches};

static STORE: std::sync::LazyLock<RwLock<HexStore>> =
    std::sync::LazyLock::new(|| RwLock::new(HexStore::new()));

static RASTERS: std::sync::OnceLock<raster_reader::RealRasters> = std::sync::OnceLock::new();

struct HexStore {
    hexes: HashMap<String, HexData>,
    h3r4_dir: String,
}

impl HexStore {
    fn new() -> Self {
        HexStore { hexes: HashMap::new(), h3r4_dir: String::new() }
    }

    fn ensure_hex(&mut self, hex_id: &str) -> &HexData {
        if !self.hexes.contains_key(hex_id) {
            let dir = format!("{}/{}", self.h3r4_dir, hex_id);
            match load_hex(&dir) {
                Ok(data) => { self.hexes.insert(hex_id.to_string(), data); }
                Err(e) => {
                    eprintln!("  source-reader: failed to load hex {}: {}", hex_id, e);
                    self.hexes.insert(hex_id.to_string(), HexData::empty());
                }
            }
        }
        self.hexes.get(hex_id).unwrap()
    }
}

#[napi]
pub fn source_init(h3r4_dir: String) -> napi::Result<String> {
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    store.h3r4_dir = h3r4_dir.clone();
    store.hexes.clear();

    // Init real rasters from source-data directory (parent of h3r4)
    let data_dir = std::path::Path::new(&h3r4_dir).parent().unwrap_or(std::path::Path::new("."));
    let rasters = raster_reader::RealRasters::new(data_dir);
    let has_dem = rasters.has_data();
    RASTERS.set(rasters).ok();

    Ok(format!("source-reader initialized: {h3r4_dir} (DEM: {})", if has_dem { "loaded" } else { "stub" }))
}

#[napi]
pub fn query_roads(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results = query_roads_from_batches(&data.road_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[napi]
pub fn query_buildings(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results = query_buildings_from_batches(&data.building_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[napi]
pub fn query_barriers(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);
        let mut results = query_barriers_from_batches(&data.barrier_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[napi]
pub fn reload_hexes(hex_ids: Vec<String>) -> napi::Result<u32> {
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    let mut n = 0u32;
    for hex_id in &hex_ids { store.hexes.remove(hex_id); n += 1; }
    Ok(n)
}

/// Compute full noise at a point using noise-compute engine.
/// Returns JSON with total Lden, per-source breakdown, top contributors.
#[napi]
pub fn query_noise_at_point(lat: f64, lng: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    let mut store = STORE.write().map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    // Collect all sources from 7 hexes
    let mut all_roads = Vec::new();
    let mut all_railways = Vec::new();
    let mut all_buildings = Vec::new();
    let mut all_industrial: Vec<noise_compute::types::PointSource> = Vec::new();
    let mut all_barriers = Vec::new();
    let mut all_aircraft = Vec::new();
    let n_days: u16 = 110; // Match pipeline --n-days (actual days in ADS-B dataset)

    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);

        // Railways
        let railways = query_railways_from_batches(&data.railway_batches, lat, lng, 8000.0);
        for r in railways {
            // Use enrichment data if available, otherwise defaults
            let rt = noise_compute::emission::railway::RailType::from_u8(r.rail_type);
            let (def_pax, def_frt) = noise_compute::emission::railway::default_traffic(rt, r.usage);
            let def_speed = noise_compute::emission::railway::default_speed(rt);

            all_railways.push(noise_compute::types::RailSegment {
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                start_lat: r.start_lat, start_lon: r.start_lon,
                end_lat: r.end_lat, end_lon: r.end_lon,
                length_m: r.length_m,
                rail_type: r.rail_type,
                usage: r.usage,
                maxspeed: r.maxspeed,
                trains_passenger: def_pax as i32,
                trains_freight: def_frt as i32,
                speed_kmh: if r.maxspeed > 0 { r.maxspeed } else { def_speed as u8 },
                track_count: 1,
                name: r.name.clone(),
                rail_ref: r.rail_ref.clone(),
                dist_m: r.dist_m,
                cp_lat: r.cp_lat, cp_lon: r.cp_lon,
                fraction: r.fraction,
            });
        }

        // Roads with distances pre-computed
        let roads = query_roads_from_batches(&data.road_batches, lat, lng, 10000.0);
        for r in roads {
            all_roads.push(noise_compute::types::RoadSegment {
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                start_lat: r.start_lat, start_lon: r.start_lon,
                end_lat: r.end_lat, end_lon: r.end_lon,
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
                dist_m: r.dist_m,
                cp_lat: r.cp_lat, cp_lon: r.cp_lon,
                fraction: r.fraction,
            });
        }

        // Buildings → PointSource (settlement)
        let buildings = query_buildings_from_batches(&data.building_batches, lat, lng, 2000.0);
        for b in buildings {
            let h = if b.height > 0.0 { b.height } else if b.floors > 0 { b.floors as f32 * 3.0 } else { 8.0 };
            let fl = if b.floors > 0 { b.floors } else { (h / 3.0).ceil() as u8 };

            let profile = noise_compute::emission::settlement::building_profile(b.building_type);
            let lw = noise_compute::emission::settlement::building_lw(&profile, 100.0, fl);
            if lw < 10.0 { continue; }

            let bands = noise_compute::emission::settlement::building_emission_bands(&profile, lw);
            let lw_f32: [f32; 8] = std::array::from_fn(|i| bands[i] as f32);

            // Evening/night period reduction
            let mut lw_eve = lw_f32;
            let mut lw_night = lw_f32;
            if b.building_type == 0 || b.building_type == 3 || b.building_type == 4 {
                for j in 0..8 { lw_eve[j] -= 3.0; lw_night[j] -= 8.0; }
            } else if b.building_type == 1 {
                for j in 0..8 { lw_eve[j] -= 5.0; lw_night[j] -= 15.0; }
            }

            // Build display name: "Name" or "Street Nr" or building type
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

            all_buildings.push(noise_compute::types::PointSource {
                osm_id: b.osm_id,
                lat: b.centroid_lat, lon: b.centroid_lon,
                source_height_m: h / 2.0,
                source_type: b.building_type,
                lw_day: lw_f32,
                lw_evening: lw_eve,
                lw_night: lw_night,
                n_points: 1,
                name: display_name,
                polygon_wkb: b.polygon_wkb.clone(),
                dist_m: b.dist_m,
            });
        }

        // Industrial → PointSource
        for batch in &data.industrial_batches {
            let n = batch.num_rows();
            let clat: Option<&arrow::array::Float64Array> = batch.column_by_name("centroid_lat").and_then(|c| c.as_any().downcast_ref());
            let clon: Option<&arrow::array::Float64Array> = batch.column_by_name("centroid_lon").and_then(|c| c.as_any().downcast_ref());
            let (Some(clat), Some(clon)) = (clat, clon) else { continue };
            let stype: Option<&arrow::array::UInt8Array> = batch.column_by_name("source_type").and_then(|c| c.as_any().downcast_ref());
            let hub_h: Option<&arrow::array::Float32Array> = batch.column_by_name("hub_height").and_then(|c| c.as_any().downcast_ref());
            let power: Option<&arrow::array::Float32Array> = batch.column_by_name("rated_power_kw").and_then(|c| c.as_any().downcast_ref());
            let ind_name: Option<&arrow::array::StringArray> = batch.column_by_name("name").and_then(|c| c.as_any().downcast_ref());

            for i in 0..n {
                let c_lat = clat.value(i);
                let c_lon = clon.value(i);
                let dist = crate::geo::flat_dist(lat, lng, c_lat, c_lon);
                if dist > 5000.0 { continue; }

                let st = stype.map(|a| a.value(i)).unwrap_or(0);

                if st == 10 {
                    // Wind turbine
                    let hub = hub_h.and_then(|a| { let v = a.value(i); if v > 0.0 { Some(v) } else { None }}).unwrap_or(80.0);
                    let kw = power.and_then(|a| { let v = a.value(i); if v > 0.0 { Some(v) } else { None }}).unwrap_or(2000.0);
                    let (lw, bands) = noise_compute::emission::wind::wind_turbine_emission(kw as f64);
                    if lw < 10.0 { continue; }
                    let em: [f32; 8] = std::array::from_fn(|j| bands[j] as f32);
                    let iname = ind_name.map(|a| a.value(i).to_string()).unwrap_or_default();
                    all_industrial.push(noise_compute::types::PointSource {
                        osm_id: batch.column_by_name("osm_id").and_then(|c| c.as_any().downcast_ref::<arrow::array::Int64Array>()).map(|a| a.value(i)).unwrap_or(0),
                        lat: c_lat, lon: c_lon,
                        source_height_m: hub,
                        source_type: st,
                        lw_day: em, lw_evening: em, lw_night: em,
                        n_points: 1, name: iname, polygon_wkb: String::new(), dist_m: dist,
                    });
                } else {
                    // Industrial site
                    let profile = noise_compute::emission::industrial::industrial_profile(st);
                    let lw = noise_compute::emission::industrial::industrial_lw(&profile, 10000.0);
                    if lw < 10.0 { continue; }
                    let bands = noise_compute::emission::industrial::industrial_emission_bands(&profile, lw);
                    let em: [f32; 8] = std::array::from_fn(|j| bands[j] as f32);
                    let mut em_night = em;
                    for j in 0..8 { em_night[j] -= 3.0; }
                    let iname = ind_name.map(|a| a.value(i).to_string()).unwrap_or_default();
                    all_industrial.push(noise_compute::types::PointSource {
                        osm_id: batch.column_by_name("osm_id").and_then(|c| c.as_any().downcast_ref::<arrow::array::Int64Array>()).map(|a| a.value(i)).unwrap_or(0),
                        lat: c_lat, lon: c_lon,
                        source_height_m: 1.5,
                        source_type: st,
                        lw_day: em, lw_evening: em, lw_night: em_night,
                        n_points: 1, name: iname, polygon_wkb: String::new(), dist_m: dist,
                    });
                }
            }
        }

        let barriers = query_barriers_from_batches(&data.barrier_batches, lat, lng, 500.0);
        for b in barriers {
            all_barriers.push(noise_compute::types::Barrier {
                osm_id: b.osm_id,
                height_m: b.height,
                lat: b.lat, lon: b.lon,
                dist_m: b.dist_m,
            });
        }

        // Aircraft segments (all segments in hex — Doc 29 handles distance cutoff)
        let aircraft = query_aircraft_from_batches(&data.aircraft_batches, lat, lng);
        for a in aircraft {
            all_aircraft.push(noise_compute::types::AircraftSegment {
                flight_id: a.flight_id,
                profile_idx: a.profile_idx,
                is_departure: a.is_departure,
                period: a.period,
                date_id: a.date_id,
                start_lat: a.start_lat, start_lon: a.start_lon,
                start_alt_m: a.start_alt_m,
                end_lat: a.end_lat, end_lon: a.end_lon,
                end_alt_m: a.end_alt_m,
                speed_kt: a.speed_kt,
                segment_length_m: a.segment_length_m,
            });
        }
    }

    // Build receiver
    // Use real rasters if available, otherwise stub
    let stub = StubRasters;
    let real_rasters = RASTERS.get();
    let rasters: &dyn noise_compute::types::RasterSampler = match real_rasters {
        Some(r) => r,
        None => &stub,
    };
    let elevation = rasters.elevation(lat, lng);
    let receiver = noise_compute::types::Receiver::new(lat, lng, elevation);

    // Compute noise
    let config = noise_compute::types::ComputeConfig {
        n_days,
        ..Default::default()
    };
    let result = noise_compute::compute_at_point(
        &receiver,
        &all_roads,
        &all_railways,
        &all_buildings,
        &all_industrial,
        &all_aircraft,
        &all_barriers,
        rasters,
        &config,
    );

    Ok(serde_json::to_string(&result).unwrap())
}

/// Stub raster sampler — flat terrain, no buildings, no vegetation.
/// TODO: Replace with real SRTM/Copernicus raster reader.
struct StubRasters;

use noise_compute::types::RasterSampler;

impl RasterSampler for StubRasters {
    fn elevation(&self, _lat: f64, _lon: f64) -> f64 { 200.0 }
    fn building_height(&self, _: f64, _: f64) -> f64 { 0.0 }
    fn vegetation_depth(&self, _: f64, _: f64, _: f64, _: f64) -> f64 { 0.0 }
    fn ground_g(&self, _: f64, _: f64) -> f64 { 0.5 }
    fn ground_g_path(&self, _: f64, _: f64, _: f64, _: f64) -> f64 { 0.5 }
    fn terrain_profile(&self, _: f64, _: f64, _: f64, _: f64, steps: usize) -> Vec<f64> { vec![200.0; steps] }
    fn building_enclosure(&self, _: f64, _: f64) -> f64 { 0.0 }
}
