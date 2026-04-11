//! Geometric utilities for noise propagation.

/// Flat-earth distance in meters (accurate <0.3% at <50km).
pub fn flat_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let mid_lat = ((lat1 + lat2) / 2.0).to_radians();
    let cos_lat = mid_lat.cos();
    let dx = (lon2 - lon1) * 111_320.0 * cos_lat;
    let dy = (lat2 - lat1) * 110_540.0;
    (dx * dx + dy * dy).sqrt()
}

/// 3D slant distance: horizontal distance + height difference.
/// Used for geometric divergence and atmospheric absorption.
pub fn slant_dist(d_horizontal: f64, source_alt: f64, receiver_alt: f64) -> f64 {
    let dz = source_alt - receiver_alt;
    (d_horizontal * d_horizontal + dz * dz).sqrt()
}

/// Horizontal distance from a point to a line segment.
/// Returns (distance_m, closest_point_lat, closest_point_lon, fraction 0-1).
pub fn point_to_segment(
    p_lat: f64, p_lon: f64,
    a_lat: f64, a_lon: f64,
    b_lat: f64, b_lon: f64,
) -> (f64, f64, f64, f64) {
    let mid_lat = ((a_lat + b_lat) / 2.0).to_radians();
    let cos_lat = mid_lat.cos();

    // Project to local meters (A at origin)
    let bx = (b_lon - a_lon) * 111_320.0 * cos_lat;
    let by = (b_lat - a_lat) * 110_540.0;
    let px = (p_lon - a_lon) * 111_320.0 * cos_lat;
    let py = (p_lat - a_lat) * 110_540.0;

    let ab_len_sq = bx * bx + by * by;
    let t = if ab_len_sq < 1e-10 {
        0.0
    } else {
        ((px * bx + py * by) / ab_len_sq).clamp(0.0, 1.0)
    };

    let cp_x = t * bx;
    let cp_y = t * by;
    let dx = px - cp_x;
    let dy = py - cp_y;
    let dist = (dx * dx + dy * dy).sqrt();

    let cp_lat = a_lat + t * (b_lat - a_lat);
    let cp_lon = a_lon + t * (b_lon - a_lon);

    (dist, cp_lat, cp_lon, t)
}

/// Smooth fade-out factor for the last 20% of a source's max range.
/// Prevents hard-edge artifacts on the map at cutoff boundaries.
/// Returns 1.0 within 80% of range, linearly fades to 0.0 at max_range.
#[inline]
pub fn fade_factor(dist_m: f64, max_range_m: f64) -> f64 {
    let fade_start = max_range_m * 0.8;
    if dist_m <= fade_start {
        1.0
    } else {
        1.0 - (dist_m - fade_start) / (max_range_m - fade_start)
    }
}

/// Check if a source is too weak to contribute at this distance.
/// Geometric divergence alone attenuates by ~20*log10(d) + 11 dB;
/// path effects only attenuate further. Returns true if max emission
/// minus geometric divergence is already below threshold.
#[inline]
pub fn below_free_field_threshold(max_emission_db: f64, dist_m: f64, threshold_db: f64) -> bool {
    let geo_approx = 20.0 * dist_m.log10() + 11.0;
    max_emission_db - geo_approx < threshold_db
}

/// Finite-line correction using HORIZONTAL distance and end angles.
///
/// ISO 9613-2: correction for finite line source vs infinite.
/// Uses HORIZONTAL distances (not 3D slant — fix from V33/V44).
///
/// Returns correction in dB (always ≤ 0).
pub fn finite_line_correction(
    seg_length_m: f64,
    d_perp_horizontal: f64,
    fraction: f64,  // 0-1 position of closest point along segment
) -> f64 {
    if seg_length_m < 0.1 || d_perp_horizontal < 0.1 {
        return 0.0;
    }

    // Distances from closest point to segment endpoints (along segment)
    let d1 = fraction * seg_length_m;
    let d2 = (1.0 - fraction) * seg_length_m;
    let inv_d = 1.0 / d_perp_horizontal;
    let a1 = d1 * inv_d;
    let a2 = d2 * inv_d;

    // Angle subtended by segment as seen from receiver.
    // Use atan addition formula: atan(a1) + atan(a2) = atan((a1+a2)/(1-a1*a2)) + k*π
    // For positive a1,a2: if a1*a2 < 1, k=0; if a1*a2 >= 1, k=1 (theta > π/2).
    let prod = a1 * a2;
    let theta = if prod < 0.98 {
        // Single atan instead of two
        ((a1 + a2) / (1.0 - prod)).atan()
    } else {
        // a1*a2 >= 1: denominator near zero or negative, use two atans (rare case)
        a1.atan() + a2.atan()
    };

    // Correction: ratio of subtended angle to π (full infinite line)
    // Use ln for speed: 10*log10(x) = (10/ln10)*ln(x)
    let correction = 4.342944819032518_f64 * (theta / std::f64::consts::PI).ln();

    correction.min(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flat_dist() {
        let d = flat_dist(50.08, 14.42, 50.08, 14.434);
        assert!((d - 1000.0).abs() < 50.0, "d={d}");
    }

    #[test]
    fn test_slant_dist() {
        let s = slant_dist(100.0, 10.0, 1.5);
        // √(100² + 8.5²) ≈ 100.36
        assert!((s - 100.36).abs() < 0.1, "s={s}");
    }

    #[test]
    fn test_finite_line_midpoint() {
        // Receiver perpendicular to midpoint of 200m segment, 100m away
        let flc = finite_line_correction(200.0, 100.0, 0.5);
        // θ = 2 × atan(100/100) = 2 × π/4 = π/2
        // FLC = 10 × log₁₀(0.5/π) ≈ 10 × log₁₀(0.5) ≈ -3.0 dB
        assert!((flc - (-3.01)).abs() < 0.1, "flc={flc}");
    }

    #[test]
    fn test_finite_line_near_endpoint() {
        // Receiver near one endpoint — more correction
        let flc = finite_line_correction(200.0, 100.0, 0.05);
        // θ ≈ atan(10/100) + atan(190/100) ≈ 0.1 + 1.08 ≈ 1.18
        // FLC ≈ 10 × log₁₀(1.18/π) ≈ -4.3 dB
        assert!(flc < -3.5 && flc > -5.0, "flc={flc}");
    }
}
