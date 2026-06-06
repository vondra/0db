//! noise-compute: Pure Rust noise computation engine.
//!
//! CNOSSOS-EU emission + ISO 9613-2 propagation + Doc 29 aircraft.
//! No I/O, no files, no napi. Pure computation.
//!
//! Single-receiver entry points: `compute_at_point` and
//! `compute_at_point_with_traces` (popup).

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

mod source_names;
pub(crate) use source_names::*;

use compute::point_sources::compute_point_sources;
use compute::railways::compute_railways;
use compute::roads::compute_roads;

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
/// Aircraft go through `compute::aircraft_v6::compute_aircraft_v6`,
/// invoked separately by the popup (see
/// `source-reader/src/aircraft_v6/mod.rs::add_v6_aircraft_to_result`).
pub fn compute_at_point(
    receiver: &Receiver,
    roads: &[RoadSegment],
    railways: &[RailSegment],
    buildings: &[PointSource],
    industrial: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    config: &ComputeConfig,
) -> NoiseResult {
    compute_at_point_inner(
        receiver, roads, railways, buildings, industrial, barriers, rasters, config, None,
    )
}

/// Variant that also takes a `TraceCollector` (popup uses this through
/// the source-reader to collect noise-segments traces alongside the
/// aggregate result).
pub fn compute_at_point_with_traces(
    receiver: &Receiver,
    roads: &[RoadSegment],
    railways: &[RailSegment],
    buildings: &[PointSource],
    industrial: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    config: &ComputeConfig,
    traces: Option<&mut TraceCollector>,
) -> NoiseResult {
    compute_at_point_inner(
        receiver, roads, railways, buildings, industrial, barriers, rasters, config, traces,
    )
}

#[allow(clippy::too_many_arguments)]
fn compute_at_point_inner(
    receiver: &Receiver,
    roads: &[RoadSegment],
    railways: &[RailSegment],
    buildings: &[PointSource],
    industrial: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    _config: &ComputeConfig,
    mut traces: Option<&mut TraceCollector>,
) -> NoiseResult {
    let mut source_results = Vec::new();
    let mut all_contributors = Vec::new();
    let mut timings = crate::types::LayerTimings::default();

    // Free-field aggregate is summed from each Contributor's `periods_free`
    // (already computed alongside `periods`). Accepts a small under-count
    // vs the kernel's true source-wide total because Contributors below the
    // display threshold are dropped — comparable error to the existing
    // `other_sources_lden` accounting; never user-facing (wire field is the
    // new `lden_free`, previously always null).
    let contrib_periods_free = |contribs: &[Contributor]| -> NoisePeriods {
        periods::sum_periods(
            &contribs.iter().map(|c| c.periods_free.clone()).collect::<Vec<_>>(),
        )
    };

    if !roads.is_empty() {
        let t = std::time::Instant::now();
        let (road_periods, road_contributors) =
            compute_roads(receiver, roads, barriers, rasters, traces.as_deref_mut());
        timings.road_ms = t.elapsed().as_secs_f64() * 1000.0;
        source_results.push(SourceResult {
            source_type: LayerKind::Road,
            periods: road_periods.clone(),
            periods_free: contrib_periods_free(&road_contributors),
            segment_count: roads.len(),
            displayed_count: present::display_count(&road_contributors),
        });
        all_contributors.extend(road_contributors);
    }

    if !railways.is_empty() {
        let t = std::time::Instant::now();
        let (rail_periods, rail_contributors) =
            compute_railways(receiver, railways, barriers, rasters, traces.as_deref_mut());
        timings.rail_ms = t.elapsed().as_secs_f64() * 1000.0;
        source_results.push(SourceResult {
            source_type: LayerKind::Railway,
            periods: rail_periods,
            periods_free: contrib_periods_free(&rail_contributors),
            segment_count: railways.len(),
            displayed_count: present::display_count(&rail_contributors),
        });
        all_contributors.extend(rail_contributors);
    }

    if !buildings.is_empty() {
        let t = std::time::Instant::now();
        let (bld_periods, bld_contributors) = compute_point_sources(
            receiver,
            buildings,
            barriers,
            rasters,
            LayerKind::Building,
            traces.as_deref_mut(),
        );
        timings.building_ms = t.elapsed().as_secs_f64() * 1000.0;
        source_results.push(SourceResult {
            source_type: LayerKind::Building,
            periods: bld_periods,
            periods_free: contrib_periods_free(&bld_contributors),
            segment_count: buildings.len(),
            displayed_count: present::display_count(&bld_contributors),
        });
        all_contributors.extend(bld_contributors);
    }

    if !industrial.is_empty() {
        let t = std::time::Instant::now();
        let (ind_periods, ind_contributors) = compute_point_sources(
            receiver,
            industrial,
            barriers,
            rasters,
            LayerKind::Industrial,
            traces,
        );
        timings.industrial_ms = t.elapsed().as_secs_f64() * 1000.0;
        source_results.push(SourceResult {
            source_type: LayerKind::Industrial,
            periods: ind_periods,
            periods_free: contrib_periods_free(&ind_contributors),
            segment_count: industrial.len(),
            displayed_count: present::display_count(&ind_contributors),
        });
        all_contributors.extend(ind_contributors);
    }

    // Aircraft are computed by `compute::aircraft_v6::compute_aircraft_v6`
    // and merged into the result downstream via
    // `source-reader::aircraft_v6::add_v6_aircraft_to_result`.

    // ── Total ──
    let total = periods::sum_periods(
        &source_results
            .iter()
            .map(|s| s.periods.clone())
            .collect::<Vec<_>>(),
    );
    let total_free = periods::sum_periods(
        &source_results
            .iter()
            .map(|s| s.periods_free.clone())
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
    // Aircraft visibility is downstream — `add_v6_aircraft_to_result`
    // sees the popup arrows and bumps confidence after merging.
    let has_aircraft = false;
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
        total_free,
        sources: source_results,
        contributors: all_contributors,
        other_sources_lden,
        confidence: conf,
        aircraft_detail: None,
        segments: Vec::new(),
        segments_meta: None,
        timings: Some(timings),
    }
}

