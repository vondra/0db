//! Shared path effect computation for popup and pipeline.
//!
//! Computes terrain diffraction, building screening (+ noise barriers),
//! and vegetation attenuation for a single source-receiver pair.
//! Returns per-band [f64; NUM_BANDS] attenuation arrays.

use crate::types::{NUM_BANDS, RasterSampler, Barrier, ScreeningObstacleTrace};
use super::{diffraction, screening, vegetation};

/// Compute terrain diffraction attenuation per band.
///
/// Uses 5-point LOS fast-path check. If no obstruction detected, returns zero.
/// Applied at all distances — a hill at 3km still blocks sound.
pub fn terrain_attenuation(
    rasters: &dyn RasterSampler,
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
) -> [f64; NUM_BANDS] {
    // 5-point LOS check (25%, 50%, 75%)
    let hill_detected = [0.25, 0.5, 0.75].iter().any(|&t| {
        let lat = src_lat + t * (rcv_lat - src_lat);
        let lon = src_lon + t * (rcv_lon - src_lon);
        let elev = rasters.elevation(lat, lon);
        let los = src_elev + (rcv_alt - src_elev) * t;
        elev > los
    });

    if !hill_detected { return [0.0; NUM_BANDS]; }

    // Hill detected — full terrain profile
    let profile = rasters.terrain_profile(src_lat, src_lon, rcv_lat, rcv_lon, 0);
    let src_ground = if !profile.is_empty() { profile[0] } else { 0.0 };
    let src_agl = (src_elev - src_ground).max(0.05);
    let rcv_agl = crate::constants::DEFAULT_RECEIVER_HEIGHT;
    let diff = diffraction::compute_path_difference(&profile, dist_m, src_agl, rcv_agl);
    diffraction::diffraction_attenuation_with_edge(diff.delta, diff.is_double, diff.edge_distance)
}

/// Compute building screening attenuation per band.
///
/// Samples building height along the ENTIRE source→receiver path (~30m steps).
/// Finds the tallest obstruction (building or noise barrier) anywhere on the path.
///
/// WHY: Previous version sampled only the midpoint (50% of path). A building at 5%
/// or 42% of the path was invisible. This caused CAVD industrial area (1 km²) to
/// show 0 dB at 500m because buildings inside the compound blocked the midpoint
/// but not the actual line-of-sight from edge grid points.
/// Now we sample every ~30m, matching terrain_attenuation() which also profiles
/// the full path. Any building anywhere on the line-of-sight is found.
///
/// `exclusion_radius_m`: skip screening samples closer than this distance from source.
/// WHY: Grid points inside an industrial polygon emit through the polygon's own buildings.
/// R = √(area/π) approximates the polygon footprint radius. Buildings within R of the
/// source are the source itself, not real obstacles (ISO 9613-2: screening = obstacles
/// BETWEEN source and receiver, not at source location).
///
/// Also checks explicit noise barriers from the barriers vector.
pub fn screening_attenuation(
    rasters: &dyn RasterSampler,
    barriers: &[Barrier],
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
    exclusion_radius_m: f64,
) -> [f64; NUM_BANDS] {
    let excl_limit = exclusion_radius_m.max(0.0);

    // Fast reject: check barriers first (cheap).
    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let mid_lat_rad = ((src_lat + rcv_lat) * 0.5).to_radians();
    let meters_per_deg_lon = 111_320.0 * mid_lat_rad.cos();
    let path_dx_m = dlon * meters_per_deg_lon;
    let path_dy_m = dlat * 110_540.0;
    let path_len_sq_m = (path_dx_m * path_dx_m + path_dy_m * path_dy_m).max(1e-12);
    let barrier_hit_radius_sq = 50.0 * 50.0;

    let mut barrier_max_h = 0.0;
    let mut barrier_max_t = 0.5;
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 { break; }
        let bx_m = (barrier.lon - src_lon) * meters_per_deg_lon;
        let by_m = (barrier.lat - src_lat) * 110_540.0;
        let t = (bx_m * path_dx_m + by_m * path_dy_m) / path_len_sq_m;
        if t < 0.01 || t > 0.99 { continue; }
        let perp_dx_m = bx_m - t * path_dx_m;
        let perp_dy_m = by_m - t * path_dy_m;
        let perp_sq_m = perp_dx_m * perp_dx_m + perp_dy_m * perp_dy_m;
        if perp_sq_m < barrier_hit_radius_sq && barrier.height_m as f64 > barrier_max_h {
            barrier_max_h = barrier.height_m as f64;
            barrier_max_t = t;
        }
    }

    // Scan the whole path once for the tallest building candidate.
    // A sparse 25/50/75 probe can miss real blockers between probe points.
    let (mut max_bh, mut max_bh_t) = rasters.max_building_along_path(
        src_lat, src_lon, rcv_lat, rcv_lon, dist_m, excl_limit,
    );

    if barrier_max_h > max_bh {
        max_bh = barrier_max_h;
        max_bh_t = barrier_max_t;
    }

    if max_bh <= 0.0 { return [0.0; NUM_BANDS]; }

    let bld_ground = rasters.elevation(
        src_lat + max_bh_t * dlat,
        src_lon + max_bh_t * dlon,
    );
    let bld_top = bld_ground + max_bh;
    let los_height = src_elev + (rcv_alt - src_elev) * max_bh_t;
    let screen_h = bld_top - los_height; // vertical height above line-of-sight

    if screen_h > 0.0 {
        // δ = |S→B| + |B→R| - |S→R| using full 3D coordinates.
        // S = (0, src_elev), B = (d_horiz_to_bld, bld_top), R = (dist_m, rcv_alt).
        let d1_h = max_bh_t * dist_m;           // horizontal: source → building
        let d2_h = (1.0 - max_bh_t) * dist_m;   // horizontal: building → receiver
        let dz_sb = bld_top - src_elev;          // vertical: source → building top
        let dz_br = rcv_alt - bld_top;           // vertical: building top → receiver
        let dz_sr = rcv_alt - src_elev;          // vertical: source → receiver
        let d_sb = (d1_h * d1_h + dz_sb * dz_sb).sqrt();
        let d_br = (d2_h * d2_h + dz_br * dz_br).sqrt();
        let d_sr = (dist_m * dist_m + dz_sr * dz_sr).sqrt();
        let delta = (d_sb + d_br - d_sr).max(0.0);
        screening::building_screening(delta)
    } else {
        [0.0; NUM_BANDS]
    }
}

