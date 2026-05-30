//! Shared path effect computation for popup and pipeline.
//!
//! All four path-effect rasters (DEM, Overture building, WorldCover forest,
//! IMD imperviousness) are sampled by [`RasterSampler::build_path_profile`]
//! into a single [`PathProfile`]. The six entry points in this module read
//! from that profile; they never walk the path again.
//!
//! See [`super::path_profile`] for the canonical cadence and docs.

use super::diffraction;
use super::path_profile::{path_integral_u8, vegetation_run_length, PathProfile};
use super::vegetation;
use crate::constants::{M_PER_DEG_LAT, M_PER_DEG_LON_EQ};
use crate::types::{Barrier, EdgePoint, ObstacleEdge, ScreeningObstacleTrace, TerrainTrace, NUM_BANDS};

/// Terrain diffraction attenuation per band from a `PathProfile`.
///
/// `src_elev` and `rcv_alt` are absolute altitudes (metres above sea level)
/// of the source and receiver, including their respective heights above ground.
///
/// Applies a cheap in-profile "any sample above LoS" scan to short-circuit when
/// no obstruction exists (the previous sparse 3-point gate is gone — it shared
/// the bilateral cadence's blind zones near endpoints).
///
/// Takes `&mut PathProfile` so an internal f64 scratch buffer can be reused
/// across calls instead of allocating per path.
///
/// Fast path: no trace metadata built, no `Vec<EdgePoint>` allocation.
/// Pipeline-worker's hot loop uses this; popup uses `_with_meta`.
pub fn terrain_attenuation(
    profile: &mut PathProfile,
    src_elev: f64,
    rcv_alt: f64,
) -> [f64; NUM_BANDS] {
    match compute_terrain_diffraction(profile, src_elev, rcv_alt) {
        None => [0.0; NUM_BANDS],
        Some(res) => diffraction::diffraction_attenuation_rayleigh(&res.diff),
    }
}

#[inline]
fn empty_terrain_trace() -> TerrainTrace {
    TerrainTrace {
        delta_m: 0.0,
        is_double: false,
        attenuation_bands: [0.0; NUM_BANDS],
        n_edges: 0,
        edges: Vec::new(),
        delta_star_m: 0.0,
        edge_distance_m: 0.0,
        dominant_edge_idx: 0,
    }
}

/// Shared intermediate between `terrain_attenuation` and `_with_meta`.
/// Carries the raw `DiffractionResult` plus the source/receiver absolute
/// altitudes needed by the meta path to compute the dominant-edge LOS.
struct TerrainDiffraction<'a> {
    diff: crate::propagation::diffraction::DiffractionResult,
    /// Profile passed through as f64 — valid only for the duration of the
    /// caller's borrow of `profile.elevation_f64_scratch`.
    prof_f64: &'a [f64],
    t: &'a [f64],
    src_abs: f64,
    rcv_abs: f64,
    n: usize,
}

fn compute_terrain_diffraction<'a>(
    profile: &'a mut PathProfile,
    src_elev: f64,
    rcv_alt: f64,
) -> Option<TerrainDiffraction<'a>> {
    if profile.t.len() < 3 || profile.dist_m < 30.0 {
        return None;
    }
    let dz_total = rcv_alt - src_elev;
    let hill = profile
        .t
        .iter()
        .zip(profile.elevation_m.iter())
        .any(|(&t, &e)| (e as f64) > src_elev + dz_total * t);
    if !hill {
        return None;
    }

    // Absolute altitudes are what diffraction integrates against; per-end
    // heights above ground feed the mirror-fit δ* computation.
    let n = profile.t.len();
    let src_ground = profile.elevation_m[0] as f64;
    let src_h = (src_elev - src_ground).max(0.05);
    let rcv_ground = profile.elevation_m[n - 1] as f64;
    let rcv_h = (rcv_alt - rcv_ground).max(crate::constants::DEFAULT_RECEIVER_HEIGHT.min(0.5));
    let dist_m = profile.dist_m;

    let PathProfile {
        t,
        elevation_m,
        elevation_f64_scratch,
        ..
    } = profile;
    let prof_f64 = PathProfile::elevation_f64_from(elevation_f64_scratch, elevation_m);
    let diff = diffraction::compute_path_difference(t, prof_f64, dist_m, src_h, rcv_h);
    Some(TerrainDiffraction {
        diff,
        prof_f64,
        t,
        src_abs: src_ground + src_h,
        rcv_abs: rcv_ground + rcv_h,
        n,
    })
}

