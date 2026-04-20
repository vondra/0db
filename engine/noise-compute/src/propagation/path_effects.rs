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
use super::{screening, vegetation};
use crate::constants::{M_PER_DEG_LAT, M_PER_DEG_LON_EQ};
use crate::types::{Barrier, ScreeningObstacleTrace, NUM_BANDS};

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
pub fn terrain_attenuation(
    profile: &mut PathProfile,
    src_elev: f64,
    rcv_alt: f64,
) -> [f64; NUM_BANDS] {
    let (atten, _, _, _) = terrain_attenuation_with_meta(profile, src_elev, rcv_alt);
    atten
}

/// Terrain attenuation + metadata for popup tooltips (δ, is_double, profile_points).
pub fn terrain_attenuation_with_meta(
    profile: &mut PathProfile,
    src_elev: f64,
    rcv_alt: f64,
) -> ([f64; NUM_BANDS], f64, bool, u32) {
    if profile.t.len() < 3 || profile.dist_m < 30.0 {
        return ([0.0; NUM_BANDS], 0.0, false, 0);
    }

    // Fast-path scan — zero extra raster reads, elevation is already buffered.
    let dz_total = rcv_alt - src_elev;
    let hill = profile
        .t
        .iter()
        .zip(profile.elevation_m.iter())
        .any(|(&t, &e)| (e as f64) > src_elev + dz_total * t);

    if !hill {
        return ([0.0; NUM_BANDS], 0.0, false, 0);
    }

    // Rebuild a full-precision f64 elevation profile in diffraction units
    // (absolute metres) — source and receiver anchors use the provided
    // altitudes to preserve receiver/source height-above-ground.
    let n = profile.t.len();
    let src_ground = profile.elevation_m[0] as f64;
    let src_h = (src_elev - src_ground).max(0.05);
    let rcv_ground = profile.elevation_m[n - 1] as f64;
    let rcv_h = (rcv_alt - rcv_ground).max(crate::constants::DEFAULT_RECEIVER_HEIGHT.min(0.5));
    let dist_m = profile.dist_m;

    // Lazy-populated f64 elevation buffer — reuses capacity across calls.
    // Split-borrow: `elevation_f64_scratch` is mutably borrowed by the helper,
    // while `t` and `elevation_m` stay available for shared access.
    let PathProfile {
        t,
        elevation_m,
        elevation_f64_scratch,
        ..
    } = profile;
    let prof_f64 =
        PathProfile::elevation_f64_from(elevation_f64_scratch, elevation_m);

    let diff =
        diffraction::compute_path_difference(t, prof_f64, dist_m, src_h, rcv_h);
    let atten = diffraction::diffraction_attenuation_rayleigh(&diff);
    (atten, diff.delta, diff.is_double, n as u32)
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
    profile: &PathProfile,
    barriers: &[Barrier],
    src_elev: f64,
    rcv_alt: f64,
    exclusion_radius_m: f64,
) -> [f64; NUM_BANDS] {
    let (atten, _) =
        screening_attenuation_with_meta(profile, barriers, src_elev, rcv_alt, exclusion_radius_m);
    atten
}

