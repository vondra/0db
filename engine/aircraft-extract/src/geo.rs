//! Geometry helpers — antimeridian-safe `flat_dist`, `bearing`,
//! `midpoint`, h3 helpers, and an analytical line-cell clip used by
//! Stage 2B to compute the cruise transit length per R7 hex without
//! relying on the unreliable `h3o::grid_path` (which mis-handles
//! pentagons and does not follow great arcs).
//!
//! Distances are in metres on a local equirectangular plane; accuracy
//! is sub-percent at segment scale (≤ 10 km) inside one R4 hex and ≤ 1 %
//! at 100 km. f32 precision is sufficient — popup latitude grid is 30 m
//! (DEM) and the receiver is matched at ~few-metre resolution.

use h3o::{CellIndex, LatLng, Resolution};

pub(crate) const M_PER_DEG_LAT: f32 = 110_540.0;
pub(crate) const M_PER_DEG_LON_EQUATOR: f32 = 111_320.0;

/// Smallest signed longitude difference (`lon2 - lon1`) wrapped into
/// the range `(-180, 180]`. Critical for transpacific cruise where the
/// raw subtraction would yield ±300° instead of ±60°.
pub fn signed_lon_diff(lon1: f32, lon2: f32) -> f32 {
    let mut d = lon2 - lon1;
    if d > 180.0 {
        d -= 360.0;
    } else if d <= -180.0 {
        d += 360.0;
    }
    d
}

/// Equirectangular distance in metres between two `(lat, lon)` points.
/// Antimeridian-safe via [`signed_lon_diff`].
pub fn flat_dist(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
    let mid_lat_rad = ((lat1 + lat2) as f64 * 0.5).to_radians();
    let cos_lat = mid_lat_rad.cos() as f32;
    let dx = signed_lon_diff(lon1, lon2) * M_PER_DEG_LON_EQUATOR * cos_lat;
    let dy = (lat2 - lat1) * M_PER_DEG_LAT;
    (dx * dx + dy * dy).sqrt()
}

/// Initial bearing from `p1` to `p2` in degrees [0, 360).
pub fn bearing_deg(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
    let mid_lat_rad = ((lat1 + lat2) as f64 * 0.5).to_radians();
    let cos_lat = mid_lat_rad.cos() as f32;
    let dx = signed_lon_diff(lon1, lon2) * cos_lat;
    let dy = lat2 - lat1;
    let mut deg = dx.atan2(dy).to_degrees();
    if deg < 0.0 {
        deg += 360.0;
    }
    deg
}

/// Smallest unsigned compass-heading difference in degrees [0, 180].
pub fn heading_diff(a: f32, b: f32) -> f32 {
    let d = (b - a).abs();
    if d > 180.0 { 360.0 - d } else { d }
}

