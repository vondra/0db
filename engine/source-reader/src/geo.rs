//! Geometry utilities: distance, closest point, H3 grid disk.

use h3o::{CellIndex, LatLng, Resolution};

/// Flat-earth distance in meters (accurate <0.3% at <50km).
pub fn flat_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let mid_lat = ((lat1 + lat2) / 2.0).to_radians();
    let cos_lat = mid_lat.cos();
    let dx = (lon2 - lon1) * 111_320.0 * cos_lat;
    let dy = (lat2 - lat1) * 110_540.0;
    (dx * dx + dy * dy).sqrt()
}

/// Result of closest-point-on-segment computation.
pub struct ClosestPoint {
    pub lat: f64,
    pub lon: f64,
    pub dist_m: f64,
    pub fraction: f64, // 0.0 = at start, 1.0 = at end
}

/// Find closest point on a line segment to a given point.
/// Uses flat-earth projection (accurate for <50km distances).
pub fn closest_point_on_segment(
    p_lat: f64, p_lon: f64,
    a_lat: f64, a_lon: f64,
    b_lat: f64, b_lon: f64,
) -> ClosestPoint {
    let mid_lat = ((a_lat + b_lat) / 2.0).to_radians();
    let cos_lat = mid_lat.cos();

    let bx = (b_lon - a_lon) * 111_320.0 * cos_lat;
    let by = (b_lat - a_lat) * 110_540.0;
    let px = (p_lon - a_lon) * 111_320.0 * cos_lat;
    let py = (p_lat - a_lat) * 110_540.0;

    let ab_len_sq = bx * bx + by * by;
    let t = if ab_len_sq < 1e-10 {
        0.0
    } else {
        (px * bx + py * by) / ab_len_sq
    };
    let t = t.clamp(0.0, 1.0);

    let cp_x = t * bx;
    let cp_y = t * by;
    let dx = px - cp_x;
    let dy = py - cp_y;
    let dist_m = (dx * dx + dy * dy).sqrt();

    let cp_lon = a_lon + t * (b_lon - a_lon);
    let cp_lat = a_lat + t * (b_lat - a_lat);

    ClosestPoint { lat: cp_lat, lon: cp_lon, dist_m, fraction: t }
}

/// Get H3 res-4 hex IDs for a point + ring-1 neighbors (7 hexes).
pub fn grid_disk_r4(lat: f64, lon: f64) -> Vec<String> {
    let Ok(ll) = LatLng::new(lat, lon) else { return vec![] };
    let cell = ll.to_cell(Resolution::Four);

    let mut result = Vec::with_capacity(7);
    result.push(format!("{cell}"));

    let disk: Vec<CellIndex> = cell.grid_disk::<Vec<_>>(1);
    for c in disk {
        let s = format!("{c}");
        if !result.contains(&s) {
            result.push(s);
        }
    }

    result
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
    fn test_closest_point() {
        let cp = closest_point_on_segment(
            50.08, 14.42,
            50.079, 14.41,
            50.079, 14.43,
        );
        assert!(cp.dist_m > 50.0 && cp.dist_m < 200.0, "dist={}", cp.dist_m);
        assert!((cp.fraction - 0.5).abs() < 0.1, "frac={}", cp.fraction);
    }

    #[test]
    fn test_grid_disk() {
        let hexes = grid_disk_r4(50.08, 14.42);
        assert_eq!(hexes.len(), 7, "expected 7 hexes, got {}", hexes.len());
    }
}
