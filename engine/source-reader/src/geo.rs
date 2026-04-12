//! Geometry utilities: re-exports from noise-compute + H3 grid disk.

use h3o::{CellIndex, LatLng, Resolution};

// Re-export shared geometry from noise-compute (single source of truth).
pub use noise_compute::propagation::geo::{closest_point_on_segment, flat_dist};

/// Get H3 res-4 hex IDs for a point + ring-1 neighbors (7 hexes).
pub fn grid_disk_r4(lat: f64, lon: f64) -> Vec<String> {
    let Ok(ll) = LatLng::new(lat, lon) else {
        return vec![];
    };
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
        let cp = closest_point_on_segment(50.08, 14.42, 50.079, 14.41, 50.079, 14.43);
        assert!(cp.dist_m > 50.0 && cp.dist_m < 200.0, "dist={}", cp.dist_m);
        assert!((cp.fraction - 0.5).abs() < 0.1, "frac={}", cp.fraction);
    }

    #[test]
    fn test_grid_disk() {
        let hexes = grid_disk_r4(50.08, 14.42);
        assert_eq!(hexes.len(), 7, "expected 7 hexes, got {}", hexes.len());
    }
}
