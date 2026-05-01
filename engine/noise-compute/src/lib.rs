//! noise-compute: Pure Rust noise computation engine.
//!
//! CNOSSOS-EU emission + ISO 9613-2 propagation + Doc 29 aircraft.
//! No I/O, no files, no napi. Pure computation.
//!
//! Two entry points:
//! - `compute_at_point()` — single receiver (popup)
//! - `compute_batch()` — many receivers (pipeline)

pub mod admin;
pub mod city_consts_generated;
pub mod confidence;
pub mod constants;
pub mod country_defaults_generated;
pub mod defaults;
pub mod emission;
pub mod flight_id;
pub mod normalize;
pub mod periods;
pub mod present;
pub mod propagation;
pub mod sources;
pub mod traces;
pub mod types;
pub mod wkb;

use constants::*;
use emission::road::{self};
use propagation::geo;
use propagation::iso9613::{self, SourceGeometry};
use traces::{
    build_aircraft_ground_segment_trace, build_point_segment_trace, build_rail_segment_trace,
    build_road_segment_trace, BuildAircraftGroundTrace, BuildPointTrace, BuildRailTrace,
    BuildRoadTrace,
};
use types::*;

/// Round to one decimal place (0.1 dB granularity — matches UI precision).
#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Aircraft ground-ops A-weighted impact scalar. Aircraft uses Doc 29 period
/// normalization (not the ISO 9613 Lden weights that `lden_from_periods`
/// assumes), so the impact delta is computed from `periods_from_normalized`
/// Lden values passed in. `signed=true` for ground (CF[i] < 0 at 63/125 Hz
/// can boost LF); otherwise the delta is clamped to ≤ 0.
#[inline]
fn aircraft_impact(full: &NoisePeriods, no_effect: &NoisePeriods, signed: bool) -> f64 {
    if !full.lden_db.is_finite() {
        return 0.0;
    }
    let d = full.lden_db - no_effect.lden_db;
    round1(if signed { d } else { d.min(0.0) })
}