/// Terrain attenuation + full multi-edge trace for popup tooltips.
///
/// Returns `(trace, profile_points)` where `trace` contains per-band
/// attenuation, the diffraction δ, Rayleigh δ\*, first-to-last edge
/// distance, N ∈ {0, 1, 2, 3} edge count, and the list of edges found by
/// the upper-convex-hull algorithm (see `diffraction::compute_path_difference`).
/// `profile_points` is the raw sample count the engine scanned — surfaced to
/// popup as transparency metadata.
pub fn terrain_attenuation_with_meta(
    profile: &mut PathProfile,
    src_elev: f64,
    rcv_alt: f64,
) -> (TerrainTrace, u32) {
    let Some(res) = compute_terrain_diffraction(profile, src_elev, rcv_alt) else {
        return (empty_terrain_trace(), 0);
    };
    let TerrainDiffraction { diff, prof_f64, t, src_abs, rcv_abs, n } = res;
    let atten = diffraction::diffraction_attenuation_rayleigh(&diff);

    // Single pass: materialise edges + track dominant (max LOS excess).
    // Matches the `d_idx` selection inside `diffraction::compute_double_edge`
    // and `compute_triple_edge` so the popup SVG highlights the same edge
    // the Rayleigh δ* mirror fit was anchored at.
    let n_edges = diff.n_edges as usize;
    let mut edges: Vec<EdgePoint> = Vec::with_capacity(n_edges);
    let mut best_idx = 0usize;
    let mut best_excess = f64::NEG_INFINITY;
    for k in 0..n_edges {
        let idx = diff.edge_indices[k];
        let ti = t[idx];
        let elev = prof_f64[idx];
        let los = src_abs + (rcv_abs - src_abs) * ti;
        let excess = elev - los;
        if excess > best_excess {
            best_excess = excess;
            best_idx = k;
        }
        edges.push(EdgePoint { t: ti, elevation_m: elev });
    }

    let trace = TerrainTrace {
        delta_m: diff.delta,
        is_double: diff.is_double,
        attenuation_bands: atten,
        n_edges: diff.n_edges,
        edges,
        delta_star_m: diff.delta_star,
        edge_distance_m: diff.edge_distance,
        dominant_edge_idx: best_idx as u8,
    };
    (trace, n as u32)
}

/// Building screening attenuation per band from a `PathProfile`.
///
/// Scans `building_h_m[]` for the tallest obstacle above line-of-sight.
/// Also checks explicit noise barriers (not in the profile since they're
/// sparse point sources, not a raster).
///
/// `exclusion_radius_m`: skip building samples closer than this distance from
/// source — the source polygon's own buildings are not real obstacles.
pub fn screening_attenuation(
    profile: &mut PathProfile,
    barriers: &[Barrier],
    src_elev: f64,
    rcv_alt: f64,
    exclusion_radius_m: f64,
    terrain_atten: &[f64; NUM_BANDS],
) -> [f64; NUM_BANDS] {
    // No building or barrier anywhere on the path ⇒ the composite top profile
    // equals bare earth ⇒ the screening increment over terrain is exactly zero.
    // Skip the per-sample composite scan + OLS Fresnel fit (the dominant
    // screening cost) for the rural majority. Conservative: a building at an
    // endpoint (which the scan itself ignores) still trips the flag, so a real
    // interior obstacle is never skipped.
    if barriers.is_empty() && !profile.building_h_m.iter().any(|&b| b > 0) {
        return [0.0; NUM_BANDS];
    }
    let (atten, _) = screening_attenuation_with_meta(
        profile, barriers, src_elev, rcv_alt, exclusion_radius_m, terrain_atten,
    );
    atten
}

