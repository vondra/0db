//! ISO 9613-2:2024 Annex A.2.2 — vegetation attenuation.

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Compute vegetation attenuation per band.
/// depth_m = cumulative forest depth along source-receiver path.
pub fn vegetation_attenuation(depth_m: f64) -> [f64; NUM_BANDS] {
    let mut atten = [0.0f64; NUM_BANDS];
    if depth_m <= 0.0 { return atten; }

    for i in 0..NUM_BANDS {
        atten[i] = (ALPHA_VEG[i] * depth_m).min(MAX_VEG_ATTEN[i]);
    }
    atten
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_vegetation() {
        let a = vegetation_attenuation(0.0);
        assert_eq!(a, [0.0; NUM_BANDS]);
    }

    #[test]
    fn test_100m_forest() {
        let a = vegetation_attenuation(100.0);
        // 1 kHz: 0.06 × 100 = 6 dB
        assert!((a[4] - 6.0).abs() < 0.01);
        // 8 kHz: 0.12 × 100 = 12 dB
        assert!((a[7] - 12.0).abs() < 0.01);
    }

    #[test]
    fn test_per_band_cap() {
        let a = vegetation_attenuation(500.0);
        // 8 kHz: 0.12 × 500 = 60 → capped to 24 (ISO Table A.1: 200m × 0.12)
        assert_eq!(a[7], 24.0);
        // 63 Hz: 0.02 × 500 = 10 → capped to 4
        assert_eq!(a[0], 4.0);
        // 1 kHz: 0.06 × 500 = 30 → capped to 12
        assert_eq!(a[4], 12.0);
    }
}