/// Decode WKB hex string (Polygon type 3) to GeoJSON.
/// WKB format: byte_order(1) + type(4) + num_rings(4) + [num_points(4) + [x(8)+y(8)]*N]*R
fn wkb_to_geojson(hex: &str) -> Option<serde_json::Value> {
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    if bytes.len() < 9 {
        return None;
    }
    let le = bytes[0] == 1;
    let wkb_type = if le {
        u32::from_le_bytes(bytes[1..5].try_into().ok()?)
    } else {
        u32::from_be_bytes(bytes[1..5].try_into().ok()?)
    };
    if wkb_type != 3 {
        return None;
    } // Only Polygon
    let num_rings = if le {
        u32::from_le_bytes(bytes[5..9].try_into().ok()?)
    } else {
        u32::from_be_bytes(bytes[5..9].try_into().ok()?)
    } as usize;
    let mut pos = 9;
    let mut rings = Vec::with_capacity(num_rings);
    for _ in 0..num_rings {
        if pos + 4 > bytes.len() {
            return None;
        }
        let np = if le {
            u32::from_le_bytes(bytes[pos..pos + 4].try_into().ok()?)
        } else {
            u32::from_be_bytes(bytes[pos..pos + 4].try_into().ok()?)
        } as usize;
        pos += 4;
        let mut coords = Vec::with_capacity(np);
        for _ in 0..np {
            if pos + 16 > bytes.len() {
                return None;
            }
            let x = if le {
                f64::from_le_bytes(bytes[pos..pos + 8].try_into().ok()?)
            } else {
                f64::from_be_bytes(bytes[pos..pos + 8].try_into().ok()?)
            };
            let y = if le {
                f64::from_le_bytes(bytes[pos + 8..pos + 16].try_into().ok()?)
            } else {
                f64::from_be_bytes(bytes[pos + 8..pos + 16].try_into().ok()?)
            };
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
    compute_at_point_with_airports(
        receiver,
        roads,
        railways,
        buildings,
        industrial,
        aircraft,
        &[],
        &[],
        barriers,
        rasters,
        config,
        None,
    )
}

pub fn compute_at_point_with_airports(
    receiver: &Receiver,
    roads: &[RoadSegment],
    railways: &[RailSegment],
    buildings: &[PointSource],
    industrial: &[PointSource],
    aircraft: &[AircraftSegment],
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    config: &ComputeConfig,
    mut traces: Option<&mut TraceCollector>,
) -> NoiseResult {
    let mut source_results = Vec::new();
    let mut all_contributors = Vec::new();
    let mut aircraft_band_data: Option<AircraftBandData> = None;

    // ── Roads ──
    if !roads.is_empty() {
        let (road_periods, road_contributors) =
            compute_roads(receiver, roads, barriers, rasters, traces.as_deref_mut());
        source_results.push(SourceResult {
            source_type: LayerKind::Road,
            periods: road_periods.clone(),
            segment_count: roads.len(),
            displayed_count: present::display_count(&road_contributors),
        });
        all_contributors.extend(road_contributors);
    }

    // ── Railways ──
    if !railways.is_empty() {
        let (rail_periods, rail_contributors) =
            compute_railways(receiver, railways, barriers, rasters, traces.as_deref_mut());
        source_results.push(SourceResult {
            source_type: LayerKind::Railway,
            periods: rail_periods,
            segment_count: railways.len(),
            displayed_count: present::display_count(&rail_contributors),
        });
        all_contributors.extend(rail_contributors);
    }

    // ── Settlement (buildings) ──
    if !buildings.is_empty() {
        let (bld_periods, bld_contributors) = compute_point_sources(
            receiver,
            buildings,
            barriers,
            rasters,
            LayerKind::Building,
            traces.as_deref_mut(),
        );
        source_results.push(SourceResult {
            source_type: LayerKind::Building,
            periods: bld_periods,
            segment_count: buildings.len(),
            displayed_count: present::display_count(&bld_contributors),
        });
        all_contributors.extend(bld_contributors);
    }

    // ── Industrial ──
    if !industrial.is_empty() {
        let (ind_periods, ind_contributors) = compute_point_sources(
            receiver,
            industrial,
            barriers,
            rasters,
            LayerKind::Industrial,
            traces.as_deref_mut(),
        );
        source_results.push(SourceResult {
            source_type: LayerKind::Industrial,
            periods: ind_periods,
            segment_count: industrial.len(),
            displayed_count: present::display_count(&ind_contributors),
        });
        all_contributors.extend(ind_contributors);
    }

    // ── Aircraft (Doc 29 — SEPARATE from ISO 9613-2) ──
    if !aircraft.is_empty() {
        let (air_periods, air_contributors, band_data) = compute_aircraft(
            receiver,
            aircraft,
            airport_lines,
            airport_areas,
            barriers,
            rasters,
            config.n_days,
            traces.as_deref_mut(),
        );
        if air_periods.lden_db > f64::NEG_INFINITY {
            source_results.push(SourceResult {
                source_type: LayerKind::Aircraft,
                periods: air_periods,
                segment_count: aircraft.len(),
                displayed_count: present::display_count(&air_contributors),
            });
            all_contributors.extend(air_contributors);
            aircraft_band_data = Some(band_data);
        }
    }

    // ── Total ──
    let total = periods::sum_periods(
        &source_results
            .iter()
            .map(|s| s.periods.clone())
            .collect::<Vec<_>>(),
    );

    let finalized = present::finalize_popup_contributors(all_contributors, 30);
    all_contributors = finalized.shown;
    let other_sources_lden = finalized.other_lden_db;

    // Confidence assessment
    let has_census = roads
        .iter()
        .any(|r| sources::provenance_of(r.source_id).is_measured());
    let has_railway = !railways.is_empty()
        && railways
            .iter()
            .any(|r| r.trains_passenger > 0.0 || r.trains_freight > 0.0);
    let has_aircraft = !aircraft.is_empty();
    let has_terrain = rasters.elevation(receiver.lat, receiver.lon) != 200.0; // StubRasters returns 200.0
    let has_building_heights = rasters.building_height(receiver.lat, receiver.lon) != 0.0;
    let conf = confidence::Confidence::assess(
        has_census,
        has_railway,
        has_aircraft,
        has_terrain,
        has_building_heights,
    );

    NoiseResult {
        total,
        sources: source_results,
        contributors: all_contributors,
        other_sources_lden,
        confidence: conf,
        aircraft_detail: aircraft_band_data,
        segments: Vec::new(),
        airborne_traces: Vec::new(),
        segments_meta: None,
    }
}

/// Compute road noise: emission per period → propagation → Lden per segment.
fn compute_roads(
    receiver: &Receiver,
    roads: &[RoadSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    mut traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>) {
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    use std::collections::HashMap;

    // Group segments by (ref, name, class): accumulate energy + collect geometry
    struct RoadAccum {
        class_name: &'static str,
        display_name: String,
        first_osm_id: i64,
        // Closest segment (for distance display, baseline, path-effect context)
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        closest_cp_lat: f64,
        closest_cp_lon: f64,
        closest_src_height: f64,
        // Dominant-segment metadata (highest received energy — what drives the result)
        dominant_energy: f64,
        dominant_segment_idx: i16,
        dominant_distance_m: f64,
        dominant_aadt_light_raw: i32,
        dominant_aadt_medium_raw: i32,
        dominant_aadt_heavy_raw: i32,
        dominant_aadt_moto_raw: i32,
        dominant_aadt_light_nominal: f64,
        dominant_aadt_medium_nominal: f64,
        dominant_aadt_heavy_nominal: f64,
        dominant_aadt_moto_nominal: f64,
        dominant_aadt_light_effective: f64,
        dominant_aadt_medium_effective: f64,
        dominant_aadt_heavy_effective: f64,
        dominant_aadt_moto_effective: f64,
        dominant_traffic_source: &'static str, // "matched_external" | "estimated_service_tree" | "default_by_class"
        dominant_source_id: u16,              // dataset identity from pipeline/lib/enrichment-datasets.ts
        dominant_speed_posted: u8,
        dominant_speed_used: f64,
        dominant_speed_source: &'static str, // "osm_posted" | "default_by_class" | "roundabout_cap"
        dominant_surface_type: u8,
        dominant_surface_corr_db: f64,
        dominant_lanes: u8,
        dominant_oneway: bool,
        // Aggregation across all grouped segments
        segment_count: u32,
        total_length_m: f64,
        bridge_count: u32,
        speed_min: f64,
        speed_max: f64,
        oneway_segment_count: u32,
        twoway_segment_count: u32,
        // Group-level screening obstacle histogram (popup transparency)
        obstacle_segment_count: u32,
        obstacle_height_sum: f64,
        obstacle_max_height: f64,
        obstacle_max_segment_idx: i16,
        // Per-period variant energies (full, free-field, no_terrain, no_screening, no_vegetation)
        variants: [PropagationVariants; 3], // day, evening, night
        emission_energy: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
        // Index into the caller's traces.segments Vec of the dominant-segment
        // trace (highest received energy). Populated only when a TraceCollector
        // is active; flipped to `is_dominant_of_group = true` at the end.
        dominant_trace_idx: Option<usize>,
    }
    // Group by (ref, name, class) — not osm_id — so "D1" becomes one contributor.
    // For unnamed roads (ref="" && name=""): group per osm_id (like railway)
    // to avoid merging all unnamed residential streets into one mega-contributor.
    let mut roads_by_key: HashMap<(String, String, u8), RoadAccum> = HashMap::new();

    // Admin resolved once per compute_roads call — receiver position is
    // constant across segments. Uses the process-wide admin table
    // (see admin::init_admin_table at pipeline-worker/source-reader init).
    // Falls back to Admin::UNKNOWN → WORLD_DEFAULT when uninitialised.
    let admin = crate::admin::admin_for_latlng(receiver.lat, receiver.lon);

    for seg in roads {
        let Some(norm) = normalize::normalize_road_segment(seg, admin)
        else {
            continue;
        };
        let class_idx = norm.class_idx;
        let max_d = norm.max_distance_m;
        if seg.dist_m > max_d {
            continue;
        }

        let src_elev = rasters.elevation(seg.cp_lat, seg.cp_lon);
        let src_alt = src_elev + norm.source_height_m;
        let rcv_alt = receiver.altitude_m();
        let d_slant = geo::slant_dist(seg.dist_m, src_alt, rcv_alt);
        if d_slant < 1.0 {
            continue;
        }

        let class_name = norm.class_name;
        let time_dist = norm.time_dist();
        let light = norm.light_aadt;
        let medium = norm.medium_aadt;
        let heavy = norm.heavy_aadt;
        let moto = norm.moto_aadt;
        let speed = norm.speed_kmh;
        let base_speed = norm.base_speed_kmh;
        let surf_corr = norm.surf_corr_db;
        let flc = geo::finite_line_correction(seg.length_m as f64, seg.dist_m, seg.fraction);

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let ef = road::build_period_flows(
                light,
                medium,
                heavy,
                moto,
                speed,
                time_dist.day_pct,
                12.0,
            );
            let ee = road::line_source_emission(&ef, surf_corr);
            let me = ee.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if geo::below_free_field_threshold_line(me, seg.dist_m, 0.0) {
                continue;
            }
        }

        // Unified path profile — sampled once, shared across all path-effect calls.
        let mut path_profile = propagation::PathProfile::new();
        rasters.build_path_profile(
            seg.cp_lat,
            seg.cp_lon,
            receiver.lat,
            receiver.lon,
            seg.dist_m,
            &mut path_profile,
        );
        // Bridge: hard surface below → G=0 (no ground absorption)
        let ground_g = if seg.bridge {
            0.0
        } else {
            propagation::path_effects::ground_g_from_profile(&path_profile)
        };
        let (terrain, _terrain_profile_points) =
            propagation::path_effects::terrain_attenuation_with_meta(
                &mut path_profile,
                src_alt,
                rcv_alt,
            );
        let (screening_atten, obstacle_trace) =
            propagation::path_effects::screening_attenuation_with_meta(
        &mut path_profile,
                barriers,
                src_alt,
                rcv_alt,
                0.0, // roads: no exclusion radius
                &terrain.attenuation_bands,
            );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(&path_profile);

        let mut seg_variants = [
            PropagationVariants::default(),
            PropagationVariants::default(),
            PropagationVariants::default(),
        ];
        let mut day_emission_energy = 0.0f64;
        let mut period_emissions: [[f64; NUM_BANDS]; 3] = [[0.0; NUM_BANDS]; 3];
        for (pi, (pct, hours)) in [
            (time_dist.day_pct, 12.0),
            (time_dist.evening_pct, 4.0),
            (time_dist.night_pct, 8.0),
        ]
        .iter()
        .enumerate()
        {
            let flows = road::build_period_flows(light, medium, heavy, moto, speed, *pct, *hours);
            let emission = road::line_source_emission(&flows, surf_corr);
            let v = iso9613::propagate_variants_full(
                &emission,
                d_slant,
                SourceGeometry::Line,
                ground_g,
                &terrain.attenuation_bands,
                &screening_atten,
                &veg_atten,
                reflection,
                flc,
            );
            seg_variants[pi].add(&v);
            if pi == 0 {
                for j in 0..NUM_BANDS {
                    day_emission_energy += crate::propagation::iso9613::fast_exp_f64(
                        emission[j] * std::f64::consts::LN_10 * 0.1,
                    );
                }
            }
            period_emissions[pi] = emission;
        }

        // Group by (ref, name, class) — all "D1 motorway" segments → one contributor
        // Ref inheritance: an orphan mainline or its link inherits the ref of
        // the nearest mainline that carries one. Link classes 10/11/12 map to
        // their mainline parents 0/1/2 (so a GC-1 on-ramp with no OSM ref=* tag
        // groups under "GC-1 (link)" instead of "osm:123").
        let infer_target_class = match class_idx {
            0 | 10 => Some(0),
            1 | 11 => Some(1),
            2 | 12 => Some(2),
            _ => None,
        };
        let effective_ref = if seg.road_ref.is_empty() && infer_target_class.is_some() {
            let target = infer_target_class.unwrap();
            let mut best_ref = String::new();
            let mut best_dist = f64::MAX;
            for other in roads.iter() {
                if (other.road_class as usize) != target {
                    continue;
                }
                if other.road_ref.is_empty() {
                    continue;
                }
                let d = ((seg.cp_lat - other.cp_lat).powi(2) + (seg.cp_lon - other.cp_lon).powi(2))
                    .sqrt();
                if d < best_dist {
                    best_dist = d;
                    best_ref = other.road_ref.clone();
                }
            }
            best_ref
        } else {
            seg.road_ref.clone()
        };

        // For unnamed roads: group per osm_id (like railway), not catch-all
        let key_ref = if effective_ref.is_empty() && seg.name.is_empty() {
            format!("osm:{}", seg.osm_id)
        } else {
            effective_ref.clone()
        };

        let key = (key_ref.clone(), seg.name.clone(), seg.road_class);
        let link_suffix = match class_idx {
            10 | 11 | 12 => " (link)",
            _ => "",
        };
        let acc = roads_by_key.entry(key).or_insert_with(|| {
            let display_name = if !effective_ref.is_empty() && !seg.name.is_empty() {
                format!("{} — {}{}", effective_ref, seg.name, link_suffix)
            } else if !effective_ref.is_empty() {
                format!("{}{}", effective_ref, link_suffix)
            } else if !seg.name.is_empty() {
                format!("{}{}", seg.name, link_suffix)
            } else {
                // Fallback with distance badge for unnamed roads
                let class_label = match class_idx {
                    0 => "Motorway",
                    1 => "Trunk road",
                    2 => "Primary road",
                    3 => "Secondary road",
                    4 => "Tertiary road",
                    5 => "Local road",
                    6 => "Living street",
                    7 => "Service road",
                    8 => "Track",
                    9 => "Unclassified road",
                    10 => "Motorway link",
                    11 => "Trunk link",
                    12 => "Primary link",
                    _ => "Road",
                };
                let dist = seg.dist_m;
                if dist < 100.0 {
                    format!("{} ({}m)", class_label, dist as u32)
                } else if dist < 1000.0 {
                    format!("{} ({}m)", class_label, (dist / 10.0).round() as u32 * 10)
                } else {
                    format!("{} ({:.1}km)", class_label, dist / 1000.0)
                }
            };
            RoadAccum {
                class_name,
                display_name,
                first_osm_id: seg.osm_id,
                min_dist: f64::MAX,
                min_d_slant: 0.0,
                min_ground_g: 0.5,
                closest_cp_lat: seg.cp_lat,
                closest_cp_lon: seg.cp_lon,
                closest_src_height: src_alt,
                dominant_energy: 0.0,
                dominant_segment_idx: 0,
                dominant_distance_m: 0.0,
                dominant_aadt_light_raw: 0,
                dominant_aadt_medium_raw: 0,
                dominant_aadt_heavy_raw: 0,
                dominant_aadt_moto_raw: 0,
                dominant_aadt_light_nominal: 0.0,
                dominant_aadt_medium_nominal: 0.0,
                dominant_aadt_heavy_nominal: 0.0,
                dominant_aadt_moto_nominal: 0.0,
                dominant_aadt_light_effective: 0.0,
                dominant_aadt_medium_effective: 0.0,
                dominant_aadt_heavy_effective: 0.0,
                dominant_aadt_moto_effective: 0.0,
                dominant_traffic_source: "default_by_class",
                dominant_source_id: 0,
                dominant_speed_posted: 0,
                dominant_speed_used: 0.0,
                dominant_speed_source: "default_by_class",
                dominant_surface_type: 0,
                dominant_surface_corr_db: 0.0,
                dominant_lanes: 0,
                dominant_oneway: false,
                segment_count: 0,
                total_length_m: 0.0,
                bridge_count: 0,
                speed_min: f64::MAX,
                speed_max: 0.0,
                oneway_segment_count: 0,
                twoway_segment_count: 0,
                obstacle_segment_count: 0,
                obstacle_height_sum: 0.0,
                obstacle_max_height: 0.0,
                obstacle_max_segment_idx: 0,
                variants: [
                    PropagationVariants::default(),
                    PropagationVariants::default(),
                    PropagationVariants::default(),
                ],
                emission_energy: 0.0,
                line_coords: Vec::new(),
                dominant_trace_idx: None,
            }
        });
        // Aggregation across all grouped segments (independent of closest check)
        acc.segment_count += 1;
        acc.total_length_m += seg.length_m as f64;
        if seg.bridge {
            acc.bridge_count += 1;
        }
        // Cheap group-level obstacle histogram — another tile-cached scan of the
        // same path as screening_atten just computed. Popup shows "N of M segments
        // had obstacles on path" based on this.
        {
            let (seg_max_bh, _) = rasters.max_building_along_path(
                seg.cp_lat,
                seg.cp_lon,
                receiver.lat,
                receiver.lon,
                seg.dist_m,
                0.0,
            );
            if seg_max_bh > 2.0 {
                acc.obstacle_segment_count += 1;
                acc.obstacle_height_sum += seg_max_bh;
                if seg_max_bh > acc.obstacle_max_height {
                    acc.obstacle_max_height = seg_max_bh;
                    acc.obstacle_max_segment_idx = seg.segment_idx;
                }
            }
        }
        for pi in 0..3 {
            acc.variants[pi].add(&seg_variants[pi]);
        }
        acc.emission_energy += day_emission_energy;
        // Aggregate stats across all segments
        if speed < acc.speed_min {
            acc.speed_min = speed;
        }
        if speed > acc.speed_max {
            acc.speed_max = speed;
        }
        if seg.oneway {
            acc.oneway_segment_count += 1;
        } else {
            acc.twoway_segment_count += 1;
        }
        // Closest segment — for distance display, baseline, and path-effect context
        if seg.dist_m < acc.min_dist {
            acc.min_dist = seg.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.closest_cp_lat = seg.cp_lat;
            acc.closest_cp_lon = seg.cp_lon;
            acc.closest_src_height = src_alt;
        }
        // Popup trace: push a SegmentTrace for this segment if the caller wants
        // per-segment engine state. `std::mem::take` consumes the path_profile
        // (not reused below) so the trace owns the sample arrays without clone.
        let pushed_trace_idx: Option<usize> = if let Some(t) = traces.as_deref_mut() {
            let trace = build_road_segment_trace(BuildRoadTrace {
                seg,
                class_name,
                src_alt,
                rcv_alt,
                d_slant,
                flc,
                ground_g,
                reflection_boost_db: reflection,
                light,
                medium,
                heavy,
                moto,
                speed_kmh: speed,
                surf_corr,
                path_profile: std::mem::take(&mut path_profile),
                terrain,
                screening_atten,
                obstacle_trace,
                veg_atten,
                seg_variants,
                lw_bands: period_emissions,
            });
            let idx = t.segments.len();
            t.segments.push(trace);
            Some(idx)
        } else {
            None
        };

        // Dominant segment — highest received energy, drives the popup metadata
        let seg_received_energy: f64 = seg_variants[0].full_energy;
        if seg_received_energy > acc.dominant_energy {
            if let Some(idx) = pushed_trace_idx {
                acc.dominant_trace_idx = Some(idx);
            }
            acc.dominant_energy = seg_received_energy;
            acc.dominant_segment_idx = seg.segment_idx;
            acc.dominant_distance_m = seg.dist_m;
            acc.dominant_aadt_light_raw = seg.aadt_light;
            acc.dominant_aadt_medium_raw = seg.aadt_medium;
            acc.dominant_aadt_heavy_raw = seg.aadt_heavy;
            acc.dominant_aadt_moto_raw = seg.aadt_moto;
            let provenance = sources::provenance_of(seg.source_id);
            let (nom_l, nom_m, nom_h, nom_x) = normalize::nominal_road_aadt(
                seg.road_class,
                provenance,
                seg.aadt_light,
                seg.aadt_medium,
                seg.aadt_heavy,
                seg.aadt_moto,
                admin,
            );
            acc.dominant_aadt_light_nominal = nom_l;
            acc.dominant_aadt_medium_nominal = nom_m;
            acc.dominant_aadt_heavy_nominal = nom_h;
            acc.dominant_aadt_moto_nominal = nom_x;
            acc.dominant_aadt_light_effective = light;
            acc.dominant_aadt_medium_effective = medium;
            acc.dominant_aadt_heavy_effective = heavy;
            acc.dominant_aadt_moto_effective = moto;
            acc.dominant_traffic_source = if provenance.has_data() && seg.aadt_light > 0 {
                provenance.legacy_traffic_source_str()
            } else {
                "default_by_class"
            };
            acc.dominant_source_id = seg.source_id;
            acc.dominant_speed_posted = seg.speed_limit;
            acc.dominant_speed_used = speed;
            acc.dominant_speed_source = if seg.junction == 1 {
                if speed < base_speed {
                    "roundabout_cap"
                } else {
                    "osm_posted"
                }
            } else if seg.speed_limit > 0 {
                "osm_posted"
            } else {
                "default_by_class"
            };
            acc.dominant_surface_type = seg.surface_type;
            acc.dominant_surface_corr_db = surf_corr;
            acc.dominant_lanes = seg.lanes;
            acc.dominant_oneway = seg.oneway;
        }
        // Each segment is an independent 2-point LineString; no osm_id regrouping needed.
        acc.line_coords
            .push([[seg.start_lon, seg.start_lat], [seg.end_lon, seg.end_lat]]);
    }

    // Mark the dominant-of-group traces now that all segments are processed.
    if let Some(t) = traces.as_deref_mut() {
        for acc in roads_by_key.values() {
            if let Some(idx) = acc.dominant_trace_idx {
                if let Some(tr) = t.segments.get_mut(idx) {
                    tr.is_dominant_of_group = true;
                }
            }
        }
    }

    // Emit grouped contributors
    let mut contributors = Vec::new();
    for ((_ref, _name, _class), acc) in &roads_by_key {
        // Full energy from variants (includes all path effects per-band)
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let road_periods = periods::periods(ld, le, ln);

        // Free-field energy (for comparison)
        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let emission_db = 10.0 * acc.emission_energy.max(1e-12).log10();
        let geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else {
            None
        };

        let impacts = PropagationVariants::impact_deltas(&acc.variants, road_periods.lden_db);

        let (nearest_terrain, nearest_screening, nearest_veg) = compute_path_effects(
            rasters,
            barriers,
            acc.closest_cp_lat,
            acc.closest_cp_lon,
            acc.closest_src_height,
            receiver,
            acc.min_dist,
            0.0,
        );

        let road_meta = RoadMetadata {
            aadt_light_raw: acc.dominant_aadt_light_raw,
            aadt_medium_raw: acc.dominant_aadt_medium_raw,
            aadt_heavy_raw: acc.dominant_aadt_heavy_raw,
            aadt_moto_raw: acc.dominant_aadt_moto_raw,
            traffic_source: acc.dominant_traffic_source,
            dominant_source_id: acc.dominant_source_id,
            speed_posted_kmh: acc.dominant_speed_posted,
            aadt_light_nominal: acc.dominant_aadt_light_nominal,
            aadt_medium_nominal: acc.dominant_aadt_medium_nominal,
            aadt_heavy_nominal: acc.dominant_aadt_heavy_nominal,
            aadt_moto_nominal: acc.dominant_aadt_moto_nominal,
            aadt_light_effective: acc.dominant_aadt_light_effective,
            aadt_medium_effective: acc.dominant_aadt_medium_effective,
            aadt_heavy_effective: acc.dominant_aadt_heavy_effective,
            aadt_moto_effective: acc.dominant_aadt_moto_effective,
            speed_kmh: acc.dominant_speed_used,
            speed_source: acc.dominant_speed_source,
            road_class: acc.class_name,
            surface: surface_name(acc.dominant_surface_type),
            surface_corr_db: acc.dominant_surface_corr_db,
            lanes: acc.dominant_lanes,
            oneway: acc.dominant_oneway,
            dominant_segment_idx: acc.dominant_segment_idx,
            dominant_distance_m: acc.dominant_distance_m,
            closest_distance_m: acc.min_dist,
            speed_min_kmh: acc.speed_min,
            speed_max_kmh: acc.speed_max,
            oneway_segment_count: acc.oneway_segment_count,
            twoway_segment_count: acc.twoway_segment_count,
            segment_count: acc.segment_count,
            total_length_m: acc.total_length_m,
            bridge_count: acc.bridge_count,
            obstacle_segment_count: acc.obstacle_segment_count,
            obstacle_avg_height_m: if acc.obstacle_segment_count > 0 {
                (acc.obstacle_height_sum / acc.obstacle_segment_count as f64 * 10.0).round() / 10.0
            } else {
                0.0
            },
            obstacle_max_height_m: (acc.obstacle_max_height * 10.0).round() / 10.0,
            obstacle_max_segment_idx: acc.obstacle_max_segment_idx,
        };

        contributors.push(Contributor {
            osm_id: Some(acc.first_osm_id),
            geometry,
            source_type: LayerKind::Road,
            name: acc.display_name.clone(),
            subtype: acc.class_name.to_string(),
            distance_m: acc.min_dist,
            periods: road_periods,
            periods_free: free_periods,
            emission_db,
            baseline: iso9613::compute_baseline(
                acc.min_d_slant,
                SourceGeometry::Line,
                acc.min_ground_g,
            ),
            terrain: nearest_terrain,
            screening: nearest_screening,
            vegetation: nearest_veg,
            terrain_impact_db: round1(impacts.terrain),
            screening_impact_db: round1(impacts.screening),
            vegetation_impact_db: round1(impacts.vegetation),
            atmospheric_impact_db: round1(impacts.atmospheric),
            ground_impact_db: round1(impacts.ground),
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
            metadata: Some(SourceMetadata::Road(road_meta)),
        });
    }

    // Total must come from all grouped energies, not from display-filtered contributors.
    let mut total_energy = [0.0f64; 3];
    for acc in roads_by_key.values() {
        total_energy[0] += acc.variants[0].full_energy;
        total_energy[1] += acc.variants[1].full_energy;
        total_energy[2] += acc.variants[2].full_energy;
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
    mut traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>) {
    use emission::railway::{self, RailType};
    use std::collections::HashMap;

    struct RailAccum {
        name: String,
        rail_type: RailType,
        rail_type_u8: u8,
        usage_u8: u8,
        first_osm_id: i64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        cp_lat: f64,
        cp_lon: f64,
        src_height: f64,
        // Closest-segment metadata (for popup)
        closest_trains_passenger_raw: f64,
        closest_trains_freight_raw: f64,
        closest_trains_passenger_effective: f64,
        closest_trains_freight_effective: f64,
        closest_trains_passenger_source: &'static str,
        closest_trains_freight_source: &'static str,
        closest_source_id: u16,
        closest_maxspeed_posted: u8,
        closest_speed_used: f64,
        closest_speed_source: &'static str,
        closest_service: bool,
        closest_highspeed: bool,
        closest_parallel_divisor: u8,
        // Aggregation
        segment_count: u32,
        total_length_m: f64,
        // Group-level screening obstacle histogram
        obstacle_segment_count: u32,
        obstacle_height_sum: f64,
        obstacle_max_height: f64,
        obstacle_max_segment_idx: i16,
        variants: [PropagationVariants; 3],
        emission_energy: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
        has_bridge: bool,
        dominant_energy: f64,
        dominant_trace_idx: Option<usize>,
    }
    let mut rails_by_key: HashMap<(String, u8), RailAccum> = HashMap::new();

    let day_pct = 0.65;
    let eve_pct = 0.20;
    let night_pct = 0.15;
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    for seg in railways {
        if seg.tunnel {
            continue;
        }
        if seg.dist_m > 8000.0 {
            continue;
        }

        let src_elev = rasters.elevation(seg.cp_lat, seg.cp_lon);
        let src_alt = src_elev + SOURCE_HEIGHT_RAIL;
        let d_slant = geo::slant_dist(seg.dist_m, src_alt, receiver.altitude_m());
        if d_slant < 1.0 {
            continue;
        }

        let rail_type = RailType::from_u8(seg.rail_type);
        let speed = if seg.speed_kmh > 0 {
            seg.speed_kmh as f64
        } else {
            80.0
        };
        let q_pax = seg.trains_passenger.max(0.0);
        let q_frt = seg.trains_freight.max(0.0);
        if q_pax + q_frt <= 0.0 {
            continue;
        }

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let ee =
                railway::railway_emission(rail_type, speed, q_pax * day_pct, q_frt * day_pct, 12.0);
            let me = ee.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            if geo::below_free_field_threshold_line(me, seg.dist_m, 0.0) {
                continue;
            }
        }

        let rcv_alt = receiver.altitude_m();
        let flc = geo::finite_line_correction(seg.length_m as f64, seg.dist_m, seg.fraction);

        // Unified path profile — one sampling, four rasters.
        let mut path_profile = propagation::PathProfile::new();
        rasters.build_path_profile(
            seg.cp_lat,
            seg.cp_lon,
            receiver.lat,
            receiver.lon,
            seg.dist_m,
            &mut path_profile,
        );
        // Bridge: hard surface below → G=0. Otherwise line-averaged G along path.
        let ground_g = if seg.bridge {
            0.0
        } else {
            propagation::path_effects::ground_g_from_profile(&path_profile)
        };
        let (terrain, _terrain_profile_points) =
            propagation::path_effects::terrain_attenuation_with_meta(
                &mut path_profile,
                src_alt,
                rcv_alt,
            );
        let (screening_atten, obstacle_trace) =
            propagation::path_effects::screening_attenuation_with_meta(
        &mut path_profile,
                barriers,
                src_alt,
                rcv_alt,
                0.0, // railways: no exclusion radius
                &terrain.attenuation_bands,
            );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(&path_profile);

        let mut seg_variants = [
            PropagationVariants::default(),
            PropagationVariants::default(),
            PropagationVariants::default(),
        ];
        let mut day_emission_energy = 0.0f64;
        let period_hours = [12.0f64, 4.0, 8.0];
        let mut period_emissions: [[f64; NUM_BANDS]; 3] = [[0.0; NUM_BANDS]; 3];
        for (pi, pct) in [day_pct, eve_pct, night_pct].iter().enumerate() {
            let emission = railway::railway_emission(
                rail_type,
                speed,
                q_pax * pct,
                q_frt * pct,
                period_hours[pi],
            );
            let v = iso9613::propagate_variants_full(
                &emission,
                d_slant,
                SourceGeometry::Line,
                ground_g,
                &terrain.attenuation_bands,
                &screening_atten,
                &veg_atten,
                reflection,
                flc,
            );
            seg_variants[pi].add(&v);
            if pi == 0 {
                for j in 0..NUM_BANDS {
                    day_emission_energy += crate::propagation::iso9613::fast_exp_f64(
                        emission[j] * std::f64::consts::LN_10 * 0.1,
                    );
                }
            }
            period_emissions[pi] = emission;
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
            rail_type,
            rail_type_u8: seg.rail_type,
            usage_u8: seg.usage,
            first_osm_id: seg.osm_id,
            min_dist: f64::MAX,
            min_d_slant: 0.0,
            min_ground_g: 0.5,
            cp_lat: seg.cp_lat,
            cp_lon: seg.cp_lon,
            src_height: src_alt,
            closest_trains_passenger_raw: 0.0,
            closest_trains_freight_raw: 0.0,
            closest_trains_passenger_effective: 0.0,
            closest_trains_freight_effective: 0.0,
            closest_trains_passenger_source: "default_by_type",
            closest_trains_freight_source: "default_by_type",
            closest_source_id: 0,
            closest_maxspeed_posted: 0,
            closest_speed_used: 0.0,
            closest_speed_source: "type_default",
            closest_service: false,
            closest_highspeed: false,
            closest_parallel_divisor: 1,
            segment_count: 0,
            total_length_m: 0.0,
            obstacle_segment_count: 0,
            obstacle_height_sum: 0.0,
            obstacle_max_height: 0.0,
            obstacle_max_segment_idx: 0,
            variants: [
                PropagationVariants::default(),
                PropagationVariants::default(),
                PropagationVariants::default(),
            ],
            emission_energy: 0.0,
            line_coords: Vec::new(),
            has_bridge: false,
            dominant_energy: 0.0,
            dominant_trace_idx: None,
        });
        // Aggregation
        acc.segment_count += 1;
        acc.total_length_m += seg.length_m as f64;
        // Group-level obstacle histogram
        {
            let (seg_max_bh, _) = rasters.max_building_along_path(
                seg.cp_lat,
                seg.cp_lon,
                receiver.lat,
                receiver.lon,
                seg.dist_m,
                0.0,
            );
            if seg_max_bh > 2.0 {
                acc.obstacle_segment_count += 1;
                acc.obstacle_height_sum += seg_max_bh;
                if seg_max_bh > acc.obstacle_max_height {
                    acc.obstacle_max_height = seg_max_bh;
                    acc.obstacle_max_segment_idx = seg.segment_idx;
                }
            }
        }
        for pi in 0..3 {
            acc.variants[pi].add(&seg_variants[pi]);
        }
        acc.emission_energy += day_emission_energy;
        if seg.bridge {
            acc.has_bridge = true;
        }
        if seg.dist_m < acc.min_dist {
            acc.min_dist = seg.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.cp_lat = seg.cp_lat;
            acc.cp_lon = seg.cp_lon;
            acc.src_height = src_alt;
            // Closest-segment metadata for popup
            acc.closest_trains_passenger_raw = seg.trains_passenger;
            acc.closest_trains_freight_raw = seg.trains_freight;
            acc.closest_trains_passenger_effective = q_pax;
            acc.closest_trains_freight_effective = q_frt;
            acc.closest_trains_passenger_source = match seg.trains_passenger_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.closest_trains_freight_source = match seg.trains_freight_source {
                0 => "arrow",
                _ => "default_by_type",
            };
            acc.closest_source_id = seg.source_id;
            acc.closest_maxspeed_posted = seg.maxspeed;
            acc.closest_speed_used = speed;
            acc.closest_speed_source = match seg.speed_source {
                0 => "osm_maxspeed",
                1 => "highspeed_default",
                _ => "type_default",
            };
            acc.closest_service = seg.service;
            acc.closest_highspeed = seg.highspeed;
            acc.closest_parallel_divisor = seg.parallel_divisor.max(1);
        }
        acc.line_coords
            .push([[seg.start_lon, seg.start_lat], [seg.end_lon, seg.end_lat]]);

        // Popup trace: push per-segment trace + track the dominant one for this
        // group so we can flip is_dominant_of_group once the loop finishes.
        if let Some(t) = traces.as_deref_mut() {
            let trace = build_rail_segment_trace(BuildRailTrace {
                seg,
                src_alt,
                rcv_alt,
                d_slant,
                flc,
                ground_g,
                reflection_boost_db: reflection,
                q_pax,
                q_frt,
                speed_kmh: speed,
                path_profile: std::mem::take(&mut path_profile),
                terrain,
                screening_atten,
                obstacle_trace,
                veg_atten,
                seg_variants,
                lw_bands: period_emissions,
            });
            let trace_idx = t.segments.len();
            t.segments.push(trace);
            let seg_energy: f64 = seg_variants[0].full_energy;
            if seg_energy > acc.dominant_energy {
                    acc.dominant_energy = seg_energy;
                acc.dominant_trace_idx = Some(trace_idx);
            }
        }
    }

    if let Some(t) = traces.as_deref_mut() {
        for acc in rails_by_key.values() {
            if let Some(idx) = acc.dominant_trace_idx {
                if let Some(tr) = t.segments.get_mut(idx) {
                    tr.is_dominant_of_group = true;
                }
            }
        }
    }

    let mut contributors = Vec::new();
    for ((_key, _rt), acc) in &rails_by_key {
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let rail_periods = periods::periods(ld, le, ln);

        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else {
            None
        };

        let rail_effects = compute_path_effects(
            rasters,
            barriers,
            acc.cp_lat,
            acc.cp_lon,
            acc.src_height,
            receiver,
            acc.min_dist,
            0.0,
        );

        let impacts = PropagationVariants::impact_deltas(&acc.variants, rail_periods.lden_db);

        let rail_meta = RailMetadata {
            trains_passenger_raw: acc.closest_trains_passenger_raw,
            trains_freight_raw: acc.closest_trains_freight_raw,
            trains_passenger_source: acc.closest_trains_passenger_source,
            trains_freight_source: acc.closest_trains_freight_source,
            source_id: acc.closest_source_id,
            maxspeed_posted_kmh: acc.closest_maxspeed_posted,
            trains_passenger_effective: acc.closest_trains_passenger_effective,
            trains_freight_effective: acc.closest_trains_freight_effective,
            speed_kmh: acc.closest_speed_used,
            speed_source: acc.closest_speed_source,
            rail_type: rail_type_name(acc.rail_type_u8),
            usage: rail_usage_name(acc.usage_u8),
            service: acc.closest_service,
            highspeed: acc.closest_highspeed,
            parallel_divisor: acc.closest_parallel_divisor,
            bridge: acc.has_bridge,
            segment_count: acc.segment_count,
            total_length_m: acc.total_length_m,
            obstacle_segment_count: acc.obstacle_segment_count,
            obstacle_avg_height_m: if acc.obstacle_segment_count > 0 {
                (acc.obstacle_height_sum / acc.obstacle_segment_count as f64 * 10.0).round() / 10.0
            } else {
                0.0
            },
            obstacle_max_height_m: (acc.obstacle_max_height * 10.0).round() / 10.0,
            obstacle_max_segment_idx: acc.obstacle_max_segment_idx,
        };

        contributors.push(Contributor {
            osm_id: Some(acc.first_osm_id),
            geometry,
            source_type: LayerKind::Railway,
            name: if acc.name.is_empty() {
                String::new()
            } else {
                acc.name.clone()
            },
            subtype: {
                let base = format!("{:?}", acc.rail_type);
                if acc.has_bridge {
                    format!("{} (bridge)", base)
                } else {
                    base
                }
            },
            distance_m: acc.min_dist,
            periods: rail_periods,
            periods_free: free_periods,
            emission_db: 10.0 * acc.emission_energy.max(1e-12).log10(),
            baseline: iso9613::compute_baseline(
                acc.min_d_slant,
                SourceGeometry::Line,
                acc.min_ground_g,
            ),
            terrain: rail_effects.0,
            screening: rail_effects.1,
            vegetation: rail_effects.2,
            terrain_impact_db: round1(impacts.terrain),
            screening_impact_db: round1(impacts.screening),
            vegetation_impact_db: round1(impacts.vegetation),
            atmospheric_impact_db: round1(impacts.atmospheric),
            ground_impact_db: round1(impacts.ground),
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
            metadata: Some(SourceMetadata::Rail(rail_meta)),
        });
    }

    let mut total_energy = [0.0f64; 3];
    for acc in rails_by_key.values() {
        total_energy[0] += acc.variants[0].full_energy;
        total_energy[1] += acc.variants[1].full_energy;
        total_energy[2] += acc.variants[2].full_energy;
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
    source_kind: LayerKind,
    mut traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>) {
    use std::collections::HashMap;

    struct PtAccum {
        name: String,
        subtype: u8,
        lat: f64,
        lon: f64,
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

    for src in sources {
        let max_d = src.max_radius_m.max(0.0);
        if src.dist_m > max_d {
            continue;
        }

        let src_alt = rasters.elevation(src.lat, src.lon) + src.source_height_m as f64;
        let rcv_alt = receiver.altitude_m();
        let prop_dist = geo::effective_area_source_dist(src.dist_m, src.exclusion_radius_m as f64);
        let d_slant = geo::slant_dist(prop_dist, src_alt, rcv_alt).max(1.0);

        // Early exit: skip if free-field < threshold (matching pipeline)
        {
            let me = src.lw_day.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
            if geo::below_free_field_threshold(me, src.dist_m, 0.0) {
                continue;
            }
        }

        // Unified path profile — one sampling, all path effects read from it.
        let mut path_profile = propagation::PathProfile::new();
        rasters.build_path_profile(
            src.lat,
            src.lon,
            receiver.lat,
            receiver.lon,
            src.dist_m,
            &mut path_profile,
        );
        let (terrain, _terrain_profile_points) =
            propagation::path_effects::terrain_attenuation_with_meta(
                &mut path_profile,
                src_alt,
                rcv_alt,
            );
        let (screening_atten, obstacle_trace) =
            propagation::path_effects::screening_attenuation_with_meta(
        &mut path_profile,
                barriers,
                src_alt,
                rcv_alt,
                src.exclusion_radius_m as f64,
                &terrain.attenuation_bands,
            );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(&path_profile);

        let v_day = iso9613::propagate_variants_full(
            &src.lw_day.map(|v| v as f64),
            d_slant,
            SourceGeometry::Point,
            ground_g,
            &terrain.attenuation_bands,
            &screening_atten,
            &veg_atten,
            reflection,
            0.0,
        );
        let v_eve = iso9613::propagate_variants_full(
            &src.lw_evening.map(|v| v as f64),
            d_slant,
            SourceGeometry::Point,
            ground_g,
            &terrain.attenuation_bands,
            &screening_atten,
            &veg_atten,
            reflection,
            0.0,
        );
        let v_night = iso9613::propagate_variants_full(
            &src.lw_night.map(|v| v as f64),
            d_slant,
            SourceGeometry::Point,
            ground_g,
            &terrain.attenuation_bands,
            &screening_atten,
            &veg_atten,
            reflection,
            0.0,
        );

        let day_em: f64 = src
            .lw_day
            .iter()
            .map(|&v| {
                crate::propagation::iso9613::fast_exp_f64(v as f64 * std::f64::consts::LN_10 * 0.1)
            })
            .sum();

        let acc = pts_by_osm.entry(src.osm_id).or_insert_with(|| PtAccum {
            name: src.name.clone(),
            subtype: src.source_type,
            lat: src.lat,
            lon: src.lon,
            min_dist: f64::MAX,
            min_d_slant: 0.0,
            min_ground_g: 0.5,
            src_height: src_alt,
            exclusion_radius_m: src.exclusion_radius_m,
            variants: [
                PropagationVariants::default(),
                PropagationVariants::default(),
                PropagationVariants::default(),
            ],
            emission_energy: 0.0,
            polygon_wkb: src.polygon_wkb.clone(),
        });
        acc.variants[0].add(&v_day);
        acc.variants[1].add(&v_eve);
        acc.variants[2].add(&v_night);
        acc.emission_energy += day_em;
        if src.dist_m < acc.min_dist {
            acc.min_dist = src.dist_m;
            acc.min_d_slant = d_slant;
            acc.min_ground_g = ground_g;
            acc.lat = src.lat;
            acc.lon = src.lon;
            acc.src_height = src_alt;
            acc.exclusion_radius_m = src.exclusion_radius_m;
        }

        if let Some(t) = traces.as_deref_mut() {
            let seg_variants = [v_day, v_eve, v_night];
            let lw_bands: [[f64; NUM_BANDS]; 3] = [
                std::array::from_fn(|i| src.lw_day[i] as f64),
                std::array::from_fn(|i| src.lw_evening[i] as f64),
                std::array::from_fn(|i| src.lw_night[i] as f64),
            ];
            let trace = build_point_segment_trace(BuildPointTrace {
                src,
                source_kind,
                src_alt,
                rcv_alt,
                d_slant,
                prop_dist,
                ground_g,
                reflection_boost_db: reflection,
                path_profile: std::mem::take(&mut path_profile),
                terrain,
                screening_atten,
                obstacle_trace,
                veg_atten,
                seg_variants,
                lw_bands,
            });
            t.segments.push(trace);
        }
    }

    let mut contributors = Vec::new();
    for (osm_id, acc) in &pts_by_osm {
        let ld = PropagationVariants::to_db(acc.variants[0].full_energy);
        let le = PropagationVariants::to_db(acc.variants[1].full_energy);
        let ln = PropagationVariants::to_db(acc.variants[2].full_energy);
        let pt_periods = periods::periods(ld, le, ln);

        let ld_free = PropagationVariants::to_db(acc.variants[0].free_field_energy);
        let le_free = PropagationVariants::to_db(acc.variants[1].free_field_energy);
        let ln_free = PropagationVariants::to_db(acc.variants[2].free_field_energy);
        let free_periods = periods::periods(ld_free, le_free, ln_free);

        let geometry = if !acc.polygon_wkb.is_empty() {
            wkb_to_geojson(&acc.polygon_wkb).or_else(|| {
                Some(serde_json::json!({
                    "type": "Point", "coordinates": [acc.lon, acc.lat],
                }))
            })
        } else {
            Some(serde_json::json!({
                "type": "Point", "coordinates": [acc.lon, acc.lat],
            }))
        };

        let pt_effects = compute_path_effects(
            rasters,
            barriers,
            acc.lat,
            acc.lon,
            acc.src_height,
            receiver,
            acc.min_dist,
            acc.exclusion_radius_m as f64,
        );

        let impacts = PropagationVariants::impact_deltas(&acc.variants, pt_periods.lden_db);

        let subtype_name: &'static str = if source_kind == LayerKind::Industrial {
            industrial_type_name(acc.subtype)
        } else {
            building_type_name(acc.subtype)
        };

        // Build per-source metadata (popup only)
        let metadata = if source_kind == LayerKind::Industrial {
            Some(SourceMetadata::Industrial(IndustrialMetadata {
                area_m2: 0.0, // derived per-point; aggregate unavailable at this level
                source_type: subtype_name,
                nace: None,
                grid_point_count: 0, // not tracked in accum yet
            }))
        } else {
            // building
            Some(SourceMetadata::Building(BuildingMetadata {
                height_m: (acc.src_height - rasters.elevation(acc.lat, acc.lon)).max(0.0),
                floors: 0, // not preserved after emission calc
                area_m2: 0.0,
                building_type: subtype_name,
                address: acc.name.clone(),
            }))
        };

        contributors.push(Contributor {
            osm_id: Some(*osm_id),
            geometry,
            source_type: source_kind,
            name: acc.name.clone(),
            subtype: subtype_name.to_string(),
            distance_m: acc.min_dist,
            periods: pt_periods,
            periods_free: free_periods,
            emission_db: 10.0 * acc.emission_energy.max(1e-12).log10(),
            baseline: iso9613::compute_baseline(
                acc.min_d_slant,
                SourceGeometry::Point,
                acc.min_ground_g,
            ),
            terrain: pt_effects.0,
            screening: pt_effects.1,
            vegetation: pt_effects.2,
            terrain_impact_db: round1(impacts.terrain),
            screening_impact_db: round1(impacts.screening),
            vegetation_impact_db: round1(impacts.vegetation),
            atmospheric_impact_db: round1(impacts.atmospheric),
            ground_impact_db: round1(impacts.ground),
            received_bands: std::array::from_fn(|j| {
                10.0 * acc.variants[0].band_energy[j].max(1e-30).log10()
            }),
            metadata,
        });
    }

    let mut total_energy = [0.0f64; 3];
    for acc in pts_by_osm.values() {
        total_energy[0] += acc.variants[0].full_energy;
        total_energy[1] += acc.variants[1].full_energy;
        total_energy[2] += acc.variants[2].full_energy;
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
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    n_days: u16,
    mut traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>, AircraftBandData) {
    // Ground ops traces are teed off inline (line source via ISO 9613),
    // airborne traces inside the per-flight stats loop below (Doc 29 — no
    // path profile).
    use emission::aircraft;
    use std::collections::{HashMap, HashSet};

    let rx_elev = receiver.altitude_m();
    let n_days_f = (n_days as f64).max(1.0);
    let reflection = rasters.building_enclosure(receiver.lat, receiver.lon);

    let periods_from_doc29_energy = |energy: [f64; 3]| -> NoisePeriods {
        if energy.iter().sum::<f64>() <= 0.0 {
            return NoisePeriods::silence();
        }
        let ld = aircraft::period_leq(energy[0], n_days_f, aircraft::PERIOD_SECONDS[0]);
        let le = aircraft::period_leq(energy[1], n_days_f, aircraft::PERIOD_SECONDS[1]);
        let ln = aircraft::period_leq(energy[2], n_days_f, aircraft::PERIOD_SECONDS[2]);
        periods::periods(ld, le, ln)
    };
    let periods_from_normalized = |energy: [f64; 3]| -> NoisePeriods {
        if energy.iter().sum::<f64>() <= 0.0 {
            return NoisePeriods::silence();
        }
        periods::periods(
            PropagationVariants::to_db(energy[0]),
            PropagationVariants::to_db(energy[1]),
            PropagationVariants::to_db(energy[2]),
        )
    };
    let periods_from_variants =
        |variants: &[PropagationVariants; 3]| periods_from_normalized([
            variants[0].full_energy,
            variants[1].full_energy,
            variants[2].full_energy,
        ]);

    struct FlightAccum {
        period_energy: [f64; 3],
        peak_lmax: f64,
        peak_sel: f64,
        min_dist_m: f64,
        peak_altitude_m: f64,
        peak_period: u8,
        peak_date_id: i16,
        peak_seg_start: [f64; 2], // [lon, lat]
        peak_seg_end: [f64; 2],
        profile_idx: u8,
        flight_weight: f64,
    }
    struct BandStats {
        count: f64,
        alt_sum: f64,
        // Per-noise-class counts (NUM_CLASSES). Bucket aggregation is at the
        // class level (variant B), so "top type in this band" is class-level.
        class_counts: [u32; aircraft::NUM_CLASSES],
    }
    impl BandStats {
        fn new() -> Self {
            Self {
                count: 0.0,
                alt_sum: 0.0,
                class_counts: [0; aircraft::NUM_CLASSES],
            }
        }
        fn top_type(&self) -> &'static str {
            let idx = self
                .class_counts
                .iter()
                .enumerate()
                .max_by_key(|(_, c)| *c)
                .map(|(i, _)| i)
                .unwrap_or(aircraft::FALLBACK_NOISE_CLASS as usize);
            aircraft::CLASS_NAMES[idx]
        }
    }
    struct GroundAirportAccum {
        name: String,
        airport_key: String,
        variants: [PropagationVariants; 3],
        kind_variants: [[PropagationVariants; 3]; 3],
        observed_any: HashSet<u64>,
        observed_by_kind: [HashSet<u64>; 3],
        modeled_total: f64,
        modeled_by_kind: [f64; 3],
        emission_energy: f64,
        min_dist: f64,
        min_d_slant: f64,
        min_ground_g: f64,
        cp_lat: f64,
        cp_lon: f64,
        src_height: f64,
        line_coords: Vec<[[f64; 2]; 2]>,
    }
    impl GroundAirportAccum {
        fn new(name: String, airport_key: String, receiver: &Receiver) -> Self {
            Self {
                name,
                airport_key,
                variants: std::array::from_fn(|_| PropagationVariants::default()),
                kind_variants: std::array::from_fn(|_| {
                    std::array::from_fn(|_| PropagationVariants::default())
                }),
                observed_any: HashSet::new(),
                observed_by_kind: std::array::from_fn(|_| HashSet::new()),
                modeled_total: 0.0,
                modeled_by_kind: [0.0; 3],
                emission_energy: 0.0,
                line_coords: Vec::new(),
                min_dist: f64::INFINITY,
                min_d_slant: f64::INFINITY,
                min_ground_g: 0.5,
                cp_lat: receiver.lat,
                cp_lon: receiver.lon,
                src_height: receiver.altitude_m(),
            }
        }
    }

    let mut flights: HashMap<u64, FlightAccum> = HashMap::new();
    let airport_groups = aircraft::airport_ground_groups(airport_lines, airport_areas);
    let mut ground_by_airport: HashMap<String, GroundAirportAccum> = HashMap::new();
    let mut ground_variants = [PropagationVariants::default(); 3];
    let mut ground_kind_variants: [[PropagationVariants; 3]; 3] =
        std::array::from_fn(|_| std::array::from_fn(|_| PropagationVariants::default()));
    let mut ground_observed_any: HashSet<u64> = HashSet::new();
    let mut ground_observed_by_kind: [HashSet<u64>; 3] =
        std::array::from_fn(|_| HashSet::new());
    let mut ground_modeled_total = 0.0f64;
    let mut ground_modeled_by_kind = [0.0f64; 3];
    let mut ground_min_dist = f64::INFINITY;
    let mut ground_min_d_slant = f64::INFINITY;
    let mut ground_min_ground_g = 0.5;
    let mut ground_cp_lat = receiver.lat;
    let mut ground_cp_lon = receiver.lon;
    let mut ground_src_height = receiver.altitude_m();

    // Aggregate ground-ops segments into bucketed line sources up front.
    // At airport receivers (Ruzyně) thousands of co-located ADS-B segments
    // collapse into ~hundreds of buckets — propagating once per bucket
    // saves the bulk of `propagate_variants_full` + `build_path_profile`
    // work that previously ran per segment. Pipeline already ships with
    // the same bucketing; this puts popup on the same line-source regime,
    // and parity becomes a structural property.
    //
    // Cheap pre-gate: skip the HashMap allocation when there is no
    // ground-context segment in this query (Dobříš and other rural
    // receivers — most popup queries). The scan is O(n) byte compares,
    // dominated by branch prediction; cheaper than `bucket_ground_ops`
    // even at zero-bucket queries because of the avoided allocator hit.
    let has_ground_candidate = segments.iter().any(|s| {
        s.ground_context != aircraft::GROUND_CONTEXT_NONE || s.surface_model || s.on_ground
    });
    let ground_buckets = if has_ground_candidate {
        aircraft::bucket_ground_ops(segments, rasters, n_days)
    } else {
        Vec::new()
    };

    // Hoist NpdLuts reference once per query — kernel inner math then sees
    // a plain `&NpdLuts` instead of paying an `OnceLock` Acquire load on
    // every (segment × receiver) call. Saves up to 100 k atomic loads per
    // popup at airport-scale densities.
    let npd_luts = aircraft::NpdLuts::shared();

    for seg in segments {
        // Pipeline filters this at projection. Doing it first here too
        // skips ~5 raster-elevation lookups + a kernel call for cruise
        // rep-line rows whose density rounded to zero.
        let weight = seg.count_weight.max(0.0) as f64;
        if weight <= 0.0 {
            continue;
        }
        // Ground-ops segments (surface_model flag or airport-ground class)
        // accumulate into buckets earlier in this fn. Skip here so they
        // don't double-count. Cheap path: returns on the surface_model
        // flag or the ground_context byte without sampling rasters.
        if aircraft::is_ground_ops_segment(seg, rasters) {
            continue;
        }
        // Sample terrain at five points along the segment in one batch.
        // Old chain (`is_ground_stale` + `is_valid_airborne` + Filter D
        // cuts in the kernel) sampled start/end three times each — nine
        // lookups per typical airborne. Five-sample cache cuts that to
        // five and feeds Filter D via segment_sel_with_terrain.
        let terrain = aircraft::SegmentTerrain::sample(seg, rasters);
        if aircraft::is_ground_stale_with_terrain(seg, &terrain) {
            continue;
        }
        if !aircraft::is_valid_airborne_with_terrain(seg, &terrain) {
            continue;
        }

        let (sel, cpa) = match aircraft::segment_sel_with_terrain(
            seg,
            receiver.lat,
            receiver.lon,
            rx_elev,
            &terrain,
            npd_luts,
        ) {
            Some(v) => v,
            None => continue,
        };
        let energy =
            crate::propagation::iso9613::fast_exp_f64(sel * std::f64::consts::LN_10 * 0.1) * weight;
        let period = seg.period.min(2) as usize;
        let acc = flights.entry(seg.flight_id).or_insert(FlightAccum {
            period_energy: [0.0; 3],
            peak_lmax: -999.0,
            peak_sel: -999.0,
            min_dist_m: f64::MAX,
            peak_altitude_m: 0.0,
            peak_period: 0,
            peak_date_id: 0,
            peak_seg_start: [0.0; 2],
            peak_seg_end: [0.0; 2],
            profile_idx: seg.profile_idx,
            flight_weight: weight,
        });
        acc.period_energy[period] += energy;
        // Peak event Lmax — looked up directly from the per-class LAmax NPD
        // LUT at the segment's slant distance. Replaces the prior hardcoded
        // `sel - 12.0` approximation that had ±5 dB bias across operations
        // (Doc 29 §A.2.1 / FAA AEDT TM §6 measure SEL−Lmax = 8–18 dB
        // depending on flight geometry). LAmax NPD is per-aircraft per-
        // distance, so this fixes the systematic under/over-estimate of
        // peak event noise without per-event ΔI/Λ corrections (those are
        // < 0.5 dB at typical TMA approach β).
        let class_idx = aircraft::noise_class_of(seg.profile_idx) as usize;
        let log_d = (cpa.d_p_m * aircraft::FT_PER_M).max(100.0).log10();
        let lmax = npd_luts.lookup_lmax(class_idx, seg.is_departure, log_d);
        if lmax > acc.peak_lmax {
            acc.peak_lmax = lmax;
            acc.peak_sel = sel;
            acc.peak_altitude_m = cpa.relative_alt_m;
            acc.peak_period = seg.period;
            acc.peak_date_id = seg.date_id;
            acc.peak_seg_start = [seg.start_lon, seg.start_lat];
            acc.peak_seg_end = [seg.end_lon, seg.end_lat];
        }
        if cpa.d_p_m < acc.min_dist_m {
            acc.min_dist_m = cpa.d_p_m;
        }
        if weight > acc.flight_weight {
            acc.flight_weight = weight;
        }
    }

    // Pipeline-shape accumulation: each bucket is one line source carrying
    // the energy of N (~5-10) co-located ADS-B segments. Path effects
    // (build_path_profile, terrain, screening, vegetation) computed once
    // per bucket instead of once per segment — popup mirror of pipeline's
    // bucketed scatter at `pipeline-worker/src/main.rs`.
    for bucket in &ground_buckets {
        let kind_idx = (bucket.kind.saturating_sub(1) as usize).min(2);
        let mid_lat = (bucket.start_lat + bucket.end_lat) * 0.5;
        let mid_lon = (bucket.start_lon + bucket.end_lon) * 0.5;

        let (group_name, group_key) = if let Some(mut group_idx) =
            aircraft::assign_segment_to_airport_group(
                &bucket.representative_seg,
                &airport_groups,
                rasters,
            ) {
            // Resolve unnamed groups by snapping to the nearest named group within 2.5 km.
            // Same heuristic the per-segment code used; applied once per bucket here.
            if airport_groups[group_idx].name.trim().is_empty()
                && airport_groups[group_idx].airport_key.trim().is_empty()
            {
                if let Some((resolved_idx, _)) = airport_groups
                    .iter()
                    .enumerate()
                    .filter(|(idx, group)| {
                        *idx != group_idx
                            && (!group.name.trim().is_empty()
                                || !group.airport_key.trim().is_empty())
                    })
                    .map(|(idx, group)| {
                        (
                            idx,
                            geo::flat_dist(
                                airport_groups[group_idx].centroid_lat,
                                airport_groups[group_idx].centroid_lon,
                                group.centroid_lat,
                                group.centroid_lon,
                            ),
                        )
                    })
                    .filter(|(_, dist_m)| *dist_m <= 2_500.0)
                    .min_by(|a, b| {
                        a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
                    })
                {
                    group_idx = resolved_idx;
                }
            }
            let group = &airport_groups[group_idx];
            let name = if !group.name.trim().is_empty() {
                group.name.clone()
            } else if !group.airport_key.trim().is_empty() {
                group.airport_key.clone()
            } else {
                format!("Airport {}", group_idx + 1)
            };
            let key = if !group.airport_key.trim().is_empty() {
                format!("airport:{}", group.airport_key)
            } else {
                format!("airport_idx:{group_idx}")
            };
            (name, key)
        } else {
            let cell_lat = (mid_lat / 0.02).round() as i32;
            let cell_lon = (mid_lon / 0.03).round() as i32;
            (
                format!("Inferred airfield ({:.2}, {:.2})", mid_lat, mid_lon),
                format!("inferred:{cell_lat}:{cell_lon}"),
            )
        };

        let airport_acc = ground_by_airport
            .entry(group_key.clone())
            .or_insert_with(|| GroundAirportAccum::new(group_name.clone(), group_key, receiver));

        if airport_acc.line_coords.len() < 200 {
            airport_acc.line_coords.push([
                [bucket.start_lon, bucket.start_lat],
                [bucket.end_lon, bucket.end_lat],
            ]);
        }

        // Bucket emission energy (linear) summed across all bands × periods.
        let source_energy: f64 = bucket
            .em_day
            .iter()
            .chain(bucket.em_eve.iter())
            .chain(bucket.em_night.iter())
            .copied()
            .sum();
        airport_acc.emission_energy += source_energy;

        // Modeled (synthetic) vs observed (real ADS-B) attribution. Both
        // counters were summed at bucket-build time; just propagate them
        // to the per-airport and global accumulators.
        ground_modeled_total += bucket.modeled_weight;
        for k in 0..3 {
            ground_modeled_by_kind[k] += bucket.modeled_by_kind[k];
        }
        airport_acc.modeled_total += bucket.modeled_weight;
        for k in 0..3 {
            airport_acc.modeled_by_kind[k] += bucket.modeled_by_kind[k];
        }
        for &fid in &bucket.observed_flight_ids {
            ground_observed_any.insert(fid);
            airport_acc.observed_any.insert(fid);
        }
        for k in 0..3 {
            for &fid in &bucket.observed_by_kind[k] {
                ground_observed_by_kind[k].insert(fid);
                airport_acc.observed_by_kind[k].insert(fid);
            }
        }

        // Convert linear bucket emission back to dB for the propagation
        // chain (it expects dB SPL per band).
        let emission_day_db = aircraft::ground_ops_bucket_emission_db(&bucket.em_day);
        let emission_eve_db = aircraft::ground_ops_bucket_emission_db(&bucket.em_eve);
        let emission_night_db = aircraft::ground_ops_bucket_emission_db(&bucket.em_night);

        let cp = geo::closest_point_on_segment(
            receiver.lat,
            receiver.lon,
            bucket.start_lat,
            bucket.start_lon,
            bucket.end_lat,
            bucket.end_lon,
        );
        let dist_m = cp.dist_m;
        let max_em = emission_day_db
            .iter()
            .chain(emission_eve_db.iter())
            .chain(emission_night_db.iter())
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        if geo::below_free_field_threshold_line(max_em, dist_m, 0.0) {
            continue;
        }

        let cp_elev = rasters.elevation(cp.lat, cp.lon) + bucket.source_height_m;
        let d_slant = geo::slant_dist(dist_m, cp_elev, receiver.altitude_m()).max(1.0);
        let flc = geo::finite_line_correction(bucket.length_m as f64, dist_m, cp.fraction);

        let mut path_profile = propagation::PathProfile::new();
        rasters.build_path_profile(
            cp.lat,
            cp.lon,
            receiver.lat,
            receiver.lon,
            dist_m,
            &mut path_profile,
        );
        let ground_g = propagation::path_effects::ground_g_from_profile(&path_profile);
        let (terrain, _) = propagation::path_effects::terrain_attenuation_with_meta(
            &mut path_profile,
            cp_elev,
            receiver.altitude_m(),
        );
        let (screening_atten, obstacle_trace) =
            propagation::path_effects::screening_attenuation_with_meta(
                &mut path_profile,
                barriers,
                cp_elev,
                receiver.altitude_m(),
                0.0,
                &terrain.attenuation_bands,
            );
        let veg_atten = propagation::path_effects::vegetation_attenuation_path(&path_profile);

        let emissions = [emission_day_db, emission_eve_db, emission_night_db];
        let mut seg_variants = [
            PropagationVariants::default(),
            PropagationVariants::default(),
            PropagationVariants::default(),
        ];
        for (pi, emission) in emissions.iter().enumerate() {
            let v = iso9613::propagate_variants_full(
                emission,
                d_slant,
                SourceGeometry::Line,
                ground_g,
                &terrain.attenuation_bands,
                &screening_atten,
                &veg_atten,
                reflection,
                flc,
            );
            seg_variants[pi].add(&v);
            ground_variants[pi].add(&v);
            ground_kind_variants[kind_idx][pi].add(&v);
            airport_acc.variants[pi].add(&v);
            airport_acc.kind_variants[kind_idx][pi].add(&v);
        }

        if let Some(t) = traces.as_deref_mut() {
            t.segments.push(build_aircraft_ground_segment_trace(BuildAircraftGroundTrace {
                seg: &bucket.representative_seg,
                cp_lat: cp.lat,
                cp_lon: cp.lon,
                src_alt: cp_elev,
                rcv_alt: receiver.altitude_m(),
                d_slant,
                flc,
                ground_g,
                reflection_boost_db: reflection,
                kind_idx,
                path_profile: std::mem::take(&mut path_profile),
                terrain,
                screening_atten,
                obstacle_trace,
                veg_atten,
                seg_variants,
                lw_bands: emissions,
            }));
        }

        if dist_m < ground_min_dist {
            ground_min_dist = dist_m;
            ground_min_d_slant = d_slant;
            ground_min_ground_g = ground_g;
            ground_cp_lat = cp.lat;
            ground_cp_lon = cp.lon;
            ground_src_height = cp_elev;
        }
        if dist_m < airport_acc.min_dist {
            airport_acc.min_dist = dist_m;
            airport_acc.min_d_slant = d_slant;
            airport_acc.min_ground_g = ground_g;
            airport_acc.cp_lat = cp.lat;
            airport_acc.cp_lon = cp.lon;
            airport_acc.src_height = cp_elev;
        }
    }

    let ground_periods = periods_from_variants(&ground_variants);
    if flights.is_empty() && !ground_periods.lden_db.is_finite() {
        return (NoisePeriods::silence(), Vec::new(), AircraftBandData::default());
    }

    // date_id (days since 2020-01-01) → "YYYY-MM-DD". Defined here (before the
    // single flights-iteration loop below) so AirborneTrace push can use it.
    let date_from_id = |date_id: i16| -> String {
        let mut rem = date_id as i32;
        let mut y = 2020i32;
        loop {
            let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
            let yd = if leap { 366 } else { 365 };
            if rem < yd {
                break;
            }
            rem -= yd;
            y += 1;
        }
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let mdays: [i32; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut m = 0usize;
        while m < 12 && rem >= mdays[m] {
            rem -= mdays[m];
            m += 1;
        }
        format!("{:04}-{:02}-{:02}", y, m + 1, rem + 1)
    };

    let mut airborne_energy = [0.0f64; 3];
    let mut band_faint = BandStats::new();
    let mut band_audible = BandStats::new();
    let mut band_disruptive = BandStats::new();
    let mut helicopter_count = 0.0f64;
    let mut global_peak_lmax = f64::NEG_INFINITY;
    for (&flight_id, acc) in flights.iter() {
        for p in 0..3 {
            airborne_energy[p] += acc.period_energy[p];
        }
        let flight_energy: f64 = acc.period_energy.iter().sum();
        if flight_energy <= 0.0 {
            continue;
        }
        if acc.peak_lmax > global_peak_lmax {
            global_peak_lmax = acc.peak_lmax;
        }
        // Helicopter class index is dynamic — look it up via the generated
        // CLASS_NAMES table. The pre-Tier-2 hard-coded `profile_idx == 6`
        // referred to the LightGA+Rotorcraft bucket; in Tier 2 helicopters
        // are their own class (HELICOPTER) at the end of NOISE_CLASSES.
        const HELICOPTER_CLASS_NAME: &str = "HELICOPTER";
        let cls = aircraft::noise_class_of(acc.profile_idx) as usize;
        if aircraft::CLASS_NAMES[cls] == HELICOPTER_CLASS_NAME {
            helicopter_count += acc.flight_weight / n_days_f;
        }
        let avg_alt = acc.min_dist_m;
        let cls = aircraft::noise_class_of(acc.profile_idx) as usize;
        let weight = acc.flight_weight.round().max(1.0) as u32;
        if acc.peak_lmax > 30.0 {
            band_faint.count += acc.flight_weight;
            band_faint.alt_sum += avg_alt * acc.flight_weight;
            band_faint.class_counts[cls] += weight;
        }
        if acc.peak_lmax > 45.0 {
            band_audible.count += acc.flight_weight;
            band_audible.alt_sum += avg_alt * acc.flight_weight;
            band_audible.class_counts[cls] += weight;
        }
        if acc.peak_lmax > 60.0 {
            band_disruptive.count += acc.flight_weight;
            band_disruptive.alt_sum += avg_alt * acc.flight_weight;
            band_disruptive.class_counts[cls] += weight;
        }

        // Popup tee-off: AirborneTrace per flight. Doc 29 is scalar-SEL only —
        // no per-band spectrum is physically meaningful for airborne aircraft.
        if let Some(t) = traces.as_deref_mut() {
            let ld = aircraft::period_leq(acc.period_energy[0], n_days_f, aircraft::PERIOD_SECONDS[0]);
            let le = aircraft::period_leq(acc.period_energy[1], n_days_f, aircraft::PERIOD_SECONDS[1]);
            let ln = aircraft::period_leq(acc.period_energy[2], n_days_f, aircraft::PERIOD_SECONDS[2]);
            let lden = crate::periods::compute_lden(ld, le, ln);

            // Elevation angle is approximate: peak_altitude_m and min_dist_m may
            // come from different segments of the same flight (peak tracks the
            // loudest Lmax, min_dist tracks the closest CPA). Clamp ratio to 1.0
            // so the asin stays finite; we lose some accuracy when alt > cpa.
            let cpa = acc.min_dist_m.max(1.0);
            let elevation_angle_deg =
                (acc.peak_altitude_m / cpa).clamp(-1.0, 1.0).asin().to_degrees();

            t.airborne.push(AirborneTrace {
                flight_id,
                date: date_from_id(acc.peak_date_id),
                period: acc.peak_period,
                profile: aircraft::PROFILES[aircraft::clamp_profile_idx(acc.profile_idx)].name.to_string(),
                lmax_db: if acc.peak_lmax > -900.0 { round1(acc.peak_lmax) } else { 0.0 },
                sel_db: if acc.peak_sel > -900.0 { round1(acc.peak_sel) } else { 0.0 },
                cpa_distance_m: round1(acc.min_dist_m),
                altitude_m_at_cpa: round1(acc.peak_altitude_m),
                elevation_angle_deg: round1(elevation_angle_deg),
                n_days_normalized: n_days_f,
                geometry: [
                    [acc.peak_seg_start[1], acc.peak_seg_start[0]],
                    [acc.peak_seg_end[1], acc.peak_seg_end[0]],
                ],
                received_lden: lden,
            });
        }
    }

    let airborne_periods = periods_from_doc29_energy(airborne_energy);
    let airborne_normalized: [f64; 3] = std::array::from_fn(|pi| {
        if airborne_energy[pi] > 0.0 {
            airborne_energy[pi] / (n_days_f * aircraft::PERIOD_SECONDS[pi])
        } else {
            0.0
        }
    });
    let total = periods_from_normalized(std::array::from_fn(|pi| {
        airborne_normalized[pi] + ground_variants[pi].full_energy
    }));
    let (ground_terrain_meta, ground_screening_meta, ground_vegetation_meta) =
        if ground_min_dist.is_finite() {
            compute_path_effects(
                rasters,
                barriers,
                ground_cp_lat,
                ground_cp_lon,
                ground_src_height,
                receiver,
                ground_min_dist,
                0.0,
            )
        } else {
            (
                TerrainBreakdown::default(),
                ScreeningBreakdown::default(),
                VegetationBreakdown::default(),
            )
        };
    let ground_no_terrain = periods_from_normalized([
        ground_variants[0].no_terrain_energy,
        ground_variants[1].no_terrain_energy,
        ground_variants[2].no_terrain_energy,
    ]);
    let ground_no_screening = periods_from_normalized([
        ground_variants[0].no_screening_energy,
        ground_variants[1].no_screening_energy,
        ground_variants[2].no_screening_energy,
    ]);
    let ground_no_vegetation = periods_from_normalized([
        ground_variants[0].no_vegetation_energy,
        ground_variants[1].no_vegetation_energy,
        ground_variants[2].no_vegetation_energy,
    ]);
    let ground_no_ground = periods_from_normalized([
        ground_variants[0].no_ground_energy,
        ground_variants[1].no_ground_energy,
        ground_variants[2].no_ground_energy,
    ]);
    let ground_no_atmospheric = periods_from_normalized([
        ground_variants[0].no_atmospheric_energy,
        ground_variants[1].no_atmospheric_energy,
        ground_variants[2].no_atmospheric_energy,
    ]);
    let ground_periods_free = periods_from_normalized([
        ground_variants[0].free_field_energy,
        ground_variants[1].free_field_energy,
        ground_variants[2].free_field_energy,
    ]);
    let ground_emission_energy: f64 = ground_by_airport.values().map(|acc| acc.emission_energy).sum();
    let ground_emission_db = if ground_emission_energy > 0.0 {
        10.0 * ground_emission_energy.log10()
    } else {
        f64::NEG_INFINITY
    };
    let ground_received_bands = std::array::from_fn(|i| {
        if ground_variants[0].band_energy[i] > 0.0 {
            10.0 * ground_variants[0].band_energy[i].log10()
        } else {
            f64::NEG_INFINITY
        }
    });
    let flights_per_day = flights.values().map(|acc| acc.flight_weight).sum::<f64>() / n_days_f;

    // Top flights by Lden energy contribution (for popup diagnostics)
    let total_lden_energy: f64 = airborne_energy.iter().sum();
    let top_flights = if total_lden_energy > 0.0 {
        let mut flight_entries: Vec<_> = flights.values().collect();
        flight_entries.sort_by(|a, b| {
            let ea: f64 = a.period_energy.iter().sum();
            let eb: f64 = b.period_energy.iter().sum();
            eb.partial_cmp(&ea).unwrap_or(std::cmp::Ordering::Equal)
        });
        flight_entries.iter().take(5).map(|f| {
            let flight_energy: f64 = f.period_energy.iter().sum();
            types::AircraftTopFlight {
                lmax_db: if f.peak_lmax > -900.0 { (f.peak_lmax * 10.0).round() / 10.0 } else { 0.0 },
                cpa_distance_m: (f.min_dist_m * 10.0).round() / 10.0,
                altitude_m: (f.peak_altitude_m * 10.0).round() / 10.0,
                period: f.peak_period,
                date: date_from_id(f.peak_date_id),
                profile: aircraft::PROFILES[aircraft::clamp_profile_idx(f.profile_idx)].name.to_string(),
                energy_pct: (flight_energy / total_lden_energy * 1000.0).round() / 10.0,
                geometry: [f.peak_seg_start, f.peak_seg_end],
            }
        }).collect()
    } else {
        Vec::new()
    };

    let band_data = AircraftBandData {
        airborne: AircraftAirborneDetail {
            periods: airborne_periods.clone(),
            observed_flights_per_day: flights_per_day,
            helicopter_flights_per_day: helicopter_count,
            lmax_peak: if global_peak_lmax > -900.0 {
                Some(global_peak_lmax)
            } else {
                None
            },
            faint: AircraftEventBandStats {
                observed_events_per_day: band_faint.count / n_days_f,
                avg_altitude_m: if band_faint.count > 0.0 {
                    band_faint.alt_sum / band_faint.count
                } else {
                    0.0
                },
                top_aircraft: band_faint.top_type().to_string(),
            },
            audible: AircraftEventBandStats {
                observed_events_per_day: band_audible.count / n_days_f,
                avg_altitude_m: if band_audible.count > 0.0 {
                    band_audible.alt_sum / band_audible.count
                } else {
                    0.0
                },
                top_aircraft: band_audible.top_type().to_string(),
            },
            disruptive: AircraftEventBandStats {
                observed_events_per_day: band_disruptive.count / n_days_f,
                avg_altitude_m: if band_disruptive.count > 0.0 {
                    band_disruptive.alt_sum / band_disruptive.count
                } else {
                    0.0
                },
                top_aircraft: band_disruptive.top_type().to_string(),
            },
            top_flights,
        },
        ground_ops: AircraftGroundOpsDetail {
            periods: ground_periods.clone(),
            periods_free: ground_periods_free,
            observed_movements_per_day: ground_observed_any.len() as f64 / n_days_f,
            modeled_movements_per_day: ground_modeled_total / n_days_f,
            distance_m: if ground_min_dist.is_finite() { ground_min_dist } else { 0.0 },
            emission_db: ground_emission_db,
            received_bands: ground_received_bands,
            runway_roll: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&ground_kind_variants[0]),
                observed_movements_per_day: ground_observed_by_kind[0].len() as f64 / n_days_f,
                modeled_movements_per_day: ground_modeled_by_kind[0] / n_days_f,
            },
            taxi: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&ground_kind_variants[1]),
                observed_movements_per_day: ground_observed_by_kind[1].len() as f64 / n_days_f,
                modeled_movements_per_day: ground_modeled_by_kind[1] / n_days_f,
            },
            apron_movement: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&ground_kind_variants[2]),
                observed_movements_per_day: ground_observed_by_kind[2].len() as f64 / n_days_f,
                modeled_movements_per_day: ground_modeled_by_kind[2] / n_days_f,
            },
            baseline: if ground_min_dist.is_finite() {
                iso9613::compute_baseline(
                    ground_min_d_slant,
                    SourceGeometry::Line,
                    ground_min_ground_g,
                )
            } else {
                PropagationBaseline::default()
            },
            terrain: ground_terrain_meta,
            screening: ground_screening_meta,
            vegetation: ground_vegetation_meta,
            terrain_impact_db: aircraft_impact(&ground_periods, &ground_no_terrain, false),
            screening_impact_db: aircraft_impact(&ground_periods, &ground_no_screening, false),
            vegetation_impact_db: aircraft_impact(&ground_periods, &ground_no_vegetation, false),
            atmospheric_impact_db: aircraft_impact(&ground_periods, &ground_no_atmospheric, false),
            ground_impact_db: aircraft_impact(&ground_periods, &ground_no_ground, true),
        },
    };

    let mut contributors = Vec::new();

    if airborne_periods.lden_db.is_finite() {
        // Doc 29 airborne has no ISO 9613-2 path effects — all impact
        // scalars are zero (scalar SEL propagation only).
        contributors.push(Contributor {
            osm_id: None,
            geometry: None,
            baseline: PropagationBaseline::default(),
            terrain: TerrainBreakdown::default(),
            screening: ScreeningBreakdown::default(),
            vegetation: VegetationBreakdown::default(),
            terrain_impact_db: 0.0,
            screening_impact_db: 0.0,
            vegetation_impact_db: 0.0,
            atmospheric_impact_db: 0.0,
            ground_impact_db: 0.0,
            source_type: LayerKind::Aircraft,
            name: "Aircraft - airborne".to_string(),
            subtype: "airborne".to_string(),
            distance_m: 0.0,
            periods: airborne_periods.clone(),
            periods_free: airborne_periods.clone(),
            emission_db: airborne_periods.lden_db,
            received_bands: [0.0; NUM_BANDS],
            metadata: Some(SourceMetadata::Aircraft(AircraftMetadata {
                variant: "airborne".to_string(),
                airport_name: None,
                airport_key: None,
                airborne: Some(band_data.airborne.clone()),
                ground_ops: None,
            })),
        });
    }

    let mut airport_keys: Vec<_> = ground_by_airport.keys().cloned().collect();
    airport_keys.sort();
    for airport_key in airport_keys {
        let Some(acc) = ground_by_airport.get(&airport_key) else {
            continue;
        };
        let airport_periods = periods_from_variants(&acc.variants);
        if !airport_periods.lden_db.is_finite() {
            continue;
        }

        let airport_periods_free = periods_from_normalized([
            acc.variants[0].free_field_energy,
            acc.variants[1].free_field_energy,
            acc.variants[2].free_field_energy,
        ]);
        let airport_no_terrain = periods_from_normalized([
            acc.variants[0].no_terrain_energy,
            acc.variants[1].no_terrain_energy,
            acc.variants[2].no_terrain_energy,
        ]);
        let airport_no_screening = periods_from_normalized([
            acc.variants[0].no_screening_energy,
            acc.variants[1].no_screening_energy,
            acc.variants[2].no_screening_energy,
        ]);
        let airport_no_vegetation = periods_from_normalized([
            acc.variants[0].no_vegetation_energy,
            acc.variants[1].no_vegetation_energy,
            acc.variants[2].no_vegetation_energy,
        ]);
        let airport_no_ground = periods_from_normalized([
            acc.variants[0].no_ground_energy,
            acc.variants[1].no_ground_energy,
            acc.variants[2].no_ground_energy,
        ]);
        let airport_no_atmospheric = periods_from_normalized([
            acc.variants[0].no_atmospheric_energy,
            acc.variants[1].no_atmospheric_energy,
            acc.variants[2].no_atmospheric_energy,
        ]);
        let airport_terrain_impact = aircraft_impact(&airport_periods, &airport_no_terrain, false);
        let airport_screening_impact =
            aircraft_impact(&airport_periods, &airport_no_screening, false);
        let airport_vegetation_impact =
            aircraft_impact(&airport_periods, &airport_no_vegetation, false);
        let airport_atmospheric_impact =
            aircraft_impact(&airport_periods, &airport_no_atmospheric, false);
        let airport_ground_impact = aircraft_impact(&airport_periods, &airport_no_ground, true);
        let (terrain_meta, screening_meta, vegetation_meta) = compute_path_effects(
            rasters,
            barriers,
            acc.cp_lat,
            acc.cp_lon,
            acc.src_height,
            receiver,
            acc.min_dist,
            0.0,
        );
        let baseline = iso9613::compute_baseline(
            acc.min_d_slant,
            SourceGeometry::Line,
            acc.min_ground_g,
        );
        let received_bands = std::array::from_fn(|i| {
            if acc.variants[0].band_energy[i] > 0.0 {
                10.0 * acc.variants[0].band_energy[i].log10()
            } else {
                f64::NEG_INFINITY
            }
        });
        let emission_db = if acc.emission_energy > 0.0 {
            10.0 * acc.emission_energy.log10()
        } else {
            f64::NEG_INFINITY
        };
        let display_name = if !acc.name.trim().is_empty() {
            acc.name.clone()
        } else {
            "Inferred airfield".to_string()
        };
        let detail = AircraftGroundOpsDetail {
            periods: airport_periods.clone(),
            periods_free: airport_periods_free.clone(),
            observed_movements_per_day: acc.observed_any.len() as f64 / n_days_f,
            modeled_movements_per_day: acc.modeled_total / n_days_f,
            distance_m: acc.min_dist,
            emission_db,
            received_bands,
            runway_roll: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&acc.kind_variants[0]),
                observed_movements_per_day: acc.observed_by_kind[0].len() as f64 / n_days_f,
                modeled_movements_per_day: acc.modeled_by_kind[0] / n_days_f,
            },
            taxi: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&acc.kind_variants[1]),
                observed_movements_per_day: acc.observed_by_kind[1].len() as f64 / n_days_f,
                modeled_movements_per_day: acc.modeled_by_kind[1] / n_days_f,
            },
            apron_movement: AircraftGroundOpsClassDetail {
                periods: periods_from_variants(&acc.kind_variants[2]),
                observed_movements_per_day: acc.observed_by_kind[2].len() as f64 / n_days_f,
                modeled_movements_per_day: acc.modeled_by_kind[2] / n_days_f,
            },
            baseline: baseline.clone(),
            terrain: terrain_meta,
            screening: screening_meta,
            vegetation: vegetation_meta,
            terrain_impact_db: airport_terrain_impact,
            screening_impact_db: airport_screening_impact,
            vegetation_impact_db: airport_vegetation_impact,
            atmospheric_impact_db: airport_atmospheric_impact,
            ground_impact_db: airport_ground_impact,
        };
        let ground_geometry = if !acc.line_coords.is_empty() {
            Some(serde_json::json!({"type": "MultiLineString", "coordinates": acc.line_coords}))
        } else {
            None
        };
        contributors.push(Contributor {
            osm_id: None,
            geometry: ground_geometry,
            baseline: detail.baseline.clone(),
            terrain: detail.terrain.clone(),
            screening: detail.screening.clone(),
            vegetation: detail.vegetation.clone(),
            terrain_impact_db: detail.terrain_impact_db,
            screening_impact_db: detail.screening_impact_db,
            vegetation_impact_db: detail.vegetation_impact_db,
            atmospheric_impact_db: detail.atmospheric_impact_db,
            ground_impact_db: detail.ground_impact_db,
            source_type: LayerKind::Aircraft,
            name: format!("Aircraft - ground ops — {}", display_name),
            subtype: "ground_ops".to_string(),
            distance_m: detail.distance_m,
            periods: airport_periods,
            periods_free: airport_periods_free,
            emission_db,
            received_bands: detail.received_bands,
            metadata: Some(SourceMetadata::Aircraft(AircraftMetadata {
                variant: "ground_ops".to_string(),
                airport_name: Some(display_name),
                airport_key: Some(acc.airport_key.clone()),
                airborne: None,
                ground_ops: Some(detail),
            })),
        });
    }

    (total, contributors, band_data)
}

