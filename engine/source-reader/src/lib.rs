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

// NACE lookup: osm_id → nace_2digit code (from IRZ/E-PRTR enrichment).
// WHY: OSM gives generic "landuse=industrial". NACE enables sector-specific
// emission profiles (metallurgy 78 dB vs warehouse 60 dB).
// Loaded from data/prepared/nace-lookup.json during source_init.
static NACE_LOOKUP: std::sync::OnceLock<HashMap<i64, u8>> = std::sync::OnceLock::new();

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

    // Rasters are at data/prepared/{dem,rasters}/ — two levels up from data/prepared/{year}/h3r4/
    let h3r4_path = std::path::Path::new(&h3r4_dir);
    let data_dir = h3r4_path.parent().and_then(|p| p.parent()).unwrap_or(std::path::Path::new("."));
    let rasters = raster_reader::RealRasters::new(data_dir);
    let has_dem = rasters.has_data();
    RASTERS.set(rasters).ok();

    // Load NACE lookup from JSON (at data/prepared/nace-lookup.json)
    let nace_path = data_dir.join("nace-lookup.json");
    let nace_count = if nace_path.exists() {
        let json_str = std::fs::read_to_string(&nace_path).unwrap_or_default();
        let raw: HashMap<String, serde_json::Value> = serde_json::from_str(&json_str).unwrap_or_default();
        let mut lookup = HashMap::new();
        for (osm_id_str, val) in &raw {
            if let (Ok(osm_id), Some(nace_str)) = (osm_id_str.parse::<i64>(), val.get("nace").and_then(|v| v.as_str())) {
                // Parse NACE 2-digit code: "241000" → 24, "382200" → 38
                if let Ok(nace_full) = nace_str.parse::<u32>() {
                    let nace_2 = (nace_full / 10000) as u8;
                    if nace_2 > 0 { lookup.insert(osm_id, nace_2); }
                }
            }
        }
        let count = lookup.len();
        NACE_LOOKUP.set(lookup).ok();
        count
    } else { 0 };

    Ok(format!("source-reader initialized: {h3r4_dir} (DEM: {}, NACE: {})", if has_dem { "loaded" } else { "stub" }, nace_count))
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
    // Derive n_days from actual aircraft data (count unique date_ids across all hexes)
    let n_days: u16 = {
        let mut date_ids = std::collections::HashSet::new();
        for hex_id in &hex_ids {
            let data = store.ensure_hex(hex_id);
            for batch in &data.aircraft_batches {
                if let Some(did) = batch.column_by_name("date_id")
                    .and_then(|c| c.as_any().downcast_ref::<arrow::array::Int16Array>())
                {
                    for i in 0..did.len() { date_ids.insert(did.value(i)); }
                }
            }
        }
        if date_ids.is_empty() { 365 } else { date_ids.len() as u16 }
    };

    for hex_id in &hex_ids {
        let data = store.ensure_hex(hex_id);

        // Railways
        let railways = query_railways_from_batches(&data.railway_batches, lat, lng, 8000.0);
        for r in railways {
            let rt = noise_compute::emission::railway::RailType::from_u8(r.rail_type);
            let (def_pax, def_frt) = noise_compute::emission::railway::default_traffic(rt, r.usage);
            let def_speed = noise_compute::emission::railway::default_speed(rt);
            let svc_factor = if r.service > 0 { 0.02 } else { 1.0 };
            let divisor = r.parallel_divisor.max(1) as f64;
            let sf = svc_factor / divisor;

            // Enriched counts from Arrow, with defaults fallback (matching pipeline)
            let trains_passenger_source: u8 = if r.trains_passenger > 0 { 0 } else { 1 };
            let trains_freight_source: u8 = if r.trains_freight > 0 { 0 } else { 1 };
            let q_pax = if r.trains_passenger > 0 { r.trains_passenger as f64 } else { def_pax };
            let q_frt = if r.trains_freight > 0 { r.trains_freight as f64 } else { def_frt };
            let (speed, speed_source): (f64, u8) = if r.maxspeed > 0 {
                (r.maxspeed as f64, 0)          // 0 = osm_maxspeed
            } else if r.highspeed {
                (300.0, 1)                      // 1 = highspeed_default
            } else {
                (def_speed, 2)                  // 2 = type_default
            };

            all_railways.push(noise_compute::types::RailSegment {
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                start_lat: r.start_lat, start_lon: r.start_lon,
                end_lat: r.end_lat, end_lon: r.end_lon,
                length_m: r.length_m,
                rail_type: r.rail_type,
                usage: r.usage,
                maxspeed: r.maxspeed,
                trains_passenger: (q_pax * sf) as i32,
                trains_freight: (q_frt * sf) as i32,
                speed_kmh: speed as u8,
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
                access: r.access,
                junction: r.junction,
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
            // Building area from WKB polygon (was hardcoded 100 m²).
            // WHY: A 5000 m² shopping mall had same Lw as a 100 m² house.
            // area_m2 field from hex_store, or compute from WKB, or fallback 100 m².
            let area = if b.area_m2 > 0.0 { b.area_m2 as f64 } else {
                noise_compute::wkb::wkb_area_m2(&b.polygon_wkb).unwrap_or(100.0)
            };
            let lw = noise_compute::emission::settlement::building_lw(&profile, area, fl);
            if lw < 10.0 { continue; }

            let bands = noise_compute::emission::settlement::building_emission_bands(&profile, lw);
            let lw_f32: [f32; 8] = std::array::from_fn(|i| bands[i] as f32);

            // Evening/night reduction from profile (matches pipeline).
            let mut lw_eve = lw_f32;
            let mut lw_night = lw_f32;
            for j in 0..8 {
                lw_eve[j] += profile.evening_offset as f32;
                lw_night[j] += profile.night_offset as f32;
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

            // Distributed points for large buildings (>2000 m²).
            // WHY: Shopping malls, hospitals, schools have facades on all sides.
            // Single centroid misrepresents spatial emission pattern.
            // Grid spacing 30m for buildings (finer than 150m for industrial).
            let grid_spacing = if area > 2000.0 { 30.0 } else { 0.0 };
            let grid_points = if grid_spacing > 0.0 {
                let pts = noise_compute::wkb::wkb_grid_points(&b.polygon_wkb, grid_spacing);
                if pts.len() > 1 { pts } else { vec![(b.centroid_lat, b.centroid_lon)] }
            } else {
                vec![(b.centroid_lat, b.centroid_lon)]
            };
            let n_pts = grid_points.len() as u16;
            let lw_split = if n_pts > 1 { 10.0 * (n_pts as f32).log10() } else { 0.0 };
            for (pt_lat, pt_lon) in &grid_points {
                let pt_dist = crate::geo::flat_dist(lat, lng, *pt_lat, *pt_lon);
                let mut d = lw_f32; let mut e = lw_eve; let mut n = lw_night;
                for j in 0..8 { d[j] -= lw_split; e[j] -= lw_split; n[j] -= lw_split; }
                all_buildings.push(noise_compute::types::PointSource {
                    osm_id: b.osm_id,
                    lat: *pt_lat, lon: *pt_lon,
                    source_height_m: h / 2.0,
                    source_type: b.building_type,
                    lw_day: d, lw_evening: e, lw_night: n,
                    n_points: n_pts,
                    name: display_name.clone(),
                    polygon_wkb: b.polygon_wkb.clone(),
                    exclusion_radius_m: 0.0,
                    dist_m: pt_dist,
                });
            }
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
            // Read WKB polygon for area calculation and map display
            // WHY: Industrial area was hardcoded to 10000 m², making Spolana (500K m²)
            // have same emission as a small recycling yard. Now we compute real area from WKB.
            // REVIEWED: GPT-5.4 + Gemini 3.1 Pro confirmed WKB area approach.
            let wkb_col: Option<&arrow::array::BinaryArray> = batch.column_by_name("polygon_wkb").and_then(|c| c.as_any().downcast_ref());

            for i in 0..n {
                let c_lat = clat.value(i);
                let c_lon = clon.value(i);
                let dist = crate::geo::flat_dist(lat, lng, c_lat, c_lon);
                if dist > 5000.0 { continue; }

                let st = stype.map(|a| a.value(i)).unwrap_or(0);
                let iname = ind_name.map(|a| a.value(i).to_string()).unwrap_or_default();
                let osm_id = batch.column_by_name("osm_id").and_then(|c| c.as_any().downcast_ref::<arrow::array::Int64Array>()).map(|a| a.value(i)).unwrap_or(0);

                // Get WKB hex string for polygon display + area calculation
                let wkb_hex = wkb_col.map(|a| {
                    let b = a.value(i);
                    b.iter().map(|byte| format!("{:02x}", byte)).collect::<String>()
                }).unwrap_or_default();

                if st == 10 {
                    // Wind turbine — point source, NOT area-scaled
                    // WHY: IEC 61400-11 gives per-turbine Lw. Wind farms = N individual point sources.
                    // Area scaling would be physically wrong for turbines.
                    let hub = hub_h.and_then(|a| { let v = a.value(i); if v > 0.0 { Some(v) } else { None }}).unwrap_or(80.0);
                    let kw = power.and_then(|a| { let v = a.value(i); if v > 0.0 { Some(v) } else { None }}).unwrap_or(2000.0);
                    let (lw, bands) = noise_compute::emission::wind::wind_turbine_emission(kw as f64);
                    if lw < 10.0 { continue; }
                    let em: [f32; 8] = std::array::from_fn(|j| bands[j] as f32);
                    // Wind turbines emit 24/7 (no temporal offset)
                    all_industrial.push(noise_compute::types::PointSource {
                        osm_id, lat: c_lat, lon: c_lon,
                        source_height_m: hub,
                        source_type: st,
                        lw_day: em, lw_evening: em, lw_night: em,
                        n_points: 1, name: iname, polygon_wkb: wkb_hex,
                        exclusion_radius_m: 0.0, dist_m: dist,
                    });
                } else {
                    // Industrial site — area-scaled emission
                    // WHY: Lw = base + 10×log₁₀(area/10000) per ISO 8297 methodology.
                    // Real area from WKB polygon (was hardcoded 10000 m²).
                    // Fallback 10000 m² if WKB unavailable.
                    let area = noise_compute::wkb::wkb_area_m2(&wkb_hex).unwrap_or(10000.0);
                    // Use NACE profile if enriched (from IRZ/E-PRTR), else generic site_type
                    let profile = NACE_LOOKUP.get()
                        .and_then(|lookup| lookup.get(&osm_id))
                        .and_then(|&nace_2| noise_compute::emission::industrial::nace_profile(nace_2))
                        .unwrap_or_else(|| noise_compute::emission::industrial::industrial_profile(st));
                    let lw = noise_compute::emission::industrial::industrial_lw(&profile, area);
                    if lw < 10.0 { continue; }
                    let bands = noise_compute::emission::industrial::industrial_emission_bands(&profile, lw);
                    let em: [f32; 8] = std::array::from_fn(|j| bands[j] as f32);
                    // Apply temporal offsets from profile (was hardcoded -3 dB night for all types)
                    // WHY: Quarries are silent at night (offset -20 dB), wastewater runs 24/7 (offset 0).
                    // Hardcoded -3 dB made quarries too loud and wastewater too quiet at night.
                    // This directly affects Lden via +10 dB night penalty in END 2002/49/EC formula.
                    let mut em_evening = em;
                    let mut em_night = em;
                    for j in 0..8 {
                        em_evening[j] += profile.evening_offset as f32;
                        em_night[j] += profile.night_offset as f32;
                    }
                    // Source height depends on industry type.
                    // Heavy industry (quarry, cement, metal, power): 10m (stacks, kilns, roof vents)
                    // Default: 5m (ground equipment mix, ISO 8297 effective center)
                    // Wind turbines use hub_height separately (60-120m).
                    let src_height: f32 = if st == 1 { 8.0 } else {
                        let nace = NACE_LOOKUP.get().and_then(|l| l.get(&osm_id)).copied();
                        match nace {
                            Some(8 | 23 | 24 | 35) => 10.0,
                            _ => 5.0,
                        }
                    };
                    // Distributed points: spread emission across polygon area.
                    // WHY: Single centroid creates "donut" pattern — quiet inside, loud ring.
                    // Grid of points matches ISO 9613-2 area source subdivision.
                    // Energy conservation: Lw_per_point = Lw_total - 10×log₁₀(N).
                    let grid_spacing = if area > 5_000.0 { 50.0 } else { 0.0 };
                    let grid_points = if grid_spacing > 0.0 {
                        let pts = noise_compute::wkb::wkb_grid_points(&wkb_hex, grid_spacing);
                        if pts.len() > 1 { pts } else { vec![(c_lat, c_lon)] }
                    } else {
                        vec![(c_lat, c_lon)]
                    };
                    let n_pts = grid_points.len() as u16;
                    let lw_split = if n_pts > 1 { 10.0 * (n_pts as f32).log10() } else { 0.0 };
                    // Per-point exclusion radius — matches pipeline (arrow.rs:372).
                    // WHY: Using total area made R too large for edge points.
                    let area_per_pt = area / n_pts.max(1) as f64;
                    let excl_r = (area_per_pt as f32 / std::f32::consts::PI).sqrt();
                    for (pt_lat, pt_lon) in &grid_points {
                        let pt_dist = crate::geo::flat_dist(lat, lng, *pt_lat, *pt_lon);
                        let mut em_d = em; let mut em_e = em_evening; let mut em_n = em_night;
                        for j in 0..8 { em_d[j] -= lw_split; em_e[j] -= lw_split; em_n[j] -= lw_split; }
                        all_industrial.push(noise_compute::types::PointSource {
                            osm_id, lat: *pt_lat, lon: *pt_lon,
                            source_height_m: src_height,
                            source_type: st,
                            lw_day: em_d, lw_evening: em_e, lw_night: em_n,
                            n_points: n_pts, name: iname.clone(), polygon_wkb: wkb_hex.clone(),
                            exclusion_radius_m: excl_r,
                            dist_m: pt_dist,
                        });
                    }
                }
            }
        }

        // Load barriers within 10km (matching road source radius).
        // WHY: Previously 500m only loaded barriers near the receiver. But screening
        // checks barriers along the ENTIRE source→receiver path. A barrier near a highway
        // 5km away was silently dropped, causing popup/tile disagreement.
        let barriers = query_barriers_from_batches(&data.barrier_batches, lat, lng, 10_000.0);
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
