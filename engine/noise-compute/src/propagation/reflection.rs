//! ISO 9613-2 §7.5 urban reflection — per-receiver boost.
//!
//! Applied ONCE per receiver based on surrounding building density.
//! NOT per source-receiver path (simplification).

/// Compute urban reflection boost at receiver position [dB, 0 to +5].
///
/// enclosure: building enclosure value from raster (0 = open field, higher = more enclosed).
/// Typically: number of 8-direction sectors with buildings > 0, × 1.5.
pub fn reflection_boost(enclosure_db: f64) -> f64 {
    enclosure_db.clamp(0.0, 5.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_field() {
        assert_eq!(reflection_boost(0.0), 0.0);
    }

    #[test]
    fn test_urban_canyon() {
        assert_eq!(reflection_boost(4.5), 4.5);
    }

    #[test]
    fn test_cap() {
        assert_eq!(reflection_boost(8.0), 5.0);
    }
}