pub(crate) fn surface_name(surface_type: u8) -> &'static str {
    match surface_type {
        0 => "asphalt",
        1 => "paving",
        2 => "concrete",
        3 => "unpaved",
        4 => "gravel",
        _ => "asphalt",
    }
}

pub(crate) fn rail_type_name(rt: u8) -> &'static str {
    match rt {
        0 => "rail",
        1 => "tram",
        2 => "light_rail",
        3 => "narrow_gauge",
        4 => "funicular",
        _ => "rail",
    }
}

fn rail_usage_name(u: u8) -> &'static str {
    match u {
        0 => "main",
        1 => "branch",
        2 => "industrial",
        _ => "main",
    }
}

pub(crate) fn building_type_name(bt: u8) -> &'static str {
    match bt {
        0 => "residential_multi",
        1 => "commercial",
        2 => "warehouse",
        3 => "education",
        4 => "healthcare",
        5 => "worship",
        6 => "hospitality",
        7 => "garage",
        8 => "farm",
        9 => "public",
        _ => "default",
    }
}

pub(crate) fn industrial_type_name(st: u8) -> &'static str {
    match st {
        0 => "industrial_area",
        1 => "quarry",
        2 => "farm",
        3 => "factory",
        4 => "wastewater",
        10 => "wind_turbine",
        _ => "industrial_area",
    }
}

