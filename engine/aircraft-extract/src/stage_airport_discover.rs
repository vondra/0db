//! DBSCAN auto-discovery of OSM-missing airport strips.
//!
//! Input: ground vertices from Stage 1 ADS-B traces that did NOT snap
//! to any OSM aeroway microsegment within 50 m perpendicular distance.
//! Output: synthetic airport_lines.arrow rows + a per-cluster
//! `airport_key = "auto-<r4_hex>-<seq>"` consumed identically to
//! OSM-derived rows by the popup.
//!
//! Algorithm:
//!
//! 1. Per R4 disk: DBSCAN(eps=200 m, min_samples=30) on miss-snap
//!    vertices.
//! 2. PCA over each cluster: if primary axis variance ratio > 5,
//!    emit a synthetic runway line (axis ± half-width); otherwise
//!    treat as apron-equivalent (single representative point).
//! 3. Width = perpendicular spread clamped to 10-60 m.
//!
//! Algorithmic core only — pipeline wiring lives in
//! `stage_airport_discover_runner.rs`. Kept standalone so DBSCAN + PCA
//! can be unit-tested without a real ADS-B cache.

use std::collections::HashMap;

use crate::geo::{M_PER_DEG_LAT, M_PER_DEG_LON_EQUATOR, flat_dist};

#[derive(Clone, Copy, Debug)]
#[cfg_attr(test, derive(PartialEq))]
pub struct DiscoveredStrip {
    /// Center of the cluster.
    pub center_lat: f32,
    pub center_lon: f32,
    /// Length of the primary axis (runway-like) in metres.
    pub length_m: f32,
    /// Bearing of the primary axis in degrees [0, 360).
    pub heading_deg: f32,
    /// Perpendicular spread clamped to [10, 60] m.
    pub width_m: f32,
    /// Number of vertices in this cluster — population sanity check.
    pub vertex_count: u32,
    /// `true` when PCA's primary/secondary variance ratio > 5 (a
    /// proper line). `false` falls back to "apron" semantics: emit a
    /// representative point rather than a line.
    pub is_line: bool,
}

/// DBSCAN-cluster a flat list of ground vertices and emit one
/// `DiscoveredStrip` per surviving cluster. The acceptance gates
/// (within-500m-of-aerodrome filter, min-day-spread checks) belong
/// upstream — this kernel just returns geometric candidates.
pub fn discover_strips(
    vertices: &[(f32, f32)],
    eps_m: f32,
    min_samples: usize,
) -> Vec<DiscoveredStrip> {
    let (labels, n_clusters) = dbscan_2d(vertices, eps_m, min_samples);
    let mut out = Vec::new();
    for cid in 0..n_clusters {
        let members: Vec<(f32, f32)> = vertices
            .iter()
            .zip(labels.iter())
            .filter_map(|(v, l)| if *l == Some(cid) { Some(*v) } else { None })
            .collect();
        if members.len() < min_samples {
            continue;
        }
        out.push(fit_strip(&members));
    }
    out
}

/// DBSCAN 2D over (lat, lon) points with metric eps in metres.
/// Returns `(labels, n_clusters)`: one `Option<usize>` per input vertex
/// — `Some(cluster_id)` for cluster members, `None` for noise (label =
/// -1 in classic DBSCAN). Grid-indexed region queries reduce neighbor
/// lookup from O(n) to O(local-density), making whole-DBSCAN O(n)
/// instead of O(n²) on uniformly-spaced inputs. Without the grid,
/// dense R4 cells like LKPR (10⁵ ground vertices) took ~30 min on a
/// single thread; with it, the same cell completes in seconds.
fn dbscan_2d(
    vertices: &[(f32, f32)],
    eps_m: f32,
    min_samples: usize,
) -> (Vec<Option<usize>>, usize) {
    let n = vertices.len();
    let grid = SpatialGrid::build(vertices, eps_m);
    let mut labels: Vec<Option<usize>> = vec![None; n];
    let mut visited = vec![false; n];
    let mut in_queue = vec![false; n];
    let mut cluster_id: usize = 0;
    for i in 0..n {
        if visited[i] {
            continue;
        }
        visited[i] = true;
        let neighbors = grid.region_query(vertices, i, eps_m);
        if neighbors.len() < min_samples {
            // Noise (may be reassigned to a cluster as a border point
            // when reached via another core's expansion).
            continue;
        }
        labels[i] = Some(cluster_id);
        // Iteratively expand the cluster across reachable neighbors.
        let mut queue = neighbors;
        for &k in &queue {
            in_queue[k] = true;
        }
        let mut head = 0;
        while head < queue.len() {
            let j = queue[head];
            head += 1;
            if !visited[j] {
                visited[j] = true;
                let inner = grid.region_query(vertices, j, eps_m);
                if inner.len() >= min_samples {
                    for k in inner {
                        if !in_queue[k] {
                            in_queue[k] = true;
                            queue.push(k);
                        }
                    }
                }
            }
            if labels[j].is_none() {
                labels[j] = Some(cluster_id);
            }
        }
        // Reset in_queue for the next cluster's expansion.
        for &k in &queue {
            in_queue[k] = false;
        }
        cluster_id += 1;
    }
    (labels, cluster_id)
}

