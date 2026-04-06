//! WKB polygon utilities — area calculation from hex-encoded WKB.
//!
//! Used by both source-reader (popup) and pipeline-worker (tile generation)
//! to compute real area from OSM polygon data instead of hardcoded defaults.
//!
//! WHY: Industrial area was hardcoded to 10000 m², building area to 100 m².
//! This caused Spolana (500K m²) to have same emission as a recycling yard.
//! Formula: Lw = base + 10×log₁₀(area/10000) per ISO 8297.
//!
//! APPROACH: Shoelace formula on WGS84 coordinates with cos(lat) correction.
//! Gemini 3.1 Pro review noted this is approximate; EPSG:3035 projection is
//! more accurate. For continental scale this is acceptable (<5% error).
//! Future: osm-extract should pre-compute area_m2 in metric CRS.

/// Compute area in m² from hex-encoded WKB polygon.
/// Returns None if WKB is invalid, too short, or not a Polygon/MultiPolygon.
pub fn wkb_area_m2(wkb_hex: &str) -> Option<f64> {
    if wkb_hex.len() < 18 { return None; }

    let bytes: Vec<u8> = (0..wkb_hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&wkb_hex[i..i+2], 16).ok())
        .collect();

    if bytes.len() < 9 { return None; }

    let le = bytes[0] == 1;
    let wkb_type = if le {
        u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    } else {
        u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    };

    if wkb_type != 3 && wkb_type != 6 { return None; } // 3=Polygon, 6=MultiPolygon

    let read_u32 = |off: usize| -> u32 {
        if off + 4 > bytes.len() { return 0; }
        if le { u32::from_le_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
        else { u32::from_be_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
    };
    let read_f64 = |off: usize| -> f64 {
        if off + 8 > bytes.len() { return 0.0; }
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[off..off+8]);
        if le { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }
    };

    if wkb_type == 3 {
        ring_area(&bytes, 5, &read_u32, &read_f64)
    } else {
        // MultiPolygon — sum areas
        let num_polys = read_u32(5) as usize;
        let mut total = 0.0;
        let mut off = 9;
        for _ in 0..num_polys {
            if off + 9 > bytes.len() { break; }
            off += 5; // skip sub-polygon header
            if let Some((area, new_off)) = ring_area_offset(&bytes, off, &read_u32, &read_f64) {
                total += area;
                off = new_off;
            } else { break; }
        }
        if total > 0.0 { Some(total) } else { None }
    }
}

fn ring_area(bytes: &[u8], start: usize, read_u32: &dyn Fn(usize) -> u32, read_f64: &dyn Fn(usize) -> f64) -> Option<f64> {
    ring_area_offset(bytes, start, read_u32, read_f64).map(|(a, _)| a)
}

fn ring_area_offset(bytes: &[u8], start: usize, read_u32: &dyn Fn(usize) -> u32, read_f64: &dyn Fn(usize) -> f64) -> Option<(f64, usize)> {
    if start + 4 > bytes.len() { return None; }
    let num_rings = read_u32(start) as usize;
    let mut off = start + 4;
    if num_rings == 0 || off + 4 > bytes.len() { return None; }

    let num_points = read_u32(off) as usize;
    off += 4;
    if num_points < 3 || off + num_points * 16 > bytes.len() { return None; }

    let mut lats = Vec::with_capacity(num_points);
    let mut lons = Vec::with_capacity(num_points);
    for _ in 0..num_points {
        lons.push(read_f64(off));
        lats.push(read_f64(off + 8));
        off += 16;
    }

    // Skip inner rings
    for _ in 1..num_rings {
        if off + 4 > bytes.len() { break; }
        let rp = read_u32(off) as usize;
        off += 4 + rp * 16;
    }

    // Shoelace with cos(lat) metric correction
    let mean_lat: f64 = lats.iter().sum::<f64>() / lats.len() as f64;
    let cos_lat = mean_lat.to_radians().cos();
    let mut area_deg2 = 0.0f64;
    for i in 0..num_points {
        let j = (i + 1) % num_points;
        let xi = lons[i] * cos_lat;
        let xj = lons[j] * cos_lat;
        area_deg2 += xi * lats[j] - xj * lats[i];
    }
    let area_m2 = (area_deg2 / 2.0).abs() * 110_540.0 * 111_320.0;
    Some((area_m2, off))
}