/// Compute terrain/screening/vegetation path effects for one source-receiver pair.
/// Returns (TerrainBreakdown, ScreeningBreakdown, VegetationBreakdown).
pub fn compute_path_effects(
    rasters: &dyn RasterSampler,
    barriers: &[Barrier],
    src_lat: f64,
    src_lon: f64,
    src_height: f64,
    receiver: &Receiver,
    dist_m: f64,
    exclusion_radius_m: f64,
) -> (TerrainBreakdown, ScreeningBreakdown, VegetationBreakdown) {
    let rcv_alt = receiver.altitude_m();

    // Unified path profile — one sampling, all four rasters + all metadata.
    let mut path_profile = propagation::PathProfile::new();
    rasters.build_path_profile(
        src_lat,
        src_lon,
        receiver.lat,
        receiver.lon,
        dist_m,
        &mut path_profile,
    );

    // Metadata only — the per-band attenuation arrays are consumed inside
    // `propagate_variants_full`; popup derives A-weighted `ΔL_A` from the
    // Contributor-level variant Lden deltas instead of any scalar here.
    let (terrain, terrain_profile_points) =
        propagation::path_effects::terrain_attenuation_with_meta(&mut path_profile, src_height, rcv_alt);

    let (_screening_atten, obstacle_trace) = propagation::path_effects::screening_attenuation_with_meta(
        &mut path_profile,
        barriers,
        src_height,
        rcv_alt,
        exclusion_radius_m,
        &terrain.attenuation_bands,
    );

    let forest_depth = propagation::path_profile::vegetation_run_length(
        &path_profile.t,
        &path_profile.forest_u8,
        path_profile.dist_m,
    );
    let sampled_path_m = dist_m;

    (
        TerrainBreakdown {
            delta_m: (terrain.delta_m * 100.0).round() / 100.0,
            is_double: terrain.is_double,
            profile_points: terrain_profile_points,
        },
        ScreeningBreakdown {
            building_path_m: (obstacle_trace.height_m * 10.0).round() / 10.0,
            obstacle: if obstacle_trace.kind == "none" {
                None
            } else {
                Some(obstacle_trace)
            },
        },
        VegetationBreakdown {
            forest_depth_m: (forest_depth * 10.0).round() / 10.0,
            sampled_path_m: (sampled_path_m * 10.0).round() / 10.0,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::AIRCRAFT_ADSB_SOURCE_ID;

    /// Mock raster sampler for testing.
    struct MockRasters;
    impl RasterSampler for MockRasters {
        fn elevation(&self, _lat: f64, _lon: f64) -> f64 {
            200.0
        }
        fn building_height(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _: f64, _: f64) -> f64 {
            0.5
        }
        fn building_enclosure(&self, _: f64, _: f64) -> f64 {
            0.0
        }
    }

    #[test]
    fn test_road_end_to_end() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1,
            segment_idx: 0,
            start_lat: 50.081,
            start_lon: 14.42,
            end_lat: 50.079,
            end_lon: 14.42,
            length_m: 220.0,
            road_class: 0, // motorway
            speed_limit: 100,
            surface_type: 0,
            oneway: false,
            lanes: 2,
            aadt_light: 0,
            aadt_medium: 0,
            aadt_heavy: 0,
            aadt_moto: 0, // defaults
            source_id: 0,
            dist_m: 500.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            name: String::new(),
            road_ref: String::new(),
            bridge: false,
            tunnel: false,
            access: 0,
            junction: 0,
        }];

        let result = compute_at_point(
            &receiver,
            &roads,
            &[],
            &[],
            &[],
            &[],
            &[],
            &MockRasters,
            &ComputeConfig::default(),
        );

        // Motorway at 500m with 30K AADT should produce ~55-65 dB Lden
        assert!(
            result.total.lden_db > 45.0 && result.total.lden_db < 75.0,
            "Motorway 500m: expected 45-75 dB, got {:.1}",
            result.total.lden_db
        );

        // Should have period decomposition
        assert!(
            result.total.ld_db > result.total.ln_db,
            "Day should be louder than night (Ld={:.1}, Ln={:.1})",
            result.total.ld_db,
            result.total.ln_db
        );

        // Should have at least one source result
        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].source_type, LayerKind::Road);

        println!(
            "Motorway 500m: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1}",
            result.total.ld_db, result.total.le_db, result.total.ln_db, result.total.lden_db
        );
    }

    #[test]
    fn test_multi_source() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1,
            segment_idx: 0,
            start_lat: 50.081,
            start_lon: 14.42,
            end_lat: 50.079,
            end_lon: 14.42,
            length_m: 220.0,
            road_class: 2,
            speed_limit: 50,
            surface_type: 0,
            oneway: false,
            lanes: 2,
            aadt_light: 0,
            aadt_medium: 0,
            aadt_heavy: 0,
            aadt_moto: 0,
            source_id: 0,
            dist_m: 100.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            name: String::new(),
            road_ref: String::new(),
            bridge: false,
            tunnel: false,
            access: 0,
            junction: 0,
        }];
        let railways = vec![RailSegment {
            osm_id: 2,
            segment_idx: 0,
            start_lat: 50.082,
            start_lon: 14.42,
            end_lat: 50.078,
            end_lon: 14.42,
            length_m: 440.0,
            rail_type: 0,
            usage: 0,
            maxspeed: 100,
            trains_passenger: 80.0,
            trains_freight: 20.0,
            speed_kmh: 100,
            track_count: 2,
            name: String::new(),
            rail_ref: String::new(),
            dist_m: 200.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            bridge: false,
            tunnel: false,
            service: false,
            highspeed: false,
            parallel_divisor: 1,
            speed_source: 0,
            trains_passenger_source: 0,
            trains_freight_source: 0,
            source_id: 0,
        }];

        let result = compute_at_point(
            &receiver,
            &roads,
            &railways,
            &[],
            &[],
            &[],
            &[],
            &MockRasters,
            &ComputeConfig::default(),
        );

        // Should have both road and railway sources
        assert_eq!(result.sources.len(), 2);
        assert!(
            result.total.lden_db > 40.0,
            "multi-source Lden={:.1}",
            result.total.lden_db
        );

        // Total should be louder than either source alone
        let road_only = compute_at_point(
            &receiver,
            &roads,
            &[],
            &[],
            &[],
            &[],
            &[],
            &MockRasters,
            &ComputeConfig::default(),
        );
        let rail_only = compute_at_point(
            &receiver,
            &[],
            &railways,
            &[],
            &[],
            &[],
            &[],
            &MockRasters,
            &ComputeConfig::default(),
        );

        assert!(
            result.total.lden_db > road_only.total.lden_db,
            "combined should be louder than road alone"
        );
        assert!(
            result.total.lden_db > rail_only.total.lden_db,
            "combined should be louder than rail alone"
        );

        println!(
            "Multi: road={:.1} rail={:.1} combined={:.1} dB Lden",
            road_only.total.lden_db, rail_only.total.lden_db, result.total.lden_db
        );
    }

    #[test]
    fn test_residential_nearby() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 2,
            segment_idx: 0,
            start_lat: 50.0801,
            start_lon: 14.42,
            end_lat: 50.0799,
            end_lon: 14.42,
            length_m: 22.0,
            road_class: 5, // residential
            speed_limit: 30,
            surface_type: 0,
            oneway: false,
            lanes: 1,
            aadt_light: 0,
            aadt_medium: 0,
            aadt_heavy: 0,
            aadt_moto: 0,
            source_id: 0,
            dist_m: 15.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            name: String::new(),
            road_ref: String::new(),
            bridge: false,
            tunnel: false,
            access: 0,
            junction: 0,
        }];

        let result = compute_at_point(
            &receiver,
            &roads,
            &[],
            &[],
            &[],
            &[],
            &[],
            &MockRasters,
            &ComputeConfig::default(),
        );

        // Residential at 15m with 500 AADT: ~40-55 dB
        assert!(
            result.total.lden_db > 30.0 && result.total.lden_db < 65.0,
            "Residential 15m: expected 30-65 dB, got {:.1}",
            result.total.lden_db
        );

        println!(
            "Residential 15m: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1}",
            result.total.ld_db, result.total.le_db, result.total.ln_db, result.total.lden_db
        );
    }

    #[test]
    fn test_aircraft_end_to_end() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        // Simulate 5 flights per day × 365 days = 1825 flights, each with 3 segments
        let mut aircraft = Vec::new();
        for flight in 0..1825u64 {
            let period = if flight % 100 < 65 {
                0u8
            } else if flight % 100 < 85 {
                1
            } else {
                2
            };
            let date_id = (flight / 5) as i16;
            // Approach segments at ~300m altitude, 1km away
            for s in 0..3 {
                aircraft.push(AircraftSegment {
                    flight_id: flight,
                    profile_idx: 0, // B738
                    is_departure: false,
                    on_ground: false,
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
                    ground_context: emission::aircraft::GROUND_CONTEXT_NONE,
                    ground_ops_kind: emission::aircraft::GROUND_OPS_KIND_NONE,
                    count_weight: 1.0,
                    surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                });
            }
        }

        let config = ComputeConfig {
            n_days: 365,
            ..Default::default()
        };
        let result = compute_at_point(
            &receiver,
            &[],
            &[],
            &[],
            &[],
            &aircraft,
            &[],
            &MockRasters,
            &config,
        );

        // 5 flights/day of B738 at ~700m lateral → real ANP CF567B
        // approach SEL is ~10 dB quieter than the placeholder it replaced,
        // so the floor drops accordingly. Loosen lower bound vs Tier 1.
        assert!(
            result.total.lden_db > 25.0 && result.total.lden_db < 75.0,
            "Aircraft Lden: expected 25-75, got {:.1}",
            result.total.lden_db
        );

        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].source_type, LayerKind::Aircraft);

        // Day should be louder than night (more flights)
        assert!(
            result.total.ld_db > result.total.ln_db || result.total.ln_db == f64::NEG_INFINITY,
            "Day should be louder: Ld={:.1} Ln={:.1}",
            result.total.ld_db,
            result.total.ln_db
        );

        println!(
            "Aircraft 5/day: Ld={:.1} Le={:.1} Ln={:.1} Lden={:.1} ({} contributors)",
            result.total.ld_db,
            result.total.le_db,
            result.total.ln_db,
            result.total.lden_db,
            result.contributors.len()
        );
    }

    #[test]
    fn test_all_sources_combined() {
        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let roads = vec![RoadSegment {
            osm_id: 1,
            segment_idx: 0,
            start_lat: 50.081,
            start_lon: 14.42,
            end_lat: 50.079,
            end_lon: 14.42,
            length_m: 220.0,
            road_class: 2,
            speed_limit: 50,
            surface_type: 0,
            oneway: false,
            lanes: 2,
            aadt_light: 0,
            aadt_medium: 0,
            aadt_heavy: 0,
            aadt_moto: 0,
            source_id: 0,
            dist_m: 100.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            name: String::new(),
            road_ref: String::new(),
            bridge: false,
            tunnel: false,
            access: 0,
            junction: 0,
        }];
        let railways = vec![RailSegment {
            osm_id: 2,
            segment_idx: 0,
            start_lat: 50.082,
            start_lon: 14.42,
            end_lat: 50.078,
            end_lon: 14.42,
            length_m: 440.0,
            rail_type: 0,
            usage: 0,
            maxspeed: 100,
            trains_passenger: 80.0,
            trains_freight: 20.0,
            speed_kmh: 100,
            track_count: 2,
            name: String::new(),
            rail_ref: String::new(),
            dist_m: 200.0,
            cp_lat: 50.08,
            cp_lon: 14.42,
            fraction: 0.5,
            bridge: false,
            tunnel: false,
            service: false,
            highspeed: false,
            parallel_divisor: 1,
            speed_source: 0,
            trains_passenger_source: 0,
            trains_freight_source: 0,
            source_id: 0,
        }];
        let aircraft = vec![AircraftSegment {
            flight_id: 1,
            profile_idx: 0,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.08,
            start_lon: 14.43,
            start_alt_m: 500.0,
            end_lat: 50.09,
            end_lon: 14.43,
            end_alt_m: 400.0,
            speed_kt: 150.0,
            segment_length_m: 1100.0,
            ground_context: emission::aircraft::GROUND_CONTEXT_NONE,
            ground_ops_kind: emission::aircraft::GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
        }];

        let config = ComputeConfig {
            n_days: 365,
            ..Default::default()
        };
        let result = compute_at_point(
            &receiver,
            &roads,
            &railways,
            &[],
            &[],
            &aircraft,
            &[],
            &MockRasters,
            &config,
        );

        // Should have road + railway + aircraft
        assert!(
            result.sources.len() >= 2,
            "sources = {:?}",
            result
                .sources
                .iter()
                .map(|s| &s.source_type)
                .collect::<Vec<_>>()
        );
        assert!(
            result.total.lden_db > 40.0,
            "combined Lden = {:.1}",
            result.total.lden_db
        );

        for s in &result.sources {
            println!("  {}: Lden={:.1}", s.source_type, s.periods.lden_db);
        }
        println!("  TOTAL: Lden={:.1}", result.total.lden_db);
    }
}

