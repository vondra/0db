//! noise-compute: Pure Rust noise computation engine.
//!
//! CNOSSOS-EU emission + ISO 9613-2 propagation + Doc 29 aircraft.
//! No I/O, no files, no napi. Pure computation.
//!
//! Two entry points:
//! - `compute_at_point()` — single receiver (popup)
//! - `compute_batch()` — many receivers (pipeline)

pub mod types;
pub mod constants;
pub mod emission;
pub mod propagation;
pub mod periods;
pub mod confidence;
pub mod wkb;

use types::*;
use constants::*;
use emission::road::{self, TIME_DIST_MOTORWAY, TIME_DIST_URBAN};
use propagation::iso9613::{self, SourceGeometry};
use propagation::geo;

/// Decode WKB hex string (Polygon type 3) to GeoJSON.
/// WKB format: byte_order(1) + type(4) + num_rings(4) + [num_points(4) + [x(8)+y(8)]*N]*R
fn wkb_to_geojson(hex: &str) -> Option<serde_json::Value> {
    let bytes = (0..hex.len()).step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i+2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    if bytes.len() < 9 { return None; }
    let le = bytes[0] == 1;
    let wkb_type = if le { u32::from_le_bytes(bytes[1..5].try_into().ok()?) }
                   else { u32::from_be_bytes(bytes[1..5].try_into().ok()?) };
    if wkb_type != 3 { return None; } // Only Polygon
    let num_rings = if le { u32::from_le_bytes(bytes[5..9].try_into().ok()?) }
                    else { u32::from_be_bytes(bytes[5..9].try_into().ok()?) } as usize;
    let mut pos = 9;
    let mut rings = Vec::with_capacity(num_rings);
    for _ in 0..num_rings {
        if pos + 4 > bytes.len() { return None; }
        let np = if le { u32::from_le_bytes(bytes[pos..pos+4].try_into().ok()?) }
                 else { u32::from_be_bytes(bytes[pos..pos+4].try_into().ok()?) } as usize;
        pos += 4;
        let mut coords = Vec::with_capacity(np);
        for _ in 0..np {
            if pos + 16 > bytes.len() { return None; }
            let x = if le { f64::from_le_bytes(bytes[pos..pos+8].try_into().ok()?) }
                    else { f64::from_be_bytes(bytes[pos..pos+8].try_into().ok()?) };
            let y = if le { f64::from_le_bytes(bytes[pos+8..pos+16].try_into().ok()?) }
                    else { f64::from_be_bytes(bytes[pos+8..pos+16].try_into().ok()?) };
            pos += 16;
            coords.push(serde_json::json!([x, y]));
        }
        rings.push(serde_json::Value::Array(coords));
    }
    Some(serde_json::json!({"type": "Polygon", "coordinates": rings}))
}