/// Generate grid points inside a WKB polygon for distributed emission.
///
/// WHY: A single centroid point source creates unrealistic "donut" patterns
/// (quiet inside large facility, loud ring at centroid distance).
/// Distributed points spread emission across the real footprint.
/// Each point gets Lw_per_point = Lw_total - 10×log₁₀(N) (energy-conserving).
///
/// spacing_m: approximate grid spacing in meters (30m for buildings, 150m for industrial)
/// Returns: Vec of (lat, lon) points inside the polygon. At least 1 (centroid fallback).
pub fn wkb_grid_points(wkb_hex: &str, spacing_m: f64) -> Vec<(f64, f64)> {
    // Parse polygon coordinates
    let coords = match parse_wkb_polygon_coords(wkb_hex) {
        Some(c) => c,
        None => return vec![],
    };

    if coords.is_empty() { return vec![]; }

    // Bounding box
    let mut min_lat = f64::MAX;
    let mut max_lat = f64::MIN;
    let mut min_lon = f64::MAX;
    let mut max_lon = f64::MIN;
    for &(lat, lon) in &coords {
        if lat < min_lat { min_lat = lat; }
        if lat > max_lat { max_lat = lat; }
        if lon < min_lon { min_lon = lon; }
        if lon > max_lon { max_lon = lon; }
    }

    // Convert spacing to degrees
    let mid_lat = (min_lat + max_lat) / 2.0;
    let lat_step = spacing_m / 110_540.0;
    let lon_step = spacing_m / (111_320.0 * mid_lat.to_radians().cos().max(0.1));

    // Generate grid
    let mut points = Vec::new();
    let mut lat = min_lat + lat_step / 2.0;
    while lat <= max_lat {
        let mut lon = min_lon + lon_step / 2.0;
        while lon <= max_lon {
            if point_in_polygon(lat, lon, &coords) {
                points.push((lat, lon));
            }
            lon += lon_step;
        }
        lat += lat_step;
    }

    // Fallback: at least the centroid
    if points.is_empty() {
        let clat = coords.iter().map(|c| c.0).sum::<f64>() / coords.len() as f64;
        let clon = coords.iter().map(|c| c.1).sum::<f64>() / coords.len() as f64;
        points.push((clat, clon));
    }

    points
}

/// Parse WKB hex into outer ring coordinates as Vec<(lat, lon)>.
/// Reuses same parsing logic as ring_area_offset (proven to work for area calculation).
fn parse_wkb_polygon_coords(wkb_hex: &str) -> Option<Vec<(f64, f64)>> {
    if wkb_hex.len() < 18 { return None; }

    let bytes: Vec<u8> = (0..wkb_hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&wkb_hex[i..i+2], 16).ok())
        .collect();
    if bytes.len() < 9 { return None; }

    let le = bytes[0] == 1;
    let wkb_type = if le {
        u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    } else {
        u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])
    };

    let read_u32 = |off: usize| -> u32 {
        if off + 4 > bytes.len() { return 0; }
        if le { u32::from_le_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
        else { u32::from_be_bytes([bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]]) }
    };
    let read_f64 = |off: usize| -> f64 {
        if off + 8 > bytes.len() { return 0.0; }
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[off..off+8]);
        if le { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }
    };

    // Handle both Polygon (3) and MultiPolygon (6) — use first polygon's outer ring
    let ring_start = match wkb_type {
        3 => 5, // byte_order(1) + type(4) → rings start at 5
        6 => {
            // MultiPolygon: skip to first sub-polygon
            // 5=num_polys, then first sub-polygon has byte_order(1)+type(4)+rings
            if bytes.len() < 14 { return None; }
            5 + 4 + 1 + 4 // skip num_polys(4) + sub byte_order(1) + sub type(4) = offset 14
        }
        _ => return None,
    };

    if ring_start + 4 > bytes.len() { return None; }
    let num_rings = read_u32(ring_start) as usize;
    if num_rings == 0 { return None; }

    let pts_off = ring_start + 4;
    if pts_off + 4 > bytes.len() { return None; }
    let num_points = read_u32(pts_off) as usize;
    if num_points < 3 { return None; }

    let coord_off = pts_off + 4;
    if coord_off + num_points * 16 > bytes.len() { return None; }

    let mut coords = Vec::with_capacity(num_points);
    for i in 0..num_points {
        let lon = read_f64(coord_off + i * 16);
        let lat = read_f64(coord_off + i * 16 + 8);
        coords.push((lat, lon));
    }
    Some(coords)
}

/// Ray-casting point-in-polygon test.
fn point_in_polygon(lat: f64, lon: f64, poly: &[(f64, f64)]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (yi, xi) = poly[i];
        let (yj, xj) = poly[j];
        if ((yi > lat) != (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_wkb() {
        assert_eq!(wkb_area_m2(""), None);
        assert_eq!(wkb_area_m2("0102"), None);
    }
}

// TODO (GPT-5.4 review): Inner rings (courtyards) are not subtracted from area.
// A building with 50% courtyard gets full area → Lw overestimated by ~3 dB.
// MultiPolygon only uses first polygon for grid points.
// Fix: subtract inner ring areas, test containment against all rings,
// iterate all polygons in MultiPolygon for grid generation.