#[cfg(test)]
mod sources_tests {
    use crate::sources::{get_source, provenance_of, Provenance, Source, SOURCES};

    #[test]
    fn unspecified_is_id_zero_sentinel() {
        let s = &SOURCES[0];
        assert_eq!(s.id, 0);
        assert_eq!(s.key, "unspecified");
        assert_eq!(s.provenance, Provenance::None);
        assert_eq!(Source::UNSPECIFIED.id, 0);
    }

    #[test]
    fn no_duplicate_ids() {
        let mut seen = std::collections::HashSet::new();
        for s in SOURCES {
            assert!(seen.insert(s.id), "duplicate id={} (key={})", s.id, s.key);
        }
    }

    #[test]
    fn no_duplicate_keys() {
        let mut seen = std::collections::HashSet::new();
        for s in SOURCES {
            assert!(seen.insert(s.key), "duplicate key={} (id={})", s.key, s.id);
        }
    }

    #[test]
    fn provenance_rank_monotonic() {
        assert!(Provenance::NationalMeasured.rank() > Provenance::ContinentalMeasured.rank());
        assert!(Provenance::ContinentalMeasured.rank() > Provenance::GlobalMeasured.rank());
        assert!(Provenance::GlobalMeasured.rank() > Provenance::Heuristic.rank());
        assert!(Provenance::Heuristic.rank() > Provenance::Baseline.rank());
        assert!(Provenance::Baseline.rank() > Provenance::None.rank());
    }

    #[test]
    fn get_source_looks_up_by_id() {
        let rsd = get_source(20).expect("cz-rsd (id=20) must exist");
        assert_eq!(rsd.key, "cz-rsd-scitani");
        assert_eq!(rsd.provenance, Provenance::NationalMeasured);
    }

    #[test]
    fn provenance_of_unknown_id_is_none() {
        assert_eq!(provenance_of(0), Provenance::None);
        assert_eq!(provenance_of(u16::MAX), Provenance::None);
    }

    #[test]
    fn sources_sorted_by_id_for_binary_search() {
        // get_source uses binary_search_by_key; the generator emits SOURCES
        // in id-ascending order. Lock the invariant so a hand-edit to
        // sources.rs (or a reordered DATASETS) can't silently break lookup.
        for pair in SOURCES.windows(2) {
            assert!(pair[0].id < pair[1].id, "SOURCES not sorted by id: {} then {}", pair[0].id, pair[1].id);
        }
    }
}