/// Screening attenuation + obstacle trace for popup tooltips.
///
/// Combines terrain+building+barrier diffraction into a single Fresnel
/// computation over a composite top profile, returning the *increment* over
/// pure-terrain diffraction. `terrain_atten` must be the result of a prior
/// `terrain_attenuation[_with_meta]` call on the same profile/source/receiver —
/// reused here so we don't recompute bare-earth diffraction twice. In
/// `iso9613.rs`, `A_terrain + A_screen` then equals the true combined
/// attenuation, with no terrain+screening double-count (the pre-merge
/// implementation could over-attenuate by up to 10 dB when a building sat
/// on a hill — both terms then claimed full Fresnel diffraction).
///
/// The δ* Rayleigh gate uses **bare-earth** elevation for the OLS mean-ground
/// fit (CNOSSOS §2.5.6(c)). Feeding composite heights to OLS would drag the
/// mean-ground plane up to rooftops, silently breaking ground-reflection
/// physics.
pub fn screening_attenuation_with_meta(
    profile: &mut PathProfile,
    barriers: &[Barrier],
    src_elev: f64,
    rcv_alt: f64,
    exclusion_radius_m: f64,
    terrain_atten: &[f64; NUM_BANDS],
) -> ([f64; NUM_BANDS], ScreeningObstacleTrace) {
    use super::diffraction::{compute_path_difference_with_ols, diffraction_attenuation_rayleigh};
    let excl_limit = exclusion_radius_m.max(0.0);
    let dist_m = profile.dist_m;
    let (src_lat, src_lon) = (profile.src_lat, profile.src_lon);
    let (rcv_lat, rcv_lon) = (profile.rcv_lat, profile.rcv_lon);
    let n = profile.t.len();
    // Copy scalars before the later split-borrow of `profile` via destructure.
    let step_m_med = profile.step_m_med as f64;

    let make_empty = || ScreeningObstacleTrace {
        kind: "none",
        height_m: 0.0,
        t: 0.0,
        screen_h_m: 0.0,
        delta_m: 0.0,
        samples_taken: 0,
        step_m: step_m_med,
        n_edges: 0,
        edges: Vec::new(),
    };

    if n < 3 || dist_m < 30.0 {
        return ([0.0; NUM_BANDS], make_empty());
    }

    // 1. Barriers — project each onto path, map to nearest sample index.
    //    Kept as an independent candidate merged into composite_h below.
    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let mid_lat_rad = ((src_lat + rcv_lat) * 0.5).to_radians();
    let meters_per_deg_lon = M_PER_DEG_LON_EQ * mid_lat_rad.cos();
    let path_dx_m = dlon * meters_per_deg_lon;
    let path_dy_m = dlat * M_PER_DEG_LAT;
    let path_len_sq_m = (path_dx_m * path_dx_m + path_dy_m * path_dy_m).max(1e-12);
    let barrier_hit_radius_sq = 50.0 * 50.0;

    // barrier_at[i] = tallest barrier mapped to sample i (absolute height above
    // ground at i, or 0 if no barrier near that sample).
    let mut barrier_at: Vec<f32> = vec![0.0; n];
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 {
            break;
        }
        let bx_m = (barrier.lon - src_lon) * meters_per_deg_lon;
        let by_m = (barrier.lat - src_lat) * M_PER_DEG_LAT;
        let t_proj = (bx_m * path_dx_m + by_m * path_dy_m) / path_len_sq_m;
        if !(0.01..=0.99).contains(&t_proj) {
            continue;
        }
        let perp_dx_m = bx_m - t_proj * path_dx_m;
        let perp_dy_m = by_m - t_proj * path_dy_m;
        let perp_sq_m = perp_dx_m * perp_dx_m + perp_dy_m * perp_dy_m;
        if perp_sq_m >= barrier_hit_radius_sq {
            continue;
        }
        let idx = nearest_t_index(&profile.t, t_proj);
        let bh = barrier.height_m as f32;
        if bh > barrier_at[idx] {
            barrier_at[idx] = bh;
        }
    }

    // 2. Bare-earth elevation as f64 (reuses amortized scratch buffer).
    //    Split-borrow pattern per terrain_attenuation_with_meta. No copy:
    //    we hold the scratch slice for the rest of the function.
    let PathProfile {
        t,
        elevation_m,
        building_h_m,
        elevation_f64_scratch,
        composite_h_scratch,
        ..
    } = profile;
    let elevation_f64: &[f64] =
        PathProfile::elevation_f64_from(elevation_f64_scratch, elevation_m);

    // 3. Composite top profile = elevation + max(building_h, barrier_at),
    //    with exclusion radius zeroing out buildings near the source (not
    //    barriers — explicit barrier polys are always real obstacles).
    composite_h_scratch.clear();
    composite_h_scratch.reserve(n);
    let mut samples_taken: u32 = 0;
    let mut barrier_wins_at_dominant = false;
    let mut dominant_composite_excess = 0.0_f64;
    let mut dominant_idx = 0usize;

    for i in 0..n {
        let ti = t[i];
        let ground = elevation_f64[i];
        let mut above_ground = 0.0_f64;

        if ti > 0.0 && ti < 1.0 {
            let bh = building_h_m[i] as f64;
            let bh_effective = if excl_limit > 0.0 && ti * dist_m < excl_limit {
                0.0
            } else {
                samples_taken += 1;
                bh
            };
            let barrier_h = barrier_at[i] as f64;
            above_ground = bh_effective.max(barrier_h);
        }

        let composite = ground + above_ground;
        composite_h_scratch.push(composite);

        let los_i = src_elev + (rcv_alt - src_elev) * ti;
        let excess_i = composite - los_i;
        if ti > 0.0 && ti < 1.0 && above_ground > 0.0 && excess_i > dominant_composite_excess {
            dominant_composite_excess = excess_i;
            dominant_idx = i;
            barrier_wins_at_dominant = (barrier_at[i] as f64) > (building_h_m[i] as f64);
        }
    }

    // If nothing above ground along the path: zero attenuation, none trace.
    if dominant_composite_excess <= 0.0 {
        let mut tr = make_empty();
        tr.samples_taken = samples_taken;
        return ([0.0; NUM_BANDS], tr);
    }

    // 4. Convert absolute altitudes to per-end heights above bare-earth for
    //    the diffraction API (matches terrain_attenuation contract).
    let src_h = (src_elev - elevation_f64[0]).max(0.05);
    let rcv_h = (rcv_alt - elevation_f64[n - 1]).max(0.5);

    // 5. Combined diffraction over composite, δ* fit on bare-earth.
    let res_combined = compute_path_difference_with_ols(
        t, composite_h_scratch, elevation_f64, dist_m, src_h, rcv_h,
    );
    let atten_combined = diffraction_attenuation_rayleigh(&res_combined);

    // 6. Screening = increment of combined over pure-terrain (passed in by the
    //    caller, already computed in terrain_attenuation_with_meta — avoids a
    //    redundant second Fresnel pass on bare-earth per path).
    //    `atten_terrain + atten_screen ≡ atten_combined` → no double-count.
    let mut atten_screen = [0.0_f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        atten_screen[i] = (atten_combined[i] - terrain_atten[i]).max(0.0);
    }

    // 7. Materialise per-edge ObstacleEdge list from the combined result.
    //    `edge_indices[..n_edges]` are sorted leftmost-to-rightmost in `t`.
    //    Per-edge `kind` is decided by which source dominates at the edge
    //    sample: pure bare-earth = "terrain", barrier > building = "barrier",
    //    otherwise "building".
    let n_edges_val = res_combined.n_edges as usize;
    let mut edges: Vec<ObstacleEdge> = Vec::with_capacity(n_edges_val);
    let mut dom_k = 0usize;
    let mut dom_excess = f64::NEG_INFINITY;
    for k in 0..n_edges_val {
        let idx = res_combined.edge_indices[k];
        let above = (composite_h_scratch[idx] - elevation_f64[idx]).max(0.0);
        let building = building_h_m[idx] as f64;
        let barrier = barrier_at[idx] as f64;
        let kind: &'static str = if above <= 0.0 {
            "terrain"
        } else if barrier > building {
            "barrier"
        } else {
            "building"
        };
        let los_i = src_elev + (rcv_alt - src_elev) * t[idx];
        let screen = composite_h_scratch[idx] - los_i;
        if screen > dom_excess {
            dom_excess = screen;
            dom_k = k;
        }
        edges.push(ObstacleEdge {
            kind,
            t: t[idx],
            height_m: if kind == "terrain" { 0.0 } else { above },
            screen_h_m: screen,
        });
    }

    // 8. Representative obstacle = dominant-excess edge (if edges exist),
    //    else fall back to the composite-dominant sample scanned earlier.
    //    Using max-excess (not leftmost) matches the physical blocker that
    //    the CNOSSOS Rayleigh δ* fit anchored against inside diffraction.rs.
    let (edge_idx, trace_kind, trace_height) = if !edges.is_empty() {
        let idx = res_combined.edge_indices[dom_k];
        let e = &edges[dom_k];
        (idx, e.kind, e.height_m)
    } else {
        let kind = if barrier_wins_at_dominant { "barrier" } else { "building" };
        let above = (composite_h_scratch[dominant_idx] - elevation_f64[dominant_idx]).max(0.0);
        (dominant_idx, kind, above)
    };

    let t_edge = t[edge_idx];
    let los_edge = src_elev + (rcv_alt - src_elev) * t_edge;
    let screen_h = composite_h_scratch[edge_idx] - los_edge;
    let delta_m = res_combined.delta;

    let trace = ScreeningObstacleTrace {
        kind: trace_kind,
        height_m: trace_height,
        t: t_edge,
        screen_h_m: screen_h,
        delta_m,
        samples_taken,
        step_m: step_m_med,
        n_edges: res_combined.n_edges,
        edges,
    };

    (atten_screen, trace)
}

