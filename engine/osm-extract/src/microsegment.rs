//! Split linestrings into microsegments of max_length_m.
//!
//! Each segment is a vertex pair: ([lat, lon], [lat, lon]).
//! If a linestring segment exceeds max_length, intermediate points are interpolated.

/// Flat-earth distance in meters (accurate to <0.3% at <50km).
/// Handles antimeridian wrapping: lon 179.9→-179.9 = 0.2°, not 359.8°.
fn flat_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let mid_lat = (lat1 + lat2) / 2.0;
    let cos_lat = mid_lat.to_radians().cos();
    let mut dlon = lon2 - lon1;
    if dlon > 180.0 { dlon -= 360.0; }
    if dlon < -180.0 { dlon += 360.0; }
    let dx = dlon * 111_320.0 * cos_lat;
    let dy = (lat2 - lat1) * 110_540.0;
    (dx * dx + dy * dy).sqrt()
}

/// Split a linestring (series of [lat, lon] vertices) into segments of max_length_m.
/// Returns pairs of (start, end) with precomputed length.
pub fn split(coords: &[[f64; 2]], max_length_m: f64) -> Vec<([f64; 2], [f64; 2], f32)> {
    let mut segments = Vec::new();

    for i in 0..coords.len() - 1 {
        let a = coords[i];
        let b = coords[i + 1];
        let dist = flat_dist(a[0], a[1], b[0], b[1]);

        if dist <= max_length_m {
            segments.push((a, b, dist as f32));
        } else {
            // Interpolate sub-segments (with antimeridian-safe longitude delta)
            let n = (dist / max_length_m).ceil() as usize;
            let mut dlon = b[1] - a[1];
            if dlon > 180.0 { dlon -= 360.0; }
            if dlon < -180.0 { dlon += 360.0; }
            for j in 0..n {
                let t0 = j as f64 / n as f64;
                let t1 = (j + 1) as f64 / n as f64;
                let p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + dlon * t0];
                let p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + dlon * t1];
                let seg_len = dist / n as f64;
                segments.push((p0, p1, seg_len as f32));
            }
        }
    }

    segments
}
