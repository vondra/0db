//! Shared path effect computation for popup and pipeline.
//!
//! Computes terrain diffraction, building screening (+ noise barriers),
//! and vegetation attenuation for a single source-receiver pair.
//! Returns per-band [f64; NUM_BANDS] attenuation arrays.

use crate::types::{NUM_BANDS, RasterSampler, Barrier};
use super::{diffraction, screening, vegetation};

/// Compute terrain diffraction attenuation per band.
///
/// Uses 5-point LOS fast-path check. If no obstruction detected, returns zero.
/// Only computed for distances < 2000m (beyond that, terrain effect is negligible
/// relative to geometric divergence).
pub fn terrain_attenuation(
    rasters: &dyn RasterSampler,
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
) -> [f64; NUM_BANDS] {
    if dist_m > 2000.0 { return [0.0; NUM_BANDS]; }

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
    let rcv_agl = 1.5; // receiver height above ground
    let diff = diffraction::compute_path_difference(&profile, dist_m, src_agl, rcv_agl);
    diffraction::diffraction_attenuation(diff.delta, diff.is_double)
}

/// Compute building screening attenuation per band.
///
/// Samples building height at path midpoint. If a building (or noise barrier)
/// protrudes above the line-of-sight, computes screening attenuation.
///
/// Also checks explicit noise barriers from the barriers vector.
pub fn screening_attenuation(
    rasters: &dyn RasterSampler,
    barriers: &[Barrier],
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    src_elev: f64, rcv_alt: f64,
    dist_m: f64,
) -> [f64; NUM_BANDS] {
    // Find tallest obstruction along path
    let mid_lat = (src_lat + rcv_lat) * 0.5;
    let mid_lon = (src_lon + rcv_lon) * 0.5;
    let mut max_bh = rasters.building_height(mid_lat, mid_lon);
    let mut max_bh_t = 0.5;

    // Check noise barriers
    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let path_len_sq = (dlat * dlat + dlon * dlon).max(1e-12);
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 { continue; }
        let t = ((barrier.lat - src_lat) * dlat + (barrier.lon - src_lon) * dlon) / path_len_sq;
        if t < 0.05 || t > 0.95 { continue; }
        let closest_lat = src_lat + t * dlat;
        let closest_lon = src_lon + t * dlon;
        let perp_dist = super::geo::flat_dist(barrier.lat, barrier.lon, closest_lat, closest_lon);
        if perp_dist < 50.0 && barrier.height_m as f64 > max_bh {
            max_bh = barrier.height_m as f64;
            max_bh_t = t;
        }
    }

    if max_bh <= 0.0 { return [0.0; NUM_BANDS]; }

    let bld_ground = rasters.elevation(
        src_lat + max_bh_t * dlat,
        src_lon + max_bh_t * dlon,
    );
    let bld_top = bld_ground + max_bh;
    let los_height = src_elev + (rcv_alt - src_elev) * max_bh_t;
    let screen_delta = bld_top - los_height;

    if screen_delta > 0.0 {
        screening::building_screening(screen_delta)
    } else {
        [0.0; NUM_BANDS]
    }
}

/// Compute vegetation attenuation per band.
///
/// Only computed for distances < 500m (vegetation effect is minor beyond that).
pub fn vegetation_attenuation_path(
    rasters: &dyn RasterSampler,
    src_lat: f64, src_lon: f64,
    rcv_lat: f64, rcv_lon: f64,
    dist_m: f64,
) -> [f64; NUM_BANDS] {
    if dist_m > 500.0 { return [0.0; NUM_BANDS]; }

    let forest_depth = rasters.vegetation_depth(src_lat, src_lon, rcv_lat, rcv_lon);
    vegetation::vegetation_attenuation(forest_depth)
}