/// Compute noise at a single receiver point from all nearby sources.
pub fn compute_at_point(
    receiver: &Receiver,
    roads: &[RoadSegment],
    railways: &[RailSegment],
    buildings: &[PointSource],
    industrial: &[PointSource],
    aircraft: &[AircraftSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    config: &ComputeConfig,
) -> NoiseResult {
    let mut source_results = Vec::new();
    let mut all_contributors = Vec::new();
    let mut aircraft_band_data: Option<AircraftBandData> = None;

    // ── Roads ──
    if !roads.is_empty() {
        let (road_periods, road_contributors) = compute_roads(receiver, roads, barriers, rasters);
        source_results.push(SourceResult {
            source_type: "road".to_string(),
            periods: road_periods.clone(),
            segment_count: roads.len(),
            displayed_count: road_contributors.len(),
        });
        all_contributors.extend(road_contributors);
    }

    // ── Railways ──
    if !railways.is_empty() {
        let (rail_periods, rail_contributors) = compute_railways(receiver, railways, barriers, rasters);
        source_results.push(SourceResult {
            source_type: "railway".to_string(),
            periods: rail_periods,
            segment_count: railways.len(),
            displayed_count: rail_contributors.len(),
        });
        all_contributors.extend(rail_contributors);
    }

    // ── Settlement (buildings) ──
    if !buildings.is_empty() {
        let (bld_periods, bld_contributors) = compute_point_sources(
            receiver, buildings, barriers, rasters, "building",
        );
        source_results.push(SourceResult {
            source_type: "building".to_string(),
            periods: bld_periods,
            segment_count: buildings.len(),
            displayed_count: bld_contributors.len(),
        });
        all_contributors.extend(bld_contributors);
    }

    // ── Industrial ──
    if !industrial.is_empty() {
        let (ind_periods, ind_contributors) = compute_point_sources(
            receiver, industrial, barriers, rasters, "industrial",
        );
        source_results.push(SourceResult {
            source_type: "industrial".to_string(),
            periods: ind_periods,
            segment_count: industrial.len(),
            displayed_count: ind_contributors.len(),
        });
        all_contributors.extend(ind_contributors);
    }

    // ── Aircraft (Doc 29 — SEPARATE from ISO 9613-2) ──
    if !aircraft.is_empty() {
        let (air_periods, air_contributors, band_data) = compute_aircraft(
            receiver, aircraft, rasters, config.n_days,
        );
        if air_periods.lden_db > f64::NEG_INFINITY {
            source_results.push(SourceResult {
                source_type: "aircraft".to_string(),
                periods: air_periods,
                segment_count: aircraft.len(),
                displayed_count: air_contributors.len(),
            });
            all_contributors.extend(air_contributors);
            aircraft_band_data = Some(band_data);
        }
    }

    // ── Total ──
    let total = periods::sum_periods(
        &source_results.iter().map(|s| s.periods.clone()).collect::<Vec<_>>()
    );

    all_contributors.sort_by(|a, b| b.periods.lden_db.partial_cmp(&a.periods.lden_db).unwrap_or(std::cmp::Ordering::Equal));

    // Ensure at least top-1 contributor from each source type is included
    let mut seen_types = std::collections::HashSet::new();
    let mut guaranteed = Vec::new();
    for c in &all_contributors {
        if seen_types.insert(c.source_type.clone()) {
            guaranteed.push(c.clone());
        }
    }
    all_contributors.truncate(config.top_n);
    // Re-insert guaranteed contributors that were cut
    for g in guaranteed {
        if !all_contributors.iter().any(|c| c.source_type == g.source_type) {
            all_contributors.push(g);
        }
    }

    // Confidence assessment
    let has_census = roads.iter().any(|r| r.traffic_source == 1);
    let has_railway = !railways.is_empty() && railways.iter().any(|r| r.trains_passenger > 0 || r.trains_freight > 0);
    let has_aircraft = !aircraft.is_empty();
    let has_terrain = rasters.elevation(receiver.lat, receiver.lon) != 200.0; // StubRasters returns 200.0
    let has_building_heights = rasters.building_height(receiver.lat, receiver.lon) != 0.0;
    let conf = confidence::Confidence::assess(has_census, has_railway, has_aircraft, has_terrain, has_building_heights);

    NoiseResult { total, sources: source_results, contributors: all_contributors, confidence: conf, aircraft_detail: aircraft_band_data }
}

/// Compute road noise: emission per period → propagation → Lden per segment.
fn compute_roads(
    receiver: &Receiver,
    roads: &[RoadSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> (NoisePeriods, Vec<Contributor>) {
    let road_classes = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "living_street"];
    let max_dist = [10000.0, 5000.0, 5000.0, 2000.0, 1000.0, 500.0, 200.0];
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    use std::collections::HashMap;

    // Group segments by osm_id: accumulate energy + collect geometry
    struct RoadAccum {
        class_name: &'static str,
        display_name: String,
        first_osm_id: i64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        closest_cp_lat: f64,
        closest_cp_lon: f64,
        closest_src_height: f64,
        // Per-period variant energies (full, free-field, no_terrain, no_screening, no_vegetation)
        variants: [PropagationVariants; 3], // day, evening, night
        emission_energy: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
    }
    // Group by (ref, name, class) — not osm_id — so "D1" becomes one contributor
    let mut roads_by_key: HashMap<(String, String, u8), RoadAccum> = HashMap::new();

    for seg in roads {
        let class_idx = (seg.road_class as usize).min(6);
        let max_d = max_dist[class_idx];
        if seg.dist_m > max_d { continue; }

        let fade_factor = geo::fade_factor(seg.dist_m, max_d);

        // Tunnel: skip segment (sound contained inside tunnel, not heard outside)
        if seg.tunnel { continue; }
        // Skip inaccessible roads: access=no or motor_vehicle=no
        if seg.access == 2 || seg.access == 4 { continue; }

        let src_elev = rasters.elevation(seg.cp_lat, seg.cp_lon);
        let src_alt = src_elev + SOURCE_HEIGHT_ROAD;
        let rcv_alt = receiver.altitude_m();
        let d_slant = geo::slant_dist(seg.dist_m, src_alt, rcv_alt);
        if d_slant < 1.0 { continue; }

        let class_name = road_classes[class_idx];
        let defaults = default_traffic(class_name);
        let is_motorway = class_idx <= 1;
        let time_dist = if is_motorway { &TIME_DIST_MOTORWAY } else { &TIME_DIST_URBAN };
        let oneway_factor = if seg.oneway { 0.5 } else { 1.0 };
        // Private roads: 10% traffic (some internal traffic remains)
        let access_factor = if seg.access == 1 { 0.1 } else { 1.0 };

        let (light, medium, heavy, moto) = if seg.traffic_source == 1 && seg.aadt_light > 0 {
            (seg.aadt_light as f64 * oneway_factor * access_factor, seg.aadt_medium as f64 * oneway_factor * access_factor,
             seg.aadt_heavy as f64 * oneway_factor * access_factor, seg.aadt_moto as f64 * oneway_factor * access_factor)
        } else {
            let lr = lane_ratio(class_idx, seg.lanes, seg.oneway);
            let f = oneway_factor * access_factor * lr;
            (defaults.0 * f, defaults.1 * f, defaults.2 * f, defaults.3 * f)
        };

        // Roundabout speed cap: reduced approach/exit speed
        let speed = {
            let base = if seg.speed_limit > 0 { seg.speed_limit as f64 } else { default_speed(class_name) };
            if seg.junction == 1 { base.min(30.0) } else { base }
        };
        let surf_corr = SURFACE_CORR.get(seg.surface_type as usize).copied().unwrap_or(0.0);
        // Bridge: hard surface below → G=0 (no ground absorption)
        let ground_g = if seg.bridge { 0.0 }
            else { rasters.ground_g(receiver.lat, receiver.lon) };
        let flc = geo::finite_line_correction(seg.length_m as f64, seg.dist_m, seg.fraction);

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let ef = road::build_period_flows(light, medium, heavy, moto, speed, time_dist.day_pct, 12.0);
            let ee = road::line_source_emission(&ef, surf_corr);
            let me = ee.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if geo::below_free_field_threshold(me, seg.dist_m, 0.0) { continue; }
        }

        // Per-segment path effects
        let terrain_atten = propagation::path_effects::terrain_attenuation(
            rasters, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, seg.dist_m,
        );
        let screening_atten = propagation::path_effects::screening_attenuation(
            rasters, barriers, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, seg.dist_m, 0.0, // roads: no exclusion radius
        );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(
            rasters, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon, seg.dist_m,
        );

        let mut seg_variants = [PropagationVariants::default(), PropagationVariants::default(), PropagationVariants::default()];
        let mut day_emission_energy = 0.0f64;
        for (pi, (pct, hours)) in [(time_dist.day_pct, 12.0), (time_dist.evening_pct, 4.0), (time_dist.night_pct, 8.0)].iter().enumerate() {
            let flows = road::build_period_flows(light, medium, heavy, moto, speed, *pct, *hours);
            let emission = road::line_source_emission(&flows, surf_corr);
            let v = iso9613::propagate_variants(&emission, d_slant, SourceGeometry::Line, ground_g,
                &terrain_atten, &screening_atten, &veg_atten, reflection, flc);
            seg_variants[pi].add(&v);
            if pi == 0 {
                for j in 0..NUM_BANDS {
                    day_emission_energy += crate::propagation::iso9613::fast_exp_f64(emission[j] * std::f64::consts::LN_10 * 0.1);
                }
            }
        }

        // Group by (ref, name, class) — all "D1 motorway" segments → one contributor
        // Ramp merging: motorway/trunk with no ref → find nearest with ref
        let effective_ref = if seg.road_ref.is_empty() && class_idx <= 1 {
            // Look for nearest motorway/trunk segment with ref
            let mut best_ref = String::new();
            let mut best_dist = f64::MAX;
            for other in roads.iter() {
                if other.road_class as usize > 1 { continue; }
                if other.road_ref.is_empty() { continue; }
                let d = ((seg.cp_lat - other.cp_lat).powi(2) + (seg.cp_lon - other.cp_lon).powi(2)).sqrt();
                if d < best_dist { best_dist = d; best_ref = other.road_ref.clone(); }
            }
            best_ref
        } else {
            seg.road_ref.clone()
        };

        let key = (effective_ref.clone(), seg.name.clone(), seg.road_class);
        let acc = roads_by_key.entry(key).or_insert_with(|| {
            let display_name = if !effective_ref.is_empty() && !seg.name.is_empty() {
                format!("{} — {}", effective_ref, seg.name)
            } else if !effective_ref.is_empty() {
                effective_ref.clone()
            } else if !seg.name.is_empty() {
                seg.name.clone()
            } else {
                // Fallback based on class
                match class_idx {
                    0 => "Motorway".to_string(),
                    1 => "Trunk road".to_string(),
                    2 => "Primary road".to_string(),
                    3 => "Secondary road".to_string(),
                    4 => "Tertiary road".to_string(),
                    5 => "Local road".to_string(),
                    _ => "Road".to_string(),
                }
            };
            RoadAccum {
                class_name, display_name, first_osm_id: seg.osm_id,
                min_dist: f64::MAX, min_d_slant: 0.0, min_ground_g: 0.5,
                closest_cp_lat: seg.cp_lat, closest_cp_lon: seg.cp_lon,
                closest_src_height: src_alt,
                variants: [PropagationVariants::default(), PropagationVariants::default(), PropagationVariants::default()],
                emission_energy: 0.0,
                line_coords: Vec::new(),
            }
        });
        // Apply fade-out factor to energy (linear scale) before accumulation
        for pi in 0..3 {
            if fade_factor < 1.0 { seg_variants[pi].scale(fade_factor); }
            acc.variants[pi].add(&seg_variants[pi]);
        }
        acc.emission_energy += day_emission_energy * fade_factor;
        if seg.dist_m < acc.min_dist {
            acc.min_dist = seg.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.closest_cp_lat = seg.cp_lat;
            acc.closest_cp_lon = seg.cp_lon;
            acc.closest_src_height = src_alt;
        }
        // Each segment is an independent 2-point LineString; no osm_id regrouping needed.
        acc.line_coords.push([[seg.start_lon, seg.start_lat], [seg.end_lon, seg.end_lat]]);
    }

    // Emit grouped contributors
    let mut contributors = Vec::new();
    for ((_ref, _name, _class), acc) in &roads_by_key {
        // Full energy from variants (includes all path effects per-band)
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let road_periods = periods::periods(ld, le, ln);
        if road_periods.lden_db < 0.0 { continue; }

        // Free-field energy (for comparison)
        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let emission_db = 10.0 * acc.emission_energy.max(1e-12).log10();
        let geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else { None };

        // Aggregate path effect deltas from accumulated PropagationVariants
        let lden_of = |f: fn(&PropagationVariants) -> f64| {
            PropagationVariants::lden_from_periods(&acc.variants[0], &acc.variants[1], &acc.variants[2], f)
        };
        let no_terrain_lden = lden_of(|v| v.no_terrain_energy);
        let no_screening_lden = lden_of(|v| v.no_screening_energy);
        let no_veg_lden = lden_of(|v| v.no_vegetation_energy);

        // Nearest segment metadata (for informational display — delta, building height, forest depth)
        let (nearest_terrain, nearest_screening, nearest_veg) = compute_path_effects(
            rasters, barriers, acc.closest_cp_lat, acc.closest_cp_lon, acc.closest_src_height,
            receiver, acc.min_dist, 0.0,
        );

        // Use aggregate Lden deltas for attenuation, nearest-segment metadata for context
        let terrain_adj = (road_periods.lden_db - no_terrain_lden).min(0.0);
        let screening_adj = (road_periods.lden_db - no_screening_lden).min(0.0);
        let veg_adj = (road_periods.lden_db - no_veg_lden).min(0.0);

        contributors.push(Contributor {
            osm_id: Some(acc.first_osm_id),
            geometry,
            source_type: "road".to_string(),
            name: acc.display_name.clone(),
            subtype: acc.class_name.to_string(),
            distance_m: acc.min_dist,
            periods: road_periods,
            periods_free: free_periods,
            emission_db,
            baseline: iso9613::compute_baseline(acc.min_d_slant, SourceGeometry::Line, acc.min_ground_g),
            terrain: TerrainBreakdown {
                delta_m: nearest_terrain.delta_m,
                is_double: nearest_terrain.is_double,
                attenuation_db: (terrain_adj * 10.0).round() / 10.0,
            },
            screening: ScreeningBreakdown {
                building_path_m: nearest_screening.building_path_m,
                attenuation_db: (screening_adj * 10.0).round() / 10.0,
            },
            vegetation: VegetationBreakdown {
                forest_depth_m: nearest_veg.forest_depth_m,
                attenuation_db: (veg_adj * 10.0).round() / 10.0,
            },
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
        });
    }

    // Sum contributor-level full-energy for total (already includes all path effects)
    let mut total_energy = [0.0f64; 3];
    for c in &contributors {
        total_energy[0] += crate::propagation::iso9613::fast_exp_f64(c.periods.ld_db * std::f64::consts::LN_10 * 0.1);
        total_energy[1] += crate::propagation::iso9613::fast_exp_f64(c.periods.le_db * std::f64::consts::LN_10 * 0.1);
        total_energy[2] += crate::propagation::iso9613::fast_exp_f64(c.periods.ln_db * std::f64::consts::LN_10 * 0.1);
    }
    let ld = 10.0 * total_energy[0].max(1e-12).log10();
    let le = 10.0 * total_energy[1].max(1e-12).log10();
    let ln = 10.0 * total_energy[2].max(1e-12).log10();

    (periods::periods(ld, le, ln), contributors)
}

/// Compute railway noise — grouped by osm_id with geometry.
fn compute_railways(
    receiver: &Receiver,
    railways: &[RailSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> (NoisePeriods, Vec<Contributor>) {
    use std::collections::HashMap;
    use emission::railway::{self, RailType};

    struct RailAccum {
        name: String,
        rail_type: RailType,
        first_osm_id: i64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        cp_lat: f64, cp_lon: f64, src_height: f64,
        variants: [PropagationVariants; 3],
        emission_energy: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
        has_bridge: bool,
    }
    let mut rails_by_key: HashMap<(String, u8), RailAccum> = HashMap::new();

    let day_pct = 0.65;
    let eve_pct = 0.20;
    let night_pct = 0.15;
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    for seg in railways {
        if seg.tunnel { continue; }
        if seg.dist_m > 8000.0 { continue; }

        let fade_factor = geo::fade_factor(seg.dist_m, 8000.0);

        let src_elev = rasters.elevation(seg.cp_lat, seg.cp_lon);
        let src_alt = src_elev + SOURCE_HEIGHT_RAIL;
        let d_slant = geo::slant_dist(seg.dist_m, src_alt, receiver.altitude_m());
        if d_slant < 1.0 { continue; }

        let rail_type = RailType::from_u8(seg.rail_type);
        let speed = if seg.speed_kmh > 0 { seg.speed_kmh as f64 } else { 80.0 };
        let q_pax = seg.trains_passenger.max(0) as f64;
        let q_frt = seg.trains_freight.max(0) as f64;
        if q_pax + q_frt <= 0.0 { continue; }

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let ee = railway::railway_emission(rail_type, speed, q_pax * day_pct, q_frt * day_pct);
            let me = ee.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if geo::below_free_field_threshold(me, seg.dist_m, 0.0) { continue; }
        }

        let rcv_alt = receiver.altitude_m();

        // Bridge: hard surface below → G=0 (no ground absorption). ISO 9613-2 §7.3.1
        let ground_g = if seg.bridge { 0.0 } else { rasters.ground_g(receiver.lat, receiver.lon) };
        let flc = geo::finite_line_correction(seg.length_m as f64, seg.dist_m, seg.fraction);

        // Per-segment path effects
        let terrain_atten = propagation::path_effects::terrain_attenuation(
            rasters, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, seg.dist_m,
        );
        let screening_atten = propagation::path_effects::screening_attenuation(
            rasters, barriers, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, seg.dist_m, 0.0, // railways: no exclusion radius
        );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(
            rasters, seg.cp_lat, seg.cp_lon, receiver.lat, receiver.lon, seg.dist_m,
        );

        let mut seg_variants = [PropagationVariants::default(), PropagationVariants::default(), PropagationVariants::default()];
        let mut day_emission_energy = 0.0f64;
        for (pi, pct) in [day_pct, eve_pct, night_pct].iter().enumerate() {
            let emission = railway::railway_emission(rail_type, speed, q_pax * pct, q_frt * pct);
            let v = iso9613::propagate_variants(&emission, d_slant, SourceGeometry::Line, ground_g,
                &terrain_atten, &screening_atten, &veg_atten, reflection, flc);
            seg_variants[pi].add(&v);
            if pi == 0 {
                for j in 0..NUM_BANDS {
                    day_emission_energy += crate::propagation::iso9613::fast_exp_f64(emission[j] * std::f64::consts::LN_10 * 0.1);
                }
            }
        }

        // Group by (ref, name, type). When both ref+name empty, group by osm_id
        // (each OSM way is a logical track segment — avoids merging entire city tram network).
        let key_str = if !seg.rail_ref.is_empty() || !seg.name.is_empty() {
            format!("{}|{}", seg.rail_ref, seg.name)
        } else {
            format!("osm:{}", seg.osm_id)
        };
        let key = (key_str, seg.rail_type);
        let acc = rails_by_key.entry(key).or_insert_with(|| RailAccum {
            name: {
                // Build display name: "trať 250 — Brno–Havlíčkův Brod" or "trať 250" or name or "Rail"
                if !seg.rail_ref.is_empty() && !seg.name.is_empty() {
                    format!("trať {} — {}", seg.rail_ref, seg.name)
                } else if !seg.rail_ref.is_empty() {
                    format!("trať {}", seg.rail_ref)
                } else if !seg.name.is_empty() {
                    seg.name.clone()
                } else {
                    String::new()
                }
            },
            rail_type, first_osm_id: seg.osm_id,
            min_dist: f64::MAX, min_d_slant: 0.0, min_ground_g: 0.5,
            cp_lat: seg.cp_lat, cp_lon: seg.cp_lon, src_height: src_alt,
            variants: [PropagationVariants::default(), PropagationVariants::default(), PropagationVariants::default()],
            emission_energy: 0.0, line_coords: Vec::new(),
            has_bridge: false,
        });
        if fade_factor < 1.0 { for pi in 0..3 { seg_variants[pi].scale(fade_factor); } }
        for pi in 0..3 { acc.variants[pi].add(&seg_variants[pi]); }
        acc.emission_energy += day_emission_energy * fade_factor;
        if seg.bridge { acc.has_bridge = true; }
        if seg.dist_m < acc.min_dist {
            acc.min_dist = seg.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.cp_lat = seg.cp_lat;
            acc.cp_lon = seg.cp_lon;
            acc.src_height = src_alt;
        }
        acc.line_coords.push([[seg.start_lon, seg.start_lat], [seg.end_lon, seg.end_lat]]);
    }

    let mut contributors = Vec::new();
    for ((_key, _rt), acc) in &rails_by_key {
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let rail_periods = periods::periods(ld, le, ln);
        if rail_periods.lden_db < 0.0 { continue; }

        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else { None };

        let rail_effects = compute_path_effects(rasters, barriers, acc.cp_lat, acc.cp_lon, acc.src_height, receiver, acc.min_dist, 0.0);

        contributors.push(Contributor {
            osm_id: Some(acc.first_osm_id), geometry,
            source_type: "railway".to_string(),
            name: if acc.name.is_empty() { String::new() } else { acc.name.clone() },
            subtype: {
                let base = format!("{:?}", acc.rail_type);
                if acc.has_bridge { format!("{} (bridge)", base) } else { base }
            },
            distance_m: acc.min_dist,
            periods: rail_periods, periods_free: free_periods,
            emission_db: 10.0 * acc.emission_energy.max(1e-12).log10(),
            baseline: iso9613::compute_baseline(acc.min_d_slant, SourceGeometry::Line, acc.min_ground_g),
            terrain: rail_effects.0,
            screening: rail_effects.1,
            vegetation: rail_effects.2,
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
        });
    }

    // Sum contributor-level path-affected energies for total
    let mut total_energy = [0.0f64; 3];
    for c in &contributors {
        total_energy[0] += crate::propagation::iso9613::fast_exp_f64(c.periods.ld_db * std::f64::consts::LN_10 * 0.1);
        total_energy[1] += crate::propagation::iso9613::fast_exp_f64(c.periods.le_db * std::f64::consts::LN_10 * 0.1);
        total_energy[2] += crate::propagation::iso9613::fast_exp_f64(c.periods.ln_db * std::f64::consts::LN_10 * 0.1);
    }
    let ld = 10.0 * total_energy[0].max(1e-12).log10();
    let le = 10.0 * total_energy[1].max(1e-12).log10();
    let ln = 10.0 * total_energy[2].max(1e-12).log10();
    (periods::periods(ld, le, ln), contributors)
}

/// Compute noise from pre-discretized point sources (buildings, industrial).
/// Grouped by osm_id with Point geometry for map highlight.
fn compute_point_sources(
    receiver: &Receiver,
    sources: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    source_type_name: &str,
) -> (NoisePeriods, Vec<Contributor>) {
    use std::collections::HashMap;

    struct PtAccum {
        name: String,
        subtype: u8,
        lat: f64, lon: f64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        src_height: f64,
        exclusion_radius_m: f32,
        variants: [PropagationVariants; 3],
        emission_energy: f64,
        polygon_wkb: String,
    }
    let mut pts_by_osm: HashMap<i64, PtAccum> = HashMap::new();
    let ground_g = rasters.ground_g(receiver.lat, receiver.lon);
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    // Building max 2km (matching pipeline per-building cutoff), industrial 5km
    let max_d = if source_type_name == "building" { 2000.0 } else { 5000.0 };

    for src in sources {
        if src.dist_m > max_d { continue; }

        let fade_factor = geo::fade_factor(src.dist_m, max_d);

        let src_alt = rasters.elevation(src.lat, src.lon) + src.source_height_m as f64;
        let rcv_alt = receiver.altitude_m();
        let d_slant = geo::slant_dist(src.dist_m, src_alt, rcv_alt);
        if d_slant < 1.0 { continue; }

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let me = src.lw_day.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
            if geo::below_free_field_threshold(me, src.dist_m, 0.0) { continue; }
        }

        // Per-source path effects
        let terrain_atten = propagation::path_effects::terrain_attenuation(
            rasters, src.lat, src.lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, src.dist_m,
        );
        let screening_atten = propagation::path_effects::screening_attenuation(
            rasters, barriers, src.lat, src.lon, receiver.lat, receiver.lon,
            src_alt, rcv_alt, src.dist_m, src.exclusion_radius_m as f64,
        );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(
            rasters, src.lat, src.lon, receiver.lat, receiver.lon, src.dist_m,
        );

        let mut v_day = iso9613::propagate_variants(
            &src.lw_day.map(|v| v as f64), d_slant, SourceGeometry::Point, ground_g,
            &terrain_atten, &screening_atten, &veg_atten, reflection, 0.0,
        );
        let mut v_eve = iso9613::propagate_variants(
            &src.lw_evening.map(|v| v as f64), d_slant, SourceGeometry::Point, ground_g,
            &terrain_atten, &screening_atten, &veg_atten, reflection, 0.0,
        );
        let mut v_night = iso9613::propagate_variants(
            &src.lw_night.map(|v| v as f64), d_slant, SourceGeometry::Point, ground_g,
            &terrain_atten, &screening_atten, &veg_atten, reflection, 0.0,
        );

        let day_em: f64 = src.lw_day.iter().map(|&v| crate::propagation::iso9613::fast_exp_f64(v as f64 * std::f64::consts::LN_10 * 0.1)).sum();

        let acc = pts_by_osm.entry(src.osm_id).or_insert_with(|| PtAccum {
            name: src.name.clone(), subtype: src.source_type,
            lat: src.lat, lon: src.lon, min_dist: f64::MAX,
            min_d_slant: 0.0, min_ground_g: 0.5, src_height: src_alt,
            exclusion_radius_m: src.exclusion_radius_m,
            variants: [PropagationVariants::default(), PropagationVariants::default(), PropagationVariants::default()],
            emission_energy: 0.0,
            polygon_wkb: src.polygon_wkb.clone(),
        });
        if fade_factor < 1.0 { v_day.scale(fade_factor); v_eve.scale(fade_factor); v_night.scale(fade_factor); }
        acc.variants[0].add(&v_day);
        acc.variants[1].add(&v_eve);
        acc.variants[2].add(&v_night);
        acc.emission_energy += day_em * fade_factor;
        if src.dist_m < acc.min_dist {
            acc.min_dist = src.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.lat = src.lat;
            acc.lon = src.lon;
            acc.src_height = src_alt;
            acc.exclusion_radius_m = src.exclusion_radius_m;
        }
    }

    let mut contributors = Vec::new();
    for (osm_id, acc) in &pts_by_osm {
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let pt_periods = periods::periods(ld, le, ln);
        if pt_periods.lden_db < 0.0 {
            continue;
        }

        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let geometry = if !acc.polygon_wkb.is_empty() {
            wkb_to_geojson(&acc.polygon_wkb).or_else(|| Some(serde_json::json!({
                "type": "Point", "coordinates": [acc.lon, acc.lat],
            })))
        } else {
            Some(serde_json::json!({
                "type": "Point", "coordinates": [acc.lon, acc.lat],
            }))
        };

        let pt_effects = compute_path_effects(rasters, barriers, acc.lat, acc.lon, acc.src_height, receiver, acc.min_dist, acc.exclusion_radius_m as f64);

        contributors.push(Contributor {
            osm_id: Some(*osm_id), geometry,
            source_type: source_type_name.to_string(),
            name: acc.name.clone(),
            subtype: if source_type_name == "industrial" {
                match acc.subtype {
                    0 => "industrial_area", 1 => "quarry", 2 => "farm",
                    3 => "factory", 4 => "wastewater",
                    10 => "wind_turbine",
                    _ => "industrial_area",
                }
            } else {
                match acc.subtype {
                    0 => "residential_multi", 1 => "commercial", 2 => "warehouse",
                    3 => "education", 4 => "healthcare", 5 => "worship",
                    6 => "hospitality", 7 => "garage", 8 => "farm",
                    9 => "public",
                    _ => "default",
                }
            }.to_string(),
            distance_m: acc.min_dist,
            periods: pt_periods, periods_free: free_periods,
            emission_db: 10.0 * acc.emission_energy.max(1e-12).log10(),
            baseline: iso9613::compute_baseline(acc.min_d_slant, SourceGeometry::Point, acc.min_ground_g),
            terrain: pt_effects.0,
            screening: pt_effects.1,
            vegetation: pt_effects.2,
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
        });
    }

    // Sum contributor-level full-energy for total
    let mut total_energy = [0.0f64; 3];
    for c in &contributors {
        total_energy[0] += crate::propagation::iso9613::fast_exp_f64(c.periods.ld_db * std::f64::consts::LN_10 * 0.1);
        total_energy[1] += crate::propagation::iso9613::fast_exp_f64(c.periods.le_db * std::f64::consts::LN_10 * 0.1);
        total_energy[2] += crate::propagation::iso9613::fast_exp_f64(c.periods.ln_db * std::f64::consts::LN_10 * 0.1);
    }
    let ld = 10.0 * total_energy[0].max(1e-12).log10();
    let le = 10.0 * total_energy[1].max(1e-12).log10();
    let ln = 10.0 * total_energy[2].max(1e-12).log10();
    (periods::periods(ld, le, ln), contributors)
}

/// Compute aircraft noise (Doc 29 — SEPARATE from ISO 9613-2).
/// Per-segment SEL → per-flight energy → period Leq → Lden.
fn compute_aircraft(
    receiver: &Receiver,
    segments: &[AircraftSegment],
    _rasters: &dyn RasterSampler,
    n_days: u16,
) -> (NoisePeriods, Vec<Contributor>, AircraftBandData) {
    use std::collections::HashMap;
    use emission::aircraft;

    let rx_elev = receiver.altitude_m();
    let n_days_f = n_days as f64;

    // Per-flight accumulation
    struct FlightAccum {
        period_energy: [f64; 3],  // day/eve/night energy sum
        peak_lmax: f64,
        min_dist_m: f64,
        profile_idx: u8,
    }
    let mut flights: HashMap<u64, FlightAccum> = HashMap::new();

    for seg in segments {
        let result = aircraft::segment_sel(seg, receiver.lat, receiver.lon, rx_elev);
        let (sel, cpa) = match result {
            Some(v) => v,
            None => continue,
        };

        let energy = crate::propagation::iso9613::fast_exp_f64(sel * std::f64::consts::LN_10 * 0.1);
        let period = seg.period.min(2) as usize;

        let acc = flights.entry(seg.flight_id).or_insert(FlightAccum {
            period_energy: [0.0; 3],
            peak_lmax: -999.0,
            min_dist_m: f64::MAX,
            profile_idx: seg.profile_idx,
        });
        acc.period_energy[period] += energy;
        let lmax = sel - 12.0; // typical SEL-Lmax offset
        if lmax > acc.peak_lmax { acc.peak_lmax = lmax; }
        if cpa.d_p_m < acc.min_dist_m { acc.min_dist_m = cpa.d_p_m; }
    }

    if flights.is_empty() {
        return (NoisePeriods::silence(), Vec::new(), AircraftBandData::default());
    }

    // Sum per-flight energy into period totals + compute band statistics
    let mut period_energy = [0.0f64; 3];
    let mut contributors = Vec::new();

    // Band thresholds: faint >30 dB Lmax, audible >45 dB, disruptive >60 dB
    struct BandStats { count: f64, alt_sum: f64, profile_counts: [u32; 8] }
    impl BandStats {
        fn new() -> Self { BandStats { count: 0.0, alt_sum: 0.0, profile_counts: [0; 8] } }
        fn top_type(&self) -> &'static str {
            let idx = self.profile_counts.iter().enumerate()
                .max_by_key(|(_, c)| *c).map(|(i, _)| i).unwrap_or(7);
            aircraft::PROFILES[idx].name
        }
    }
    let mut band_faint = BandStats::new();     // >30 dB Lmax
    let mut band_audible = BandStats::new();   // >45 dB
    let mut band_disruptive = BandStats::new(); // >60 dB
    let mut helicopter_count = 0.0f64;
    let mut global_peak_lmax = f64::NEG_INFINITY;

    for (_fid, acc) in &flights {
        for p in 0..3 {
            period_energy[p] += acc.period_energy[p];
        }

        let _profile = &aircraft::PROFILES[acc.profile_idx.min(7) as usize];
        let flight_energy: f64 = acc.period_energy.iter().sum();
        if flight_energy <= 0.0 { continue; }

        // Per-flight Lmax
        if acc.peak_lmax > global_peak_lmax { global_peak_lmax = acc.peak_lmax; }

        // Helicopter count — approximation. Profile 6 is mixed LightGA+Rotorcraft.
        // TODO: separate GA from rotorcraft in ADS-B extractor for accurate count.
        if acc.profile_idx == 6 { helicopter_count += 1.0 / n_days_f; }

        // Band classification by Lmax
        let avg_alt = acc.min_dist_m; // approximate: CPA distance ≈ altitude for overhead
        let pidx = acc.profile_idx.min(7) as usize;
        if acc.peak_lmax > 30.0 {
            band_faint.count += 1.0;
            band_faint.alt_sum += avg_alt;
            band_faint.profile_counts[pidx] += 1;
        }
        if acc.peak_lmax > 45.0 {
            band_audible.count += 1.0;
            band_audible.alt_sum += avg_alt;
            band_audible.profile_counts[pidx] += 1;
        }
        if acc.peak_lmax > 60.0 {
            band_disruptive.count += 1.0;
            band_disruptive.alt_sum += avg_alt;
            band_disruptive.profile_counts[pidx] += 1;
        }

        // Per-flight contributors removed — only summary with band table shown
    }

    // Period Leq normalization (Doc 29 §5)
    let ld = aircraft::period_leq(period_energy[0], n_days_f, aircraft::PERIOD_SECONDS[0]);
    let le = aircraft::period_leq(period_energy[1], n_days_f, aircraft::PERIOD_SECONDS[1]);
    let ln = aircraft::period_leq(period_energy[2], n_days_f, aircraft::PERIOD_SECONDS[2]);
    let total = periods::periods(ld, le, ln);

    let flights_per_day = flights.len() as f64 / n_days_f;

    // Aircraft summary contributor with v33 metadata format for frontend
    contributors.insert(0, Contributor {
        osm_id: None, geometry: None,
        baseline: PropagationBaseline::default(),
        terrain: TerrainBreakdown::default(),
        screening: ScreeningBreakdown::default(),
        vegetation: VegetationBreakdown::default(),
        source_type: "aircraft".to_string(),
        name: format!("{:.0} flights/day", flights_per_day),
        subtype: "aircraft".to_string(),
        distance_m: 0.0,
        periods: total.clone(),
        periods_free: total.clone(),
        emission_db: total.lden_db,
        received_bands: [0.0; NUM_BANDS],
    });

    // Inject v33 metadata into first contributor (JSON serialization picks it up)
    // The frontend reads these fields from contributor.metadata
    // We'll add them in source-reader's JSON serialization layer
    // Store band stats for the source-reader to serialize
    let band_data = AircraftBandData {
        l_day: ld, l_evening: le, l_night: ln,
        lmax_peak: if global_peak_lmax > -900.0 { Some(global_peak_lmax) } else { None },
        flights_per_day,
        helicopter_flights_per_day: helicopter_count,
        faint_flights_per_day: band_faint.count / n_days_f,
        faint_avg_altitude_m: if band_faint.count > 0.0 { band_faint.alt_sum / band_faint.count } else { 0.0 },
        faint_top_aircraft: band_faint.top_type().to_string(),
        audible_flights_per_day: band_audible.count / n_days_f,
        audible_avg_altitude_m: if band_audible.count > 0.0 { band_audible.alt_sum / band_audible.count } else { 0.0 },
        audible_top_aircraft: band_audible.top_type().to_string(),
        disruptive_flights_per_day: band_disruptive.count / n_days_f,
        disruptive_avg_altitude_m: if band_disruptive.count > 0.0 { band_disruptive.alt_sum / band_disruptive.count } else { 0.0 },
        disruptive_top_aircraft: band_disruptive.top_type().to_string(),
    };

    contributors.sort_by(|a, b| b.periods.lden_db.partial_cmp(&a.periods.lden_db).unwrap_or(std::cmp::Ordering::Equal));

    (total, contributors, band_data)
}