/// Antimeridian-safe midpoint. Output longitude wrapped to `(-180, 180]`.
pub fn midpoint(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> (f32, f32) {
    interp_along_path(lat1, lon1, lat2, lon2, 0.5)
}

/// Antimeridian-safe linear interpolation along the path
/// `(lat1, lon1) → (lat2, lon2)` at fraction `frac` ∈ [0, 1].
/// Output longitude wrapped to `(-180, 180]`. Latitude is plain
/// linear (latitude can't wrap). Used by Stage 2A to sample DEM
/// elevation at q1 / mid / q3 along an airborne sub-segment.
pub fn interp_along_path(lat1: f32, lon1: f32, lat2: f32, lon2: f32, frac: f32) -> (f32, f32) {
    let lat = lat1 + (lat2 - lat1) * frac;
    let mut lon = lon1 + signed_lon_diff(lon1, lon2) * frac;
    if lon > 180.0 {
        lon -= 360.0;
    } else if lon <= -180.0 {
        lon += 360.0;
    }
    (lat, lon)
}

/// Convert a `(lat, lon)` to an H3 cell at `res`. Returns `None` when
/// the coordinate is outside the legal range.
pub fn lat_lon_to_cell(lat: f64, lon: f64, res: Resolution) -> Option<CellIndex> {
    LatLng::new(lat, lon).ok().map(|ll| ll.to_cell(res))
}

/// Centroid of an H3 cell in `(lat, lon)` degrees.
pub fn cell_centroid(cell: CellIndex) -> (f64, f64) {
    let ll = LatLng::from(cell);
    (ll.lat(), ll.lng())
}

/// 15-char zero-padded lowercase hex string used as the `<R4>` directory
/// name under `data/prepared/<year>/h3r4/`. Every H3 cell at any
/// resolution serialises to 15 hex chars; keeping the format identical
/// across stages keeps `r4_dir.join(r4_hex_str(r4))` round-trip safe.
pub fn r4_hex_str(r4: u64) -> String {
    format!("{r4:015x}")
}

/// Convert one geographic point to a local flat plane anchored at
/// `(anchor_lat, anchor_lon)`. Output is metres east / north.
fn to_local_xy(anchor_lat: f32, anchor_lon: f32, cos_lat: f32, lat: f32, lon: f32) -> (f32, f32) {
    let dx = signed_lon_diff(anchor_lon, lon) * M_PER_DEG_LON_EQUATOR * cos_lat;
    let dy = (lat - anchor_lat) * M_PER_DEG_LAT;
    (dx, dy)
}

/// Length in metres of the intersection between a great-circle line
/// segment (here approximated as a straight line in the local flat
/// plane — accurate enough at H3 resolution-8 scale, edge ≈ 461 m) and
/// the polygonal boundary of an H3 cell.
///
/// Returns `0.0` when the segment lies entirely outside the cell.
/// Convex-polygon parametric clip — robust at antimeridian via
/// [`signed_lon_diff`].
pub fn line_cell_clip_length(
    seg_lat0: f32,
    seg_lon0: f32,
    seg_lat1: f32,
    seg_lon1: f32,
    cell: CellIndex,
) -> f32 {
    let total_len = flat_dist(seg_lat0, seg_lon0, seg_lat1, seg_lon1);
    if total_len < 1e-3 {
        let pt = match LatLng::new(seg_lat0 as f64, seg_lon0 as f64) {
            Ok(p) => p,
            Err(_) => return 0.0,
        };
        return if pt.to_cell(cell.resolution()) == cell {
            total_len
        } else {
            0.0
        };
    }

    let anchor_lat = (seg_lat0 + seg_lat1) * 0.5;
    let anchor_lon = seg_lon0 + signed_lon_diff(seg_lon0, seg_lon1) * 0.5;
    let cos_lat = (anchor_lat as f64).to_radians().cos() as f32;

    let p0 = to_local_xy(anchor_lat, anchor_lon, cos_lat, seg_lat0, seg_lon0);
    let p1 = to_local_xy(anchor_lat, anchor_lon, cos_lat, seg_lat1, seg_lon1);
    let dir = (p1.0 - p0.0, p1.1 - p0.1);

    let boundary: Vec<(f32, f32)> = cell
        .boundary()
        .iter()
        .map(|ll| to_local_xy(anchor_lat, anchor_lon, cos_lat, ll.lat() as f32, ll.lng() as f32))
        .collect();
    if boundary.len() < 3 {
        return 0.0;
    }

    let centroid_ll = LatLng::from(cell);
    let centroid = to_local_xy(
        anchor_lat,
        anchor_lon,
        cos_lat,
        centroid_ll.lat() as f32,
        centroid_ll.lng() as f32,
    );

    let mut t_min: f32 = 0.0;
    let mut t_max: f32 = 1.0;
    for i in 0..boundary.len() {
        let a = boundary[i];
        let b = boundary[(i + 1) % boundary.len()];
        let edge = (b.0 - a.0, b.1 - a.1);
        // Outward normal — we orient via the centroid because h3o does
        // not document a stable winding order.
        let mut nx = edge.1;
        let mut ny = -edge.0;
        let cx = centroid.0 - a.0;
        let cy = centroid.1 - a.1;
        if cx * nx + cy * ny > 0.0 {
            nx = -nx;
            ny = -ny;
        }
        // Line: q(t) = p0 + t*dir, inside when dot(q - a, n) ≤ 0.
        let qax = p0.0 - a.0;
        let qay = p0.1 - a.1;
        let num = qax * nx + qay * ny;
        let den = dir.0 * nx + dir.1 * ny;
        if den.abs() < 1e-9 {
            if num > 0.0 {
                return 0.0;
            }
            continue;
        }
        let t = -num / den;
        if den > 0.0 {
            t_max = t_max.min(t);
        } else {
            t_min = t_min.max(t);
        }
        if t_min > t_max {
            return 0.0;
        }
    }
    if t_max <= t_min {
        return 0.0;
    }
    (t_max - t_min) * total_len
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_abs_diff_eq;

    #[test]
    fn flat_dist_zero_when_endpoints_equal() {
        assert_eq!(flat_dist(50.0, 14.0, 50.0, 14.0), 0.0);
    }

    #[test]
    fn flat_dist_one_degree_lat_is_110540m() {
        let d = flat_dist(50.0, 14.0, 51.0, 14.0);
        assert_abs_diff_eq!(d, 110_540.0, epsilon = 50.0);
    }

    #[test]
    fn flat_dist_antimeridian_sane() {
        // 1° east of +179° is +180° / -180°. Distance should be ~1 deg of lon at equator.
        let d_normal = flat_dist(0.0, 14.0, 0.0, 15.0);
        let d_wrap = flat_dist(0.0, 179.5, 0.0, -179.5);
        assert_abs_diff_eq!(d_normal, d_wrap, epsilon = 50.0);
    }

    #[test]
    fn signed_lon_diff_wraps() {
        assert_abs_diff_eq!(signed_lon_diff(179.0, -179.0), 2.0, epsilon = 1e-4);
        assert_abs_diff_eq!(signed_lon_diff(-179.0, 179.0), -2.0, epsilon = 1e-4);
        assert_abs_diff_eq!(signed_lon_diff(0.0, 90.0), 90.0, epsilon = 1e-4);
    }

    #[test]
    fn heading_diff_wraps_around_360() {
        assert_eq!(heading_diff(10.0, 350.0), 20.0);
        assert_eq!(heading_diff(350.0, 10.0), 20.0);
        assert_eq!(heading_diff(0.0, 180.0), 180.0);
    }

    #[test]
    fn bearing_compass_directions() {
        let east = bearing_deg(50.0, 14.0, 50.0, 14.05);
        assert!((east - 90.0).abs() < 0.5, "east bearing got {east}");
        let north = bearing_deg(50.0, 14.0, 50.05, 14.0);
        assert!(north < 0.5 || north > 359.5, "north bearing got {north}");
    }

    #[test]
    fn midpoint_antimeridian() {
        // Midpoint of (179°E .. 179°W) at equator should be near 180° (== -180°).
        let (lat, lon) = midpoint(0.0, 179.0, 0.0, -179.0);
        assert_abs_diff_eq!(lat, 0.0, epsilon = 1e-5);
        // Either 180 or -180 acceptable — both represent the same meridian.
        assert!(
            (lon - 180.0).abs() < 1e-3 || (lon + 180.0).abs() < 1e-3,
            "midpoint lon got {lon}"
        );
    }

    #[test]
    fn cell_centroid_round_trip() {
        let res = Resolution::Eight;
        let cell = lat_lon_to_cell(50.10, 14.26, res).unwrap();
        let (lat, lon) = cell_centroid(cell);
        // Centroid should be within one cell of input
        let back = LatLng::new(lat, lon).unwrap().to_cell(res);
        assert_eq!(back, cell);
    }

    #[test]
    fn line_cell_clip_full_length_inside_cell() {
        let cell = lat_lon_to_cell(50.10, 14.26, Resolution::Eight).unwrap();
        let (clat, clon) = cell_centroid(cell);
        // Tiny segment around the centroid → fully inside.
        let length = line_cell_clip_length(
            clat as f32 - 0.0001,
            clon as f32 - 0.0001,
            clat as f32 + 0.0001,
            clon as f32 + 0.0001,
            cell,
        );
        let expected = flat_dist(
            clat as f32 - 0.0001,
            clon as f32 - 0.0001,
            clat as f32 + 0.0001,
            clon as f32 + 0.0001,
        );
        assert_abs_diff_eq!(length, expected, epsilon = 1.0);
    }

    #[test]
    fn line_cell_clip_segment_outside_returns_zero() {
        let cell = lat_lon_to_cell(50.10, 14.26, Resolution::Eight).unwrap();
        // Segment far away (> 50 km), entirely outside this 461 m hex.
        let length = line_cell_clip_length(60.0, 30.0, 60.001, 30.001, cell);
        assert_eq!(length, 0.0);
    }

    #[test]
    fn line_cell_clip_partial_crossing() {
        let res = Resolution::Eight;
        let cell = lat_lon_to_cell(50.10, 14.26, res).unwrap();
        let (clat, clon) = cell_centroid(cell);
        // Long horizontal line crossing the cell at the centroid latitude.
        // Length expected ≈ 2 * "in-radius" of the hex (~400 m at R8).
        let length = line_cell_clip_length(
            clat as f32,
            clon as f32 - 0.05,
            clat as f32,
            clon as f32 + 0.05,
            cell,
        );
        // R8 average cell edge 461 m → diameter via two opposite vertices
        // is < 1000 m. Sanity bound only.
        assert!(length > 200.0 && length < 1100.0, "got {length} m");
    }

    #[test]
    fn line_cell_clip_total_sum_matches_segment_length_when_fully_inside_chain() {
        // A horizontal segment of 5 km should be split across multiple R8
        // cells whose clipped lengths sum to the total.
        let lat = 50.10_f32;
        let lon0 = 14.20_f32;
        let lon1 = 14.27_f32; // ≈ 5 km east at this latitude
        let total = flat_dist(lat, lon0, lat, lon1);

        // Densify and collect cells visited.
        let n = 200;
        let mut cells = Vec::new();
        for i in 0..=n {
            let t = i as f32 / n as f32;
            let lo = lon0 + (lon1 - lon0) * t;
            let c = lat_lon_to_cell(lat as f64, lo as f64, Resolution::Eight).unwrap();
            if !cells.contains(&c) {
                cells.push(c);
            }
        }

        let sum: f32 = cells
            .iter()
            .map(|&c| line_cell_clip_length(lat, lon0, lat, lon1, c))
            .sum();

        // Sum of clipped lengths should match total within a few metres.
        assert_abs_diff_eq!(sum, total, epsilon = total * 0.02);
    }
}