/// Screening attenuation + obstacle trace for popup tooltips.
pub fn screening_attenuation_with_meta(
    profile: &PathProfile,
    barriers: &[Barrier],
    src_elev: f64,
    rcv_alt: f64,
    exclusion_radius_m: f64,
) -> ([f64; NUM_BANDS], ScreeningObstacleTrace) {
    let excl_limit = exclusion_radius_m.max(0.0);
    let dist_m = profile.dist_m;
    let (src_lat, src_lon) = (profile.src_lat, profile.src_lon);
    let (rcv_lat, rcv_lon) = (profile.rcv_lat, profile.rcv_lon);

    // Barriers — cheap geometry check (no profile needed).
    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let mid_lat_rad = ((src_lat + rcv_lat) * 0.5).to_radians();
    let meters_per_deg_lon = M_PER_DEG_LON_EQ * mid_lat_rad.cos();
    let path_dx_m = dlon * meters_per_deg_lon;
    let path_dy_m = dlat * M_PER_DEG_LAT;
    let path_len_sq_m = (path_dx_m * path_dx_m + path_dy_m * path_dy_m).max(1e-12);
    let barrier_hit_radius_sq = 50.0 * 50.0;

    let mut barrier_max_h = 0.0;
    let mut barrier_max_t = 0.5;
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 {
            break;
        }
        let bx_m = (barrier.lon - src_lon) * meters_per_deg_lon;
        let by_m = (barrier.lat - src_lat) * M_PER_DEG_LAT;
        let t = (bx_m * path_dx_m + by_m * path_dy_m) / path_len_sq_m;
        if !(0.01..=0.99).contains(&t) {
            continue;
        }
        let perp_dx_m = bx_m - t * path_dx_m;
        let perp_dy_m = by_m - t * path_dy_m;
        let perp_sq_m = perp_dx_m * perp_dx_m + perp_dy_m * perp_dy_m;
        if perp_sq_m < barrier_hit_radius_sq && barrier.height_m as f64 > barrier_max_h {
            barrier_max_h = barrier.height_m as f64;
            barrier_max_t = t;
        }
    }

    // Buildings — scan the profile's pre-computed building_h_m.
    let mut raster_bh = 0.0_f64;
    let mut raster_t = 0.5_f64;
    let mut samples_taken: u32 = 0;
    for (i, &t) in profile.t.iter().enumerate() {
        if t <= 0.0 || t >= 1.0 {
            continue;
        }
        if excl_limit > 0.0 && t * dist_m < excl_limit {
            continue;
        }
        samples_taken += 1;
        let bh = profile.building_h_m[i] as f64;
        if bh > raster_bh {
            raster_bh = bh;
            raster_t = t;
        }
    }

    let (max_bh, max_bh_t, kind): (f64, f64, &'static str) = if barrier_max_h > raster_bh {
        (barrier_max_h, barrier_max_t, "barrier")
    } else if raster_bh > 0.0 {
        (raster_bh, raster_t, "building")
    } else {
        (0.0, 0.5, "none")
    };

    if max_bh <= 0.0 {
        return (
            [0.0; NUM_BANDS],
            ScreeningObstacleTrace {
                kind: "none",
                height_m: 0.0,
                t: 0.0,
                screen_h_m: 0.0,
                delta_m: 0.0,
                samples_taken,
                step_m: profile.step_m_med as f64,
            },
        );
    }

    // Ground under the obstacle — interpolate from profile.elevation_m.
    let bld_ground = interp_elev_at_t(profile, max_bh_t);
    let bld_top = bld_ground + max_bh;
    let los_height = src_elev + (rcv_alt - src_elev) * max_bh_t;
    let screen_h = bld_top - los_height;

    if screen_h > 0.0 {
        // δ = |S→B| + |B→R| − |S→R| (3D Fresnel geometry).
        let d1_h = max_bh_t * dist_m;
        let d2_h = (1.0 - max_bh_t) * dist_m;
        let dz_sb = bld_top - src_elev;
        let dz_br = rcv_alt - bld_top;
        let dz_sr = rcv_alt - src_elev;
        let d_sb = (d1_h * d1_h + dz_sb * dz_sb).sqrt();
        let d_br = (d2_h * d2_h + dz_br * dz_br).sqrt();
        let d_sr = (dist_m * dist_m + dz_sr * dz_sr).sqrt();
        let delta = (d_sb + d_br - d_sr).max(0.0);
        let trace = ScreeningObstacleTrace {
            kind,
            height_m: max_bh,
            t: max_bh_t,
            screen_h_m: screen_h,
            delta_m: delta,
            samples_taken,
            step_m: profile.step_m_med as f64,
        };
        (screening::building_screening(delta), trace)
    } else {
        // Obstacle exists but below line-of-sight — no Fresnel screening.
        let trace = ScreeningObstacleTrace {
            kind,
            height_m: max_bh,
            t: max_bh_t,
            screen_h_m: screen_h,
            delta_m: 0.0,
            samples_taken,
            step_m: profile.step_m_med as f64,
        };
        ([0.0; NUM_BANDS], trace)
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

/// Linear interpolation of elevation_m at a given t ∈ [0, 1] using the profile's
/// sample array.
fn interp_elev_at_t(profile: &PathProfile, t_query: f64) -> f64 {
    if profile.t.is_empty() {
        return 0.0;
    }
    if profile.t.len() == 1 {
        return profile.elevation_m[0] as f64;
    }
    // Binary search for the bracket.
    let t_query = t_query.clamp(0.0, 1.0);
    let pos = profile
        .t
        .binary_search_by(|a| a.partial_cmp(&t_query).unwrap_or(std::cmp::Ordering::Equal));
    match pos {
        Ok(i) => profile.elevation_m[i] as f64,
        Err(i) => {
            if i == 0 {
                profile.elevation_m[0] as f64
            } else if i >= profile.t.len() {
                profile.elevation_m[profile.t.len() - 1] as f64
            } else {
                let t0 = profile.t[i - 1];
                let t1 = profile.t[i];
                let frac = if t1 > t0 {
                    (t_query - t0) / (t1 - t0)
                } else {
                    0.0
                };
                let e0 = profile.elevation_m[i - 1] as f64;
                let e1 = profile.elevation_m[i] as f64;
                e0 + frac * (e1 - e0)
            }
        }
    }
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
        let (atten, delta, _, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert_eq!(delta, 0.0, "flat profile should not diffract");
        assert!(atten.iter().all(|&a| a == 0.0));
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
        let (_, delta, _, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(delta > 0.0, "ridge at t=0.35 must trigger diffraction");
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
        let (_, delta, _, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(delta > 0.0, "cliff at t=0.03 must be caught");
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
        let (_, delta, _, _) = terrain_attenuation_with_meta(&mut p, src_elev, rcv_alt);
        assert!(delta > 0.0, "terrace at t=0.97 must be caught");
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
        let (atten, trace) =
            screening_attenuation_with_meta(&p, &[], 0.01, 1.5, 0.0);
        assert_eq!(trace.kind, "building");
        assert!(trace.height_m == 20.0);
        assert!(
            atten.iter().any(|&a| a > 0.0),
            "building at t=0.4 should produce screening"
        );
    }
}