/// Road [`NoisePeriods`] at a receiver — the popup road path without trace
/// collection. Each segment's closest-point (`dist_m`/`cp_lat`/`cp_lon`/
/// `fraction`) must already be filled for THIS receiver. Exposed so the
/// surface-heatmap road parity validator can compare against the exact
/// popup reference instead of re-implementing the physics.
pub fn road_periods(
    receiver: &Receiver,
    roads: &[RoadSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> NoisePeriods {
    compute_roads(receiver, roads, barriers, rasters, None).0
}

/// Railway [`NoisePeriods`] at a receiver — the popup rail path without trace
/// collection. Each segment's closest-point (`dist_m`/`cp_lat`/`cp_lon`/
/// `fraction`) and effective (post `service`/`parallel_divisor`) train counts
/// must already be filled for THIS receiver. Exposed so the surface-heatmap
/// rail parity validator compares against the exact popup reference.
pub fn rail_periods(
    receiver: &Receiver,
    railways: &[RailSegment],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> NoisePeriods {
    compute_railways(receiver, railways, barriers, rasters, None).0
}

/// Industrial [`NoisePeriods`] at a receiver — the popup point-source path
/// (`LayerKind::Industrial`) without trace collection. Each `PointSource`'s
/// `dist_m` must already be filled for THIS receiver. Exposed so the
/// surface-heatmap industrial parity validator compares against the exact
/// popup reference.
pub fn industrial_periods(
    receiver: &Receiver,
    sources: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> NoisePeriods {
    compute_point_sources(receiver, sources, barriers, rasters, LayerKind::Industrial, None).0
}

/// Building [`NoisePeriods`] at a receiver — the popup point-source path
/// (`LayerKind::Building`) without trace collection. Each `PointSource`'s
/// `dist_m` must already be filled for THIS receiver. Exposed so the
/// surface-heatmap building parity validator compares against the exact popup
/// reference.
pub fn building_periods(
    receiver: &Receiver,
    sources: &[PointSource],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
) -> NoisePeriods {
    compute_point_sources(receiver, sources, barriers, rasters, LayerKind::Building, None).0
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
            speed_kmh: 100.0,
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
        let mut terrain_start = Vec::with_capacity(total_subs);
        let mut terrain_end = Vec::with_capacity(total_subs);

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
                terrain_start.push(0.0_f32);
                terrain_end.push(0.0_f32);
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
                aircraft_type: [0u8; 4],
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
                    terrain_start_elev_m: &terrain_start[lo..hi],
                    terrain_end_elev_m: &terrain_end[lo..hi],
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
            &MockRasters,
            365,
            0,
            None,
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
            speed_kmh: 100.0,
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
            &[],
            &MockRasters,
            &config,
        );

        // Should have road + railway
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