/// Index of the sample in `t` closest to `t_query`. `t` is sorted ascending by
/// `fill_t_values`, so we binary-search the bracket and pick the closer end.
#[inline]
fn nearest_t_index(t: &[f64], t_query: f64) -> usize {
    if t.is_empty() {
        return 0;
    }
    match t.binary_search_by(|x| x.partial_cmp(&t_query).unwrap_or(std::cmp::Ordering::Equal)) {
        Ok(i) => i,
        Err(i) => {
            if i == 0 {
                0
            } else if i >= t.len() {
                t.len() - 1
            } else if (t[i] - t_query) < (t_query - t[i - 1]) {
                i
            } else {
                i - 1
            }
        }
    }
}

/// Vegetation (forest) attenuation per band from a `PathProfile`.
///
/// Uses the trapezoidal "run of forest-flagged intervals ≥10 m" integral on
/// `profile.forest_u8[]`. Non-uniform t spacing is weighted by interval length
/// so endpoints (dense) don't dominate — fixes the pre-existing FusedGrid bias.
pub fn vegetation_attenuation_path(profile: &PathProfile) -> [f64; NUM_BANDS] {
    let forest_depth =
        vegetation_run_length(&profile.t, &profile.forest_u8, profile.dist_m);
    vegetation::vegetation_attenuation(forest_depth)
}

