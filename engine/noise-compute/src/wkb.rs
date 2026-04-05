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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_wkb() {
        assert_eq!(wkb_area_m2(""), None);
        assert_eq!(wkb_area_m2("0102"), None);
    }
}