/// Grid index for DBSCAN neighbor queries. Cell size = eps so each
/// neighbor lookup touches at most the 3×3 neighborhood (own cell +
/// 8 adjacent). Coordinates are converted to local meters around the
/// bbox-min anchor so cells are uniform regardless of latitude.
struct SpatialGrid {
    /// (x_m, y_m) per vertex in the local meter frame.
    coords_m: Vec<(f32, f32)>,
    /// `cell -> indices` lookup. HashMap keeps memory bounded on
    /// sparse inputs (rural strips) vs a dense Vec<Vec<usize>>.
    cells: HashMap<(i32, i32), Vec<usize>>,
    eps_m: f32,
}

impl SpatialGrid {
    fn build(vertices: &[(f32, f32)], eps_m: f32) -> Self {
        // Convert all vertices to local meters around a single anchor
        // so cell coordinates compose cleanly. cos(lat) is taken at the
        // mean latitude — accurate to <0.1 % across an R4 cell (~25 km).
        let n = vertices.len();
        if n == 0 {
            return Self {
                coords_m: Vec::new(),
                cells: HashMap::new(),
                eps_m,
            };
        }
        let mean_lat: f64 = vertices.iter().map(|v| v.0 as f64).sum::<f64>() / n as f64;
        let cos_lat = mean_lat.to_radians().cos() as f32;
        let m_per_deg_lon = M_PER_DEG_LON_EQUATOR * cos_lat;
        let mut coords_m: Vec<(f32, f32)> = Vec::with_capacity(n);
        let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
        for &(lat, lon) in vertices {
            let x = lon * m_per_deg_lon;
            let y = lat * M_PER_DEG_LAT;
            coords_m.push((x, y));
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
        }
        // Re-anchor so all coords are non-negative and the cell index
        // tuple stays in a tight (i32, i32) range.
        for c in coords_m.iter_mut() {
            c.0 -= min_x;
            c.1 -= min_y;
        }
        let inv_eps = 1.0 / eps_m;
        let mut cells: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (i, &(x, y)) in coords_m.iter().enumerate() {
            let key = ((x * inv_eps) as i32, (y * inv_eps) as i32);
            cells.entry(key).or_default().push(i);
        }
        Self {
            coords_m,
            cells,
            eps_m,
        }
    }

    fn region_query(&self, vertices: &[(f32, f32)], i: usize, eps_m: f32) -> Vec<usize> {
        // Walk the 3×3 neighborhood of the query cell. Distance check
        // still uses `flat_dist` over the original lat/lon for parity
        // with the rest of the codebase; the grid only prunes the
        // candidate set.
        let (xi, yi) = self.coords_m[i];
        let inv_eps = 1.0 / self.eps_m;
        let cx = (xi * inv_eps) as i32;
        let cy = (yi * inv_eps) as i32;
        let (lat_i, lon_i) = vertices[i];
        let mut out = Vec::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(idxs) = self.cells.get(&(cx + dx, cy + dy)) {
                    for &j in idxs {
                        let (lat_j, lon_j) = vertices[j];
                        if flat_dist(lat_i, lon_i, lat_j, lon_j) <= eps_m {
                            out.push(j);
                        }
                    }
                }
            }
        }
        out
    }
}

