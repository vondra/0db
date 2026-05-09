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
pub mod compute;
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
    build_point_segment_trace, build_rail_segment_trace, build_road_segment_trace, BuildPointTrace,
    BuildRailTrace, BuildRoadTrace,
};
use types::*;

/// Round to one decimal place (0.1 dB granularity — matches UI precision).
#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
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
    _config: &ComputeConfig,
    mut traces: Option<&mut TraceCollector>,
) -> NoiseResult {
    let mut source_results = Vec::new();
    let mut all_contributors = Vec::new();
    let aircraft_band_data: Option<AircraftBandData> = None;

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
    // Aircraft handling moved to `compute::aircraft_v6::compute_aircraft_v6`,
    // which consumes popup arrows directly via typed views and reads
    // ground em_*_bands under the dB_sum_v6_1 contract. The
    // `aircraft` / `airport_lines` / `airport_areas` parameters are kept
    // on this entry point for compatibility with existing callers and
    // should always be empty — invoke `compute_aircraft_v6` afterwards.
    let _ = (aircraft, airport_lines, airport_areas);

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
        // Aircraft path went via compute_aircraft_v6 in C2/C4 — the
        // legacy compute_aircraft was deleted. Reconstruct the same
        // 5 flights/day × 365 d B738 approach traffic as
        // `AirborneRowView`s and assert Lden via the v6 entry point.
        use crate::compute::aircraft_v6::{compute_aircraft_v6, AirborneRowView, BBox, SubSegmentSlice};

        let receiver = Receiver::new(50.08, 14.42, 200.0);
        let total_flights = 1825u64;
        let subs_per_flight = 3usize;
        let total_subs = total_flights as usize * subs_per_flight;

        let mut start_lat = Vec::with_capacity(total_subs);
        let mut start_lon = Vec::with_capacity(total_subs);
        let mut start_alt_m = Vec::with_capacity(total_subs);
        let mut end_lat = Vec::with_capacity(total_subs);
        let mut end_lon = Vec::with_capacity(total_subs);
        let mut end_alt_m = Vec::with_capacity(total_subs);
        let mut speed_kt = Vec::with_capacity(total_subs);
        let mut length_m = Vec::with_capacity(total_subs);
        let mut period_col = Vec::with_capacity(total_subs);
        let mut date_id_col = Vec::with_capacity(total_subs);
        let mut flags_col = Vec::with_capacity(total_subs);

        // Column buffers above stay alive for the whole compute call —
        // the row views borrow into them via slice indices.
        for flight in 0..total_flights {
            let period = if flight % 100 < 65 {
                0u8
            } else if flight % 100 < 85 {
                1
            } else {
                2
            };
            let date_id = (flight / 5) as i16;
            for s in 0..subs_per_flight {
                start_lat.push(50.08_f32 + 0.003 * s as f32);
                start_lon.push(14.43_f32);
                start_alt_m.push(500.0 - 50.0 * s as f32);
                end_lat.push(50.08_f32 + 0.003 * (s + 1) as f32);
                end_lon.push(14.43_f32);
                end_alt_m.push(500.0 - 50.0 * (s + 1) as f32);
                speed_kt.push(150.0);
                length_m.push(330.0);
                period_col.push(period);
                date_id_col.push(date_id);
                flags_col.push(0);
            }
        }

        // Build per-flight row views by slicing the shared buffers.
        let mut row_views: Vec<AirborneRowView<'_>> = Vec::with_capacity(total_flights as usize);
        for flight in 0..total_flights {
            let lo = flight as usize * subs_per_flight;
            let hi = lo + subs_per_flight;
            row_views.push(AirborneRowView {
                flight_id: flight,
                callsign: "",
                aircraft_type: &[0u8; 4],
                profile_idx: 0,
                source_id: AIRCRAFT_ADSB_SOURCE_ID as u8,
                origin: 0,
                sub_segments: SubSegmentSlice {
                    start_lat: &start_lat[lo..hi],
                    start_lon: &start_lon[lo..hi],
                    start_alt_m: &start_alt_m[lo..hi],
                    end_lat: &end_lat[lo..hi],
                    end_lon: &end_lon[lo..hi],
                    end_alt_m: &end_alt_m[lo..hi],
                    speed_kt: &speed_kt[lo..hi],
                    length_m: &length_m[lo..hi],
                    period: &period_col[lo..hi],
                    date_id: &date_id_col[lo..hi],
                    flags: &flags_col[lo..hi],
                },
                bbox: BBox {
                    min_lat: 50.08,
                    max_lat: 50.10,
                    min_lon: 14.43,
                    max_lon: 14.44,
                },
            });
        }
        let (periods, _contribs, _band) = compute_aircraft_v6(
            &receiver,
            &row_views,
            &[],
            &[],
            &[],
            &MockRasters,
            365,
            None,
        );

        assert!(
            periods.lden_db > 25.0 && periods.lden_db < 75.0,
            "Aircraft Lden: expected 25-75, got {:.1}",
            periods.lden_db
        );
        assert!(
            periods.ld_db > periods.ln_db || periods.ln_db == f64::NEG_INFINITY,
            "Day should be louder: Ld={:.1} Ln={:.1}",
            periods.ld_db,
            periods.ln_db
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
            cruise_flight_ids: Vec::new(),
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