/// Terrain attenuation with metadata (delta, is_double) for popup tooltips.
///
/// Combines terrain_attenuation() and metadata extraction into a single pass,
/// avoiding the duplicate terrain_profile + compute_path_difference calls that
/// occur when calling terrain_attenuation() then extracting metadata separately.
pub fn terrain_attenuation_with_meta(
    rasters: &dyn RasterSampler,
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
) -> ([f64; NUM_BANDS], f64, bool, u32) {
    let hill_detected = [0.25, 0.5, 0.75].iter().any(|&t| {
        let lat = src_lat + t * (rcv_lat - src_lat);
        let lon = src_lon + t * (rcv_lon - src_lon);
        let elev = rasters.elevation(lat, lon);
        let los = src_elev + (rcv_alt - src_elev) * t;
        elev > los
    });

    if !hill_detected { return ([0.0; NUM_BANDS], 0.0, false, 0); }

    let profile = rasters.terrain_profile(src_lat, src_lon, rcv_lat, rcv_lon, 0);
    let profile_points = profile.len() as u32;
    let src_ground = if !profile.is_empty() { profile[0] } else { 0.0 };
    let src_agl = (src_elev - src_ground).max(0.05);
    let rcv_agl = crate::constants::DEFAULT_RECEIVER_HEIGHT;
    let diff = diffraction::compute_path_difference(&profile, dist_m, src_agl, rcv_agl);
    let atten = diffraction::diffraction_attenuation_with_edge(diff.delta, diff.is_double, diff.edge_distance);
    (atten, diff.delta, diff.is_double, profile_points)
}