/// Path-averaged ground factor G (0 = hard, 1 = soft) from `profile.imd_u8[]`.
/// Trapezoidal weighting — endpoints not oversampled.
pub fn ground_g_from_profile(profile: &PathProfile) -> f64 {
    let avg_imd = path_integral_u8(&profile.t, &profile.imd_u8, profile.dist_m);
    (1.0 - avg_imd / 100.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::propagation::path_profile::fill_t_values;

    fn build_flat_profile(dist_m: f64, ground_elev_m: f32) -> PathProfile {
        let mut p = PathProfile::new();
        p.dist_m = dist_m;
        p.src_lat = 0.0;
        p.src_lon = 0.0;
        p.rcv_lat = 0.0;
        p.rcv_lon = dist_m / 111_320.0;
        fill_t_values(dist_m, &mut p.t);
        let n = p.t.len();
        p.elevation_m = vec![ground_elev_m; n];
        p.building_h_m = vec![0; n];
        p.forest_u8 = vec![0; n];
        p.imd_u8 = vec![50; n];
        p.step_m_med = if n > 1 {
            ((p.t[1] - p.t[0]) * dist_m) as f32
        } else {
            0.0
        };
        p
    }

    #[test]
    fn flat_terrain_returns_zero_attenuation() {
        let mut p = build_flat_profile(1000.0, 10.0);
        let src_elev = 10.05;
        let rcv_alt = 11.5;
        let (trace, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert_eq!(trace.delta_m, 0.0, "flat profile should not diffract");
        assert_eq!(trace.n_edges, 0);
        assert!(trace.edges.is_empty());
        assert!(trace.attenuation_bands.iter().all(|&a| a == 0.0));
    }

    #[test]
    fn hill_at_mid_path_ridge_catches() {
        // Narrow ridge at t=0.35 — old 3-probe at t=0.25/0.5/0.75 would miss it
        // (profile is flat at those t values); new scan catches it in the bilateral
        // cadence's middle samples.
        let mut p = build_flat_profile(1000.0, 10.0);
        // Insert a spike at the sample closest to t=0.35.
        let (spike_idx, _) = p
            .t
            .iter()
            .enumerate()
            .min_by(|(_, &a), (_, &b)| {
                ((a - 0.35).abs()).partial_cmp(&((b - 0.35).abs())).unwrap()
            })
            .unwrap();
        p.elevation_m[spike_idx] = 40.0;

        let src_elev = 10.05;
        let rcv_alt = 11.5;
        let (trace, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(trace.delta_m > 0.0, "ridge at t=0.35 must trigger diffraction");
        assert!(trace.n_edges >= 1, "expected at least one diffraction edge");
        assert_eq!(trace.edges.len(), trace.n_edges as usize, "edges vec must match n_edges");
    }

    #[test]
    fn endpoint_near_cliff_catches() {
        // Cliff at t≈0.03 (right next to receiver) — old 3-probe starts at t=0.25
        // so it totally misses. Bilateral cadence has a sample at t≈0.03 at 1 km path
        // (30m/1000m = 0.03).
        let mut p = build_flat_profile(1000.0, 10.0);
        let (cliff_idx, _) = p
            .t
            .iter()
            .enumerate()
            .min_by(|(_, &a), (_, &b)| {
                ((a - 0.03).abs()).partial_cmp(&((b - 0.03).abs())).unwrap()
            })
            .unwrap();
        p.elevation_m[cliff_idx] = 40.0;

        let src_elev = 10.05;
        let rcv_alt = 11.5;
        let (trace, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(trace.delta_m > 0.0, "cliff at t=0.03 must be caught");
    }

    #[test]
    fn terrace_before_source_catches() {
        // Rise at t≈0.97 — old 3-probe ends at t=0.75 so it misses. Bilateral has a
        // sample at t≈0.97 thanks to the receiver-side densification.
        let mut p = build_flat_profile(1000.0, 10.0);
        let (spike_idx, _) = p
            .t
            .iter()
            .enumerate()
            .min_by(|(_, &a), (_, &b)| {
                ((a - 0.97).abs()).partial_cmp(&((b - 0.97).abs())).unwrap()
            })
            .unwrap();
        p.elevation_m[spike_idx] = 40.0;

        let src_elev = 10.05;
        let rcv_alt = 11.5;
        let (trace, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(trace.delta_m > 0.0, "terrace at t=0.97 must be caught");
    }

    #[test]
    fn screening_finds_midpath_building() {
        // Tall building at t=0.4 — should produce screening attenuation.
        let mut p = build_flat_profile(1000.0, 0.0);
        let (idx, _) = p
            .t
            .iter()
            .enumerate()
            .min_by(|(_, &a), (_, &b)| {
                ((a - 0.4).abs()).partial_cmp(&((b - 0.4).abs())).unwrap()
            })
            .unwrap();
        p.building_h_m[idx] = 20;
        let terrain_atten = [0.0_f64; NUM_BANDS];
        let (atten, trace) =
            screening_attenuation_with_meta(&mut p, &[], 0.01, 1.5, 0.0, &terrain_atten);
        assert_eq!(trace.kind, "building");
        assert!(trace.height_m == 20.0);
        assert_eq!(trace.edges.len(), trace.n_edges as usize, "edges vec must match n_edges");
        assert!(
            atten.iter().any(|&a| a > 0.0),
            "building at t=0.4 should produce screening"
        );
    }

    #[test]
    fn combined_edge_on_naked_hill_is_kind_terrain() {
        // A bare-earth hill at t=0.5 with no buildings anywhere. The composite
        // edge should be kind="terrain" (not "building") since the composite
        // top at that sample equals the DEM elevation (above_ground == 0).
        let mut p = build_flat_profile(1500.0, 10.0);
        let (spike, _) = p
            .t
            .iter()
            .enumerate()
            .min_by(|(_, &a), (_, &b)| {
                ((a - 0.5).abs()).partial_cmp(&((b - 0.5).abs())).unwrap()
            })
            .unwrap();
        p.elevation_m[spike] = 40.0;
        // building_h_m all zero — guaranteed by build_flat_profile.
        let (terrain_trace, _) = terrain_attenuation_with_meta(&mut p, 10.05, 11.5);
        let (_atten, screening_trace) = screening_attenuation_with_meta(
            &mut p,
            &[],
            10.05,
            11.5,
            0.0,
            &terrain_trace.attenuation_bands,
        );
        if screening_trace.n_edges > 0 {
            // Every edge in this geometry must be "terrain".
            for edge in &screening_trace.edges {
                assert_eq!(
                    edge.kind, "terrain",
                    "bare-earth hill edge must be kind=terrain, got {}",
                    edge.kind
                );
                assert_eq!(edge.height_m, 0.0, "terrain kind must have height_m=0");
            }
        }
    }
}
