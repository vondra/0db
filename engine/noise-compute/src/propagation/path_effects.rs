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
    if dist_m > 5000.0 { return [0.0; NUM_BANDS]; }

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
    // Sample building height along entire path every ~30m.
    // Find tallest building on the line source→receiver.
    // Sample building height along path to find tallest obstruction.
    // For short paths (<450m): every ~30m (up to 15 samples).
    // For long paths (>450m): concentrate 15 samples near source (7) and receiver (8),
    // because screening is only effective close to source or receiver (Fresnel zone).
    // WHY: Spreading 15 samples evenly over 3km = 200m steps → misses 10-30m wide buildings.
    let n_samples = (dist_m / 30.0).ceil() as usize;
    let mut max_bh = 0.0f64;
    let mut max_bh_t = 0.5;

    let excl_limit = if exclusion_radius_m > 0.0 { exclusion_radius_m.min(dist_m * 0.5) } else { 0.0 };

    let mut check_point = |t: f64| {
        if excl_limit > 0.0 && t * dist_m < excl_limit { return; }
        let lat = src_lat + t * (rcv_lat - src_lat);
        let lon = src_lon + t * (rcv_lon - src_lon);
        let bh = rasters.building_height(lat, lon);
        if bh > max_bh {
            max_bh = bh;
            max_bh_t = t;
        }
    };

    // Sample every ~50m along the full path (not just near endpoints).
    // clamp(2, 200): at least midpoint even for short paths, cap for very long ones.
    let n = ((dist_m / 50.0).ceil() as usize).clamp(2, 200);
    for k in 1..n {
        check_point(k as f64 / n as f64);
    }

    // Check noise barriers
    let dlat = rcv_lat - src_lat;
    let dlon = rcv_lon - src_lon;
    let path_len_sq = (dlat * dlat + dlon * dlon).max(1e-12);
    for barrier in barriers {
        if barrier.dist_m > dist_m + 100.0 { continue; }
        let t = ((barrier.lat - src_lat) * dlat + (barrier.lon - src_lon) * dlon) / path_len_sq;
        if t < 0.01 || t > 0.99 { continue; }
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
    let screen_h = bld_top - los_height; // vertical height above line-of-sight

    if screen_h > 0.0 {
        // Convert vertical height above LOS to path length difference (δ).
        // WHY: Old code passed screen_h directly as δ to the Maekawa formula.
        // screen_h is the VERTICAL height; δ is the DETOUR distance.
        // For h=2m at 100m from source on 300m path: δ=0.03m, not 2m.
        // Passing h instead of δ overestimated screening by ~67× → instant 10 dB cap.
        let d1 = max_bh_t * dist_m;         // source → building (horizontal)
        let d2 = (1.0 - max_bh_t) * dist_m; // building → receiver (horizontal)
        let delta = ((d1 * d1 + screen_h * screen_h).sqrt()
                   + (d2 * d2 + screen_h * screen_h).sqrt()
                   - dist_m).max(0.0);
        screening::building_screening(delta)
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