fn default_traffic(class: &str) -> (f64, f64, f64, f64) {
    match class {
        "motorway" => (21600.0, 2400.0, 5700.0, 300.0),
        "trunk" => (11700.0, 1200.0, 1800.0, 300.0),
        "primary" => (7470.0, 540.0, 810.0, 180.0),
        "secondary" => (2640.0, 120.0, 180.0, 60.0),
        "tertiary" => (720.0, 26.0, 38.0, 16.0),
        "residential" => (480.0, 5.0, 10.0, 5.0),
        "living_street" => (98.0, 0.0, 1.0, 1.0),
        _ => (480.0, 5.0, 10.0, 5.0),
    }
}

/// Lane-based AADT scaling ratio (calibrated from CZ ŘSD CSD 2020 census medians).
fn lane_ratio(class_idx: usize, lanes: u8, oneway: bool) -> f64 {
    if lanes <= 2 || class_idx >= 5 { return 1.0; }
    match (class_idx, oneway) {
        (0, true) => match lanes.min(3) { 3 => 1.42, _ => 1.0 },
        (2, false) => match lanes.min(4) { 3 => 1.37, 4 => 2.13, _ => 1.0 },
        (3, false) => match lanes.min(3) { 3 => 1.83, _ => 1.0 },
        _ => 1.0,
    }
}

