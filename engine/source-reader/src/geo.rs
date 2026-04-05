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

    // Project to meters (local tangent plane)
    let ax = 0.0;
    let ay = 0.0;
    let bx = (b_lon - a_lon) * 111_320.0 * cos_lat;
    let by = (b_lat - a_lat) * 110_540.0;
    let px = (p_lon - a_lon) * 111_320.0 * cos_lat;
    let py = (p_lat - a_lat) * 110_540.0;

    // Project P onto line AB
    let ab_x = bx - ax;
    let ab_y = by - ay;
    let ab_len_sq = ab_x * ab_x + ab_y * ab_y;

    let t = if ab_len_sq < 1e-10 {
        0.0 // degenerate segment
    } else {
        ((px - ax) * ab_x + (py - ay) * ab_y) / ab_len_sq
    };

    let t_clamped = t.clamp(0.0, 1.0);

    let cp_x = ax + t_clamped * ab_x;
    let cp_y = ay + t_clamped * ab_y;

    let dx = px - cp_x;
    let dy = py - cp_y;
    let dist_m = (dx * dx + dy * dy).sqrt();

    // Back to lat/lon
    let cp_lon = a_lon + t_clamped * (b_lon - a_lon);
    let cp_lat = a_lat + t_clamped * (b_lat - a_lat);

    ClosestPoint { lat: cp_lat, lon: cp_lon, dist_m, fraction: t_clamped }
}

/// Get H3 res-4 hex IDs for a point + ring-1 neighbors (7 hexes).
pub fn grid_disk_r4(lat: f64, lon: f64) -> Vec<String> {
    let Ok(ll) = LatLng::new(lat, lon) else { return vec![] };
    let cell = ll.to_cell(Resolution::Four);

    let mut result = Vec::with_capacity(7);
    result.push(format!("{cell}"));

    // grid_disk k=1
    let disk: Vec<CellIndex> = cell.grid_disk::<Vec<_>>(1);
    for c in disk {
        let s = format!("{c}");
        if !result.contains(&s) {
            result.push(s);
        }
    }

    result
}

/// Compute area in m² from WKB hex-encoded polygon.
/// Uses Shoelace formula with cos(lat) correction for WGS84→metric.
///
/// WHY: Industrial and building area was hardcoded (10000 m² industrial, 100 m² building).
/// This caused Spolana (500K m²) to have same Lw as a small recycling yard.
/// Formula: Lw = base + 10×log₁₀(area/10000) per ISO 8297.
/// ALSO AFFECTS: pipeline-worker/io/arrow.rs uses same pattern.
/// REVIEWED: GPT-5.4 + Gemini 3.1 Pro confirmed approach. Gemini warns
///           cos(lat) correction is approximate; EPSG:3035 projection is better
///           but acceptable for runtime. osm-extract should pre-compute area_m2.
pub fn wkb_area_m2(wkb_hex: &str) -> Option<f64> {
    if wkb_hex.len() < 18 { return None; } // minimum viable WKB

    // Decode hex → bytes
    let bytes: Vec<u8> = (0..wkb_hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&wkb_hex[i..i+2], 16).ok())
        .collect();

    if bytes.len() < 9 { return None; }

    // WKB format: byte_order(1) + type(4) + num_rings(4) + ring...
    let le = bytes[0] == 1;
    let wkb_type = if le {
        u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    } else {
        u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    };

    // Type 3 = Polygon, Type 6 = MultiPolygon
    if wkb_type != 3 && wkb_type != 6 { return None; }

    let read_u32 = |off: usize| -> u32 {
        if le { u32::from_le_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
        else { u32::from_be_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
    };
    let read_f64 = |off: usize| -> f64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[off..off+8]);
        if le { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }
    };

    if wkb_type == 3 {
        // Single Polygon
        polygon_area_from_wkb_at(&bytes, 5, le, &read_u32, &read_f64)
    } else {
        // MultiPolygon — sum areas
        let num_polys = read_u32(5) as usize;
        let mut total = 0.0;
        let mut off = 9;
        for _ in 0..num_polys {
            if off + 5 > bytes.len() { break; }
            // Each polygon has its own byte_order + type header
            off += 5; // skip sub-polygon header (byte_order + type)
            if let Some((area, new_off)) = polygon_area_and_offset(&bytes, off, le, &read_u32, &read_f64) {
                total += area;
                off = new_off;
            } else { break; }
        }
        if total > 0.0 { Some(total) } else { None }
    }
}