/// PCA over a cluster: returns a `DiscoveredStrip` summarizing the
/// primary axis (runway-like), centroid, spread, and bearing.
fn fit_strip(members: &[(f32, f32)]) -> DiscoveredStrip {
    let n = members.len() as f32;
    let mean_lat = members.iter().map(|v| v.0).sum::<f32>() / n;
    let mean_lon = members.iter().map(|v| v.1).sum::<f32>() / n;

    // Convert each (lat, lon) into local meters around the centroid
    // for stable PCA. cos(mid_lat) scaling matters at any latitude
    // off the equator.
    let cos_lat = (mean_lat as f64).to_radians().cos() as f32;
    let m_per_deg_lon = M_PER_DEG_LON_EQUATOR * cos_lat;

    let pts_m: Vec<(f32, f32)> = members
        .iter()
        .map(|&(lat, lon)| ((lon - mean_lon) * m_per_deg_lon, (lat - mean_lat) * M_PER_DEG_LAT))
        .collect();
    // Covariance matrix in (x=east, y=north) meters.
    let mut sxx = 0.0f32;
    let mut sxy = 0.0f32;
    let mut syy = 0.0f32;
    for &(x, y) in &pts_m {
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
    }
    sxx /= n;
    sxy /= n;
    syy /= n;
    // Eigen-decomposition of the 2x2 symmetric matrix [[sxx, sxy], [sxy, syy]].
    let tr = sxx + syy;
    let det = sxx * syy - sxy * sxy;
    let disc = ((tr * tr * 0.25) - det).max(0.0).sqrt();
    let l1 = tr * 0.5 + disc;
    let l2 = tr * 0.5 - disc;
    // Primary axis direction (eigenvector of l1).
    let (vx, vy) = if sxy.abs() > 1e-6 {
        let nx = l1 - syy;
        let ny = sxy;
        let mag = (nx * nx + ny * ny).sqrt().max(1e-9);
        (nx / mag, ny / mag)
    } else if sxx >= syy {
        (1.0, 0.0)
    } else {
        (0.0, 1.0)
    };
    // Project points onto primary axis to get length spread.
    let mut min_proj = f32::INFINITY;
    let mut max_proj = f32::NEG_INFINITY;
    let mut perp_max = 0.0f32;
    for &(x, y) in &pts_m {
        let proj = x * vx + y * vy;
        let perp = (x * (-vy) + y * vx).abs();
        min_proj = min_proj.min(proj);
        max_proj = max_proj.max(proj);
        perp_max = perp_max.max(perp);
    }
    // max_proj >= min_proj by construction (same loop, ≥1 member from
    // caller's min_samples gate). perp_max is the max |signed perp|
    // → full width is 2× that, clamped to the runway band.
    let length_m = max_proj - min_proj;
    let width_m = (perp_max * 2.0).clamp(10.0, 60.0);

    // Bearing of primary axis (east, north) → compass degrees.
    let heading_deg = {
        let mut deg = vx.atan2(vy).to_degrees();
        if deg < 0.0 {
            deg += 360.0;
        }
        deg
    };

    let is_line = if l2 > 1e-3 { l1 / l2 > 5.0 } else { length_m > 50.0 };

    DiscoveredStrip {
        center_lat: mean_lat,
        center_lon: mean_lon,
        length_m,
        heading_deg,
        width_m,
        vertex_count: members.len() as u32,
        is_line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convert local (east_m, north_m) offsets at 50°N anchor into a
    /// lat/lon pair, sharing the same constants as production code.
    fn local_at_50n(east_m: f32, north_m: f32) -> (f32, f32) {
        let dlon = east_m / (M_PER_DEG_LON_EQUATOR * (50.0f32.to_radians()).cos());
        let dlat = north_m / M_PER_DEG_LAT;
        (50.0 + dlat, 14.0 + dlon)
    }

    /// Synthetic east-west runway: 1000 m line at 50°N, 60 points
    /// strung along it with 5 m perp jitter.
    fn synthetic_runway() -> Vec<(f32, f32)> {
        (0..60)
            .map(|i| {
                let along = i as f32 * 1000.0 / 60.0 - 500.0; // -500..+500 m
                let perp = ((i * 13) % 11) as f32 - 5.0; // -5..+5 m jitter
                local_at_50n(along, perp)
            })
            .collect()
    }

    /// Synthetic blob: 60 points scattered in a ~100 × 100 m square
    /// using coprime-of-100 strides so successive points don't land on
    /// the same row/column — should not look like a runway.
    fn synthetic_blob() -> Vec<(f32, f32)> {
        (0..60)
            .map(|i| {
                let dx = ((i * 7) % 100) as f32 - 50.0;
                let dy = ((i * 13) % 100) as f32 - 50.0;
                local_at_50n(dx, dy)
            })
            .collect()
    }

    #[test]
    fn discovers_runway_as_line() {
        let pts = synthetic_runway();
        let out = discover_strips(&pts, 50.0, 5);
        assert_eq!(out.len(), 1, "expected one cluster from runway pts");
        let strip = out[0];
        assert!(strip.is_line, "elongated cluster should classify as line");
        assert!(
            (strip.length_m - 1000.0).abs() < 50.0,
            "runway length ~1000m, got {}",
            strip.length_m
        );
        // East-west runway: bearing 90° (east) or 270° (west); PCA
        // doesn't disambiguate direction → accept either.
        let h = strip.heading_deg;
        assert!(
            (h - 90.0).abs() < 5.0 || (h - 270.0).abs() < 5.0,
            "expected E-W bearing, got {h}"
        );
    }

    #[test]
    fn isotropic_blob_classifies_as_non_line() {
        let pts = synthetic_blob();
        let out = discover_strips(&pts, 30.0, 5);
        assert!(!out.is_empty());
        let strip = out[0];
        assert!(
            !strip.is_line,
            "isotropic blob should not classify as line; ratio fired anyway"
        );
    }

    #[test]
    fn empty_input_no_clusters() {
        let out = discover_strips(&[], 50.0, 5);
        assert!(out.is_empty());
    }

    #[test]
    fn below_min_samples_no_clusters() {
        let pts = vec![(50.0, 14.0); 3];
        let out = discover_strips(&pts, 50.0, 30);
        assert!(out.is_empty(), "3 points cannot form a min=30 cluster");
    }

    #[test]
    fn two_distant_clusters_distinguished() {
        let mut pts = synthetic_runway();
        // Second runway 10 km north.
        let dlat_10km = 10_000.0 / 110_540.0;
        for &(la, lo) in &synthetic_runway() {
            pts.push((la + dlat_10km, lo));
        }
        let out = discover_strips(&pts, 50.0, 5);
        assert_eq!(out.len(), 2, "two clusters separated by 10 km");
    }

    #[test]
    fn width_clamped_to_band() {
        // 60 points with 80 m perp spread → should clamp to upper 60 m.
        let pts: Vec<_> = (0..60)
            .map(|i| {
                let along = i as f32 * 1000.0 / 60.0 - 500.0;
                let perp = if i % 2 == 0 { 40.0 } else { -40.0 };
                local_at_50n(along, perp)
            })
            .collect();
        let out = discover_strips(&pts, 100.0, 5);
        assert!(!out.is_empty());
        assert_eq!(out[0].width_m, 60.0, "perp 80m should clamp to 60");
    }

    #[test]
    fn width_clamped_to_floor() {
        // 60 points strung along a 1000 m line with ~1 m perp jitter
        // → raw width ~2 m should clamp UP to the 10 m floor.
        let pts: Vec<_> = (0..60)
            .map(|i| {
                let along = i as f32 * 1000.0 / 60.0 - 500.0;
                let perp = if i % 2 == 0 { 1.0 } else { -1.0 };
                local_at_50n(along, perp)
            })
            .collect();
        let out = discover_strips(&pts, 50.0, 5);
        assert!(!out.is_empty());
        assert_eq!(out[0].width_m, 10.0, "tight 2m spread should clamp up to 10");
    }
}