fn default_speed(class: &str) -> f64 {
    match class {
        "motorway" => 100.0, "trunk" => 70.0, "primary" => 50.0,
        "secondary" => 50.0, "tertiary" => 50.0, "residential" => 30.0,
        "living_street" => 20.0, _ => 50.0,
    }
}

/// Compute terrain/screening/vegetation path effects for one source-receiver pair.
/// Returns (TerrainBreakdown, ScreeningBreakdown, VegetationBreakdown).
fn compute_path_effects(
    rasters: &dyn RasterSampler,
    barriers: &[Barrier],
    src_lat: f64, src_lon: f64, src_height: f64,
    receiver: &Receiver, dist_m: f64,
    exclusion_radius_m: f64,
) -> (TerrainBreakdown, ScreeningBreakdown, VegetationBreakdown) {
    let rcv_alt = receiver.altitude_m();

    // Single-pass variants that return both attenuation and metadata
    let (terrain_atten, terrain_delta, terrain_is_double) =
        propagation::path_effects::terrain_attenuation_with_meta(
            rasters, src_lat, src_lon, receiver.lat, receiver.lon,
            src_height, rcv_alt, dist_m,
        );

    let (screening_atten, max_bh) =
        propagation::path_effects::screening_attenuation_with_meta(
            rasters, barriers, src_lat, src_lon, receiver.lat, receiver.lon,
            src_height, rcv_alt, dist_m, exclusion_radius_m,
        );

    let veg_atten = propagation::path_effects::vegetation_attenuation_path(
        rasters, src_lat, src_lon, receiver.lat, receiver.lon, dist_m,
    );
    let forest_depth = if dist_m <= 500.0 {
        rasters.vegetation_depth(src_lat, src_lon, receiver.lat, receiver.lon)
    } else { 0.0 };

    (
        TerrainBreakdown {
            delta_m: (terrain_delta * 100.0).round() / 100.0,
            is_double: terrain_is_double,
            attenuation_db: -(terrain_atten[4] * 10.0).round() / 10.0,
        },
        ScreeningBreakdown {
            building_path_m: (max_bh * 10.0).round() / 10.0,
            attenuation_db: -(screening_atten[4] * 10.0).round() / 10.0,
        },
        VegetationBreakdown {
            forest_depth_m: (forest_depth * 10.0).round() / 10.0,
            attenuation_db: -(veg_atten[4] * 10.0).round() / 10.0,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock raster sampler for testing.
    struct MockRasters;
    impl RasterSampler for MockRasters {
        fn elevation(&self, _lat: f64, _lon: f64) -> f64 { 200.0 }
        fn building_height(&self, _lat: f64, _lon: f64) -> f64 { 0.0 }
        fn vegetation_depth(&self, _: f64, _: f64, _: f64, _: f64) -> f64 { 0.0 }
        fn ground_g(&self, _: f64, _: f64) -> f64 { 0.5 }
        fn ground_g_path(&self, _: f64, _: f64, _: f64, _: f64) -> f64 { 0.5 }
        fn terrain_profile(&self, _: f64, _: f64, _: f64, _: f64, steps: usize) -> Vec<f64> {
            vec![200.0; steps]
        }
        fn building_enclosure(&self, _: f64, _: f64) -> f64 { 0.0 }
    }

    #[test]
    fn test_road_end_to_end() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1, segment_idx: 0,
            start_lat: 50.081, start_lon: 14.42, end_lat: 50.079, end_lon: 14.42,
            length_m: 220.0, road_class: 0, // motorway
            speed_limit: 100, surface_type: 0, oneway: false, lanes: 2,
            aadt_light: 0, aadt_medium: 0, aadt_heavy: 0, aadt_moto: 0,
            traffic_source: 0, // defaults
            dist_m: 500.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
                name: String::new(), road_ref: String::new(), bridge: false, tunnel: false,
                access: 0, junction: 0,
        }];

        let result = compute_at_point(&receiver, &roads, &[], &[], &[], &[], &[], &MockRasters, &ComputeConfig::default());

        // Motorway at 500m with 30K AADT should produce ~55-65 dB Lden
        assert!(result.total.lden_db > 45.0 && result.total.lden_db < 75.0,
            "Motorway 500m: expected 45-75 dB, got {:.1}", result.total.lden_db);

        // Should have period decomposition
        assert!(result.total.ld_db > result.total.ln_db,
            "Day should be louder than night (Ld={:.1}, Ln={:.1})", result.total.ld_db, result.total.ln_db);

        // Should have at least one source result
        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].source_type, "road");

        println!("Motorway 500m: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1}",
            result.total.ld_db, result.total.le_db, result.total.ln_db, result.total.lden_db);
    }

    #[test]
    fn test_multi_source() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1, segment_idx: 0,
            start_lat: 50.081, start_lon: 14.42, end_lat: 50.079, end_lon: 14.42,
            length_m: 220.0, road_class: 2, speed_limit: 50, surface_type: 0,
            oneway: false, lanes: 2,
            aadt_light: 0, aadt_medium: 0, aadt_heavy: 0, aadt_moto: 0, traffic_source: 0,
            dist_m: 100.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
                name: String::new(), road_ref: String::new(), bridge: false, tunnel: false,
                access: 0, junction: 0,
        }];
        let railways = vec![RailSegment {
            osm_id: 2, segment_idx: 0,
            start_lat: 50.082, start_lon: 14.42, end_lat: 50.078, end_lon: 14.42,
            length_m: 440.0, rail_type: 0, usage: 0, maxspeed: 100,
            trains_passenger: 80, trains_freight: 20, speed_kmh: 100, track_count: 2,
            name: String::new(), rail_ref: String::new(),
            dist_m: 200.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
            bridge: false, tunnel: false,
        }];

        let result = compute_at_point(&receiver, &roads, &railways, &[], &[], &[], &[], &MockRasters, &ComputeConfig::default());

        // Should have both road and railway sources
        assert_eq!(result.sources.len(), 2);
        assert!(result.total.lden_db > 40.0, "multi-source Lden={:.1}", result.total.lden_db);

        // Total should be louder than either source alone
        let road_only = compute_at_point(&receiver, &roads, &[], &[], &[], &[], &[], &MockRasters, &ComputeConfig::default());
        let rail_only = compute_at_point(&receiver, &[], &railways, &[], &[], &[], &[], &MockRasters, &ComputeConfig::default());

        assert!(result.total.lden_db > road_only.total.lden_db, "combined should be louder than road alone");
        assert!(result.total.lden_db > rail_only.total.lden_db, "combined should be louder than rail alone");

        println!("Multi: road={:.1} rail={:.1} combined={:.1} dB Lden",
            road_only.total.lden_db, rail_only.total.lden_db, result.total.lden_db);
    }

    #[test]
    fn test_residential_nearby() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 2, segment_idx: 0,
            start_lat: 50.0801, start_lon: 14.42, end_lat: 50.0799, end_lon: 14.42,
            length_m: 22.0, road_class: 5, // residential
            speed_limit: 30, surface_type: 0, oneway: false, lanes: 1,
            aadt_light: 0, aadt_medium: 0, aadt_heavy: 0, aadt_moto: 0,
            traffic_source: 0,
            dist_m: 15.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
                name: String::new(), road_ref: String::new(), bridge: false, tunnel: false,
                access: 0, junction: 0,
        }];

        let result = compute_at_point(&receiver, &roads, &[], &[], &[], &[], &[], &MockRasters, &ComputeConfig::default());

        // Residential at 15m with 500 AADT: ~40-55 dB
        assert!(result.total.lden_db > 30.0 && result.total.lden_db < 65.0,
            "Residential 15m: expected 30-65 dB, got {:.1}", result.total.lden_db);

        println!("Residential 15m: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1}",
            result.total.ld_db, result.total.le_db, result.total.ln_db, result.total.lden_db);
    }

    #[test]
    fn test_aircraft_end_to_end() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        // Simulate 5 flights per day × 365 days = 1825 flights, each with 3 segments
        let mut aircraft = Vec::new();
        for flight in 0..1825u64 {
            let period = if flight % 100 < 65 { 0u8 } else if flight % 100 < 85 { 1 } else { 2 };
            let date_id = (flight / 5) as i16;
            // Approach segments at ~300m altitude, 1km away
            for s in 0..3 {
                aircraft.push(AircraftSegment {
                    flight_id: flight,
                    profile_idx: 0, // B738
                    is_departure: false,
                    period,
                    date_id,
                    start_lat: 50.08 + 0.003 * s as f64,
                    start_lon: 14.43,
                    start_alt_m: 500.0 - 50.0 * s as f32,
                    end_lat: 50.08 + 0.003 * (s + 1) as f64,
                    end_lon: 14.43,
                    end_alt_m: 500.0 - 50.0 * (s + 1) as f32,
                    speed_kt: 150.0,
                    segment_length_m: 330.0,
                });
            }
        }

        let config = ComputeConfig { n_days: 365, ..Default::default() };
        let result = compute_at_point(
            &receiver, &[], &[], &[], &[], &aircraft, &[], &MockRasters, &config,
        );

        // 5 flights/day of B738 at ~700m lateral → expect ~45-65 dB Lden
        assert!(result.total.lden_db > 35.0 && result.total.lden_db < 75.0,
            "Aircraft Lden: expected 35-75, got {:.1}", result.total.lden_db);

        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].source_type, "aircraft");

        // Day should be louder than night (more flights)
        assert!(result.total.ld_db > result.total.ln_db || result.total.ln_db == f64::NEG_INFINITY,
            "Day should be louder: Ld={:.1} Ln={:.1}", result.total.ld_db, result.total.ln_db);

        println!("Aircraft 5/day: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1} ({} contributors)",
            result.total.ld_db, result.total.le_db, result.total.ln_db, result.total.lden_db,
            result.contributors.len());
    }

    #[test]
    fn test_all_sources_combined() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1, segment_idx: 0,
            start_lat: 50.081, start_lon: 14.42, end_lat: 50.079, end_lon: 14.42,
            length_m: 220.0, road_class: 2, speed_limit: 50, surface_type: 0,
            oneway: false, lanes: 2,
            aadt_light: 0, aadt_medium: 0, aadt_heavy: 0, aadt_moto: 0, traffic_source: 0,
            dist_m: 100.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
                name: String::new(), road_ref: String::new(), bridge: false, tunnel: false,
                access: 0, junction: 0,
        }];
        let railways = vec![RailSegment {
            osm_id: 2, segment_idx: 0,
            start_lat: 50.082, start_lon: 14.42, end_lat: 50.078, end_lon: 14.42,
            length_m: 440.0, rail_type: 0, usage: 0, maxspeed: 100,
            trains_passenger: 80, trains_freight: 20, speed_kmh: 100, track_count: 2,
            name: String::new(), rail_ref: String::new(),
            dist_m: 200.0, cp_lat: 50.08, cp_lon: 14.42, fraction: 0.5,
            bridge: false, tunnel: false,
        }];
        let aircraft = vec![AircraftSegment {
            flight_id: 1, profile_idx: 0, is_departure: false,
            period: 0, date_id: 0,
            start_lat: 50.08, start_lon: 14.43, start_alt_m: 500.0,
            end_lat: 50.09, end_lon: 14.43, end_alt_m: 400.0,
            speed_kt: 150.0, segment_length_m: 1100.0,
        }];

        let config = ComputeConfig { n_days: 365, ..Default::default() };
        let result = compute_at_point(
            &receiver, &roads, &railways, &[], &[], &aircraft, &[], &MockRasters, &config,
        );

        // Should have road + railway + aircraft
        assert!(result.sources.len() >= 2, "sources = {:?}", result.sources.iter().map(|s| &s.source_type).collect::<Vec<_>>());
        assert!(result.total.lden_db > 40.0, "combined Lden = {:.1}", result.total.lden_db);

        for s in &result.sources {
            println!("  {}: Lden={:.1}", s.source_type, s.periods.lden_db);
        }
        println!("  TOTAL: Lden={:.1}", result.total.lden_db);
    }
}