fn polygon_area_from_wkb_at(
    bytes: &[u8], start: usize, _le: bool,
    read_u32: &dyn Fn(usize) -> u32,
    read_f64: &dyn Fn(usize) -> f64,
) -> Option<f64> {
    let (area, _) = polygon_area_and_offset(bytes, start, _le, read_u32, read_f64)?;
    Some(area)
}

fn polygon_area_and_offset(
    bytes: &[u8], start: usize, _le: bool,
    read_u32: &dyn Fn(usize) -> u32,
    read_f64: &dyn Fn(usize) -> f64,
) -> Option<(f64, usize)> {
    if start + 4 > bytes.len() { return None; }
    let num_rings = read_u32(start) as usize;
    let mut off = start + 4;

    // Only use outer ring (first ring) for area
    if num_rings == 0 { return None; }
    if off + 4 > bytes.len() { return None; }
    let num_points = read_u32(off) as usize;
    off += 4;

    if num_points < 3 { return None; }
    if off + num_points * 16 > bytes.len() { return None; }

    // Read coordinates
    let mut lats = Vec::with_capacity(num_points);
    let mut lons = Vec::with_capacity(num_points);
    for _ in 0..num_points {
        let lon = read_f64(off);
        let lat = read_f64(off + 8);
        lons.push(lon);
        lats.push(lat);
        off += 16;
    }

    // Skip remaining rings (inner holes)
    for _ in 1..num_rings {
        if off + 4 > bytes.len() { break; }
        let ring_pts = read_u32(off) as usize;
        off += 4 + ring_pts * 16;
    }

    // Shoelace formula in degrees, then convert to m²
    // Area correction: multiply by cos(mean_lat) for longitude stretching
    let mean_lat: f64 = lats.iter().sum::<f64>() / lats.len() as f64;
    let cos_lat = mean_lat.to_radians().cos();

    let mut area_deg2 = 0.0f64;
    for i in 0..num_points {
        let j = (i + 1) % num_points;
        // Shoelace with longitude scaled by cos(lat) for equal-area approximation
        let xi = lons[i] * cos_lat;
        let xj = lons[j] * cos_lat;
        area_deg2 += xi * lats[j] - xj * lats[i];
    }
    area_deg2 = (area_deg2 / 2.0).abs();

    // Convert degree² to m²: 1° lat ≈ 110540m, 1° lon ≈ 111320m×cos(lat)
    // Already scaled lons by cos_lat, so: area_m2 = area_deg2 × 110540 × 111320
    let area_m2 = area_deg2 * 110_540.0 * 111_320.0;

    Some((area_m2, off))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flat_dist() {
        // Prague to ~1km east
        let d = flat_dist(50.08, 14.42, 50.08, 14.434);
        assert!((d - 1000.0).abs() < 50.0, "d={d}");
    }

    #[test]
    fn test_closest_point() {
        // Point perpendicular to segment midpoint
        let cp = closest_point_on_segment(
            50.08, 14.42,        // point
            50.079, 14.41,       // segment start
            50.079, 14.43,       // segment end
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

    #[test]
    fn test_prague_hex() {
        let hexes = grid_disk_r4(50.08, 14.42);
        println!("Prague hexes: {:?}", hexes);
        assert!(hexes.contains(&"841e355ffffffff".to_string()),
            "Expected 841e355ffffffff in {:?}", hexes);
    }