/// Screening attenuation with full obstacle trace for popup tooltips.
///
/// Combines screening_attenuation() and max_building_along_path() into a single
/// pass, avoiding the duplicate path scan. Returns the single obstacle the
/// engine chose as dominant (barrier or raster-sampled building) plus the
/// intermediate Fresnel geometry — no fabricated aggregates.
pub fn screening_attenuation_with_meta(
    rasters: &dyn RasterSampler,
    barriers: &[Barrier],
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
    exclusion_radius_m: f64,
) -> ([f64; NUM_BANDS], ScreeningObstacleTrace) {
    let excl_limit = exclusion_radius_m.max(0.0);

    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let mid_lat_rad = ((src_lat + rcv_lat) * 0.5).to_radians();
    let meters_per_deg_lon = 111_320.0 * mid_lat_rad.cos();
    let path_dx_m = dlon * meters_per_deg_lon;
    let path_dy_m = dlat * 110_540.0;
    let path_len_sq_m = (path_dx_m * path_dx_m + path_dy_m * path_dy_m).max(1e-12);
    let barrier_hit_radius_sq = 50.0 * 50.0;

    let mut barrier_max_h = 0.0;
    let mut barrier_max_t = 0.5;
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 { break; }
        let bx_m = (barrier.lon - src_lon) * meters_per_deg_lon;
        let by_m = (barrier.lat - src_lat) * 110_540.0;
        let t = (bx_m * path_dx_m + by_m * path_dy_m) / path_len_sq_m;
        if t < 0.01 || t > 0.99 { continue; }
        let perp_dx_m = bx_m - t * path_dx_m;
        let perp_dy_m = by_m - t * path_dy_m;
        let perp_sq_m = perp_dx_m * perp_dx_m + perp_dy_m * perp_dy_m;
        if perp_sq_m < barrier_hit_radius_sq && barrier.height_m as f64 > barrier_max_h {
            barrier_max_h = barrier.height_m as f64;
            barrier_max_t = t;
        }
    }

    let (raster_bh, raster_t, samples_taken, step_m) = rasters.max_building_along_path_stats(
        src_lat, src_lon, rcv_lat, rcv_lon, dist_m, excl_limit,
    );

    // Pick the winner and remember its kind for the popup trace.
    let (max_bh, max_bh_t, kind): (f64, f64, &'static str) = if barrier_max_h > raster_bh {
        (barrier_max_h, barrier_max_t, "barrier")
    } else if raster_bh > 0.0 {
        (raster_bh, raster_t, "building")
    } else {
        (0.0, 0.5, "none")
    };

    if max_bh <= 0.0 {
        return ([0.0; NUM_BANDS], ScreeningObstacleTrace {
            kind: "none", height_m: 0.0, t: 0.0, screen_h_m: 0.0, delta_m: 0.0,
            samples_taken, step_m,
        });
    }

    let bld_ground = rasters.elevation(
        src_lat + max_bh_t * dlat,
        src_lon + max_bh_t * dlon,
    );
    let bld_top = bld_ground + max_bh;
    let los_height = src_elev + (rcv_alt - src_elev) * max_bh_t;
    let screen_h = bld_top - los_height;

    if screen_h > 0.0 {
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
            kind, height_m: max_bh, t: max_bh_t, screen_h_m: screen_h, delta_m: delta,
            samples_taken, step_m,
        };
        (screening::building_screening(delta), trace)
    } else {
        // Obstacle exists but below line-of-sight — no Fresnel screening.
        let trace = ScreeningObstacleTrace {
            kind, height_m: max_bh, t: max_bh_t, screen_h_m: screen_h, delta_m: 0.0,
            samples_taken, step_m,
        };
        ([0.0; NUM_BANDS], trace)
    }
}

/// Compute vegetation attenuation per band.
///
/// Applied for the full source→receiver path matching terrain and screening.
/// Forest depth is summed over contiguous forest sections (≥10 m) along the
/// 1D line through the WorldCover 30 m raster. Per-band attenuation is capped
/// at MAX_VEG_ATTEN (ISO 9613-2 Table A.1: 200 m effective depth ceiling),
/// so even multi-kilometre paths through forest don't produce unbounded effects.
pub fn vegetation_attenuation_path(
    rasters: &dyn RasterSampler,
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    _dist_m: f64,
) -> [f64; NUM_BANDS] {
    let forest_depth = rasters.vegetation_depth(src_lat, src_lon, rcv_lat, rcv_lon);
    vegetation::vegetation_attenuation(forest_depth)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SingleBuildingRaster {
        building_t: f64,
        building_height_m: f64,
    }

    impl RasterSampler for SingleBuildingRaster {
        fn elevation(&self, _lat: f64, _lon: f64) -> f64 { 0.0 }
        fn building_height(&self, _lat: f64, _lon: f64) -> f64 { 0.0 }
        fn vegetation_depth(&self, _lat1: f64, _lon1: f64, _lat2: f64, _lon2: f64) -> f64 { 0.0 }
        fn ground_g(&self, _lat: f64, _lon: f64) -> f64 { 0.0 }
        fn ground_g_path(&self, _lat1: f64, _lon1: f64, _lat2: f64, _lon2: f64) -> f64 { 0.0 }
        fn terrain_profile(&self, _lat1: f64, _lon1: f64, _lat2: f64, _lon2: f64, _steps: usize) -> Vec<f64> {
            vec![0.0, 0.0]
        }
        fn building_enclosure(&self, _lat: f64, _lon: f64) -> f64 { 0.0 }

        fn max_building_along_path(
            &self,
            _src_lat: f64,
            _src_lon: f64,
            _rcv_lat: f64,
            _rcv_lon: f64,
            _dist_m: f64,
            excl_start_m: f64,
        ) -> (f64, f64) {
            if excl_start_m > 0.0 {
                (0.0, 0.5)
            } else {
                (self.building_height_m, self.building_t)
            }
        }
    }

    #[test]
    fn screening_does_not_miss_building_between_sparse_probe_points() {
        let raster = SingleBuildingRaster {
            building_t: 0.4,
            building_height_m: 20.0,
        };

        let atten = screening_attenuation(
            &raster,
            &[],
            0.0, 0.0,
            0.0, 0.01,
            1.0, 1.0,
            1000.0,
            0.0,
        );

        assert!(
            atten.iter().any(|&a| a > 0.0),
            "blocking building at t=0.4 should produce screening, got {atten:?}"
        );
    }
}
