//! Wind turbine noise emission (IEC 61400-11).

use crate::types::NUM_BANDS;

/// Wind turbine broadband spectrum [dB relative].
const TURBINE_SPECTRUM: [f64; NUM_BANDS] = [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0];

/// Compute wind turbine Lw from rated power.
pub fn turbine_lw(rated_power_kw: f64) -> f64 {
    if !rated_power_kw.is_finite() {
        return f64::NEG_INFINITY; // truly invalid data
    }
    // rated_power_kw == 0 means "unknown" in OSM — use 2000 kW default (~103 dB)
    if rated_power_kw <= 0.0 {
        return 103.0;
    }
    match rated_power_kw as u32 {
        0..=999 => 98.0,
        1000..=1999 => 101.0,
        2000..=2999 => 103.0,
        3000..=4999 => 105.0,
        _ => 107.0, // ≥5000 kW
    }
}

/// Compute emission bands for a wind turbine.
pub fn turbine_emission_bands(rated_power_kw: f64) -> [f64; NUM_BANDS] {
    let lw = turbine_lw(rated_power_kw);
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = lw + TURBINE_SPECTRUM[i];
    }
    bands
}

/// Combined: returns (lw_broadband, emission_bands).
pub fn wind_turbine_emission(rated_power_kw: f64) -> (f64, [f64; NUM_BANDS]) {
    let lw = turbine_lw(rated_power_kw);
    let bands = turbine_emission_bands(rated_power_kw);
    (lw, bands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::propagation::iso9613::a_weighted_total;

    #[test]
    fn test_turbine_lw() {
        assert_eq!(turbine_lw(500.0), 98.0);
        assert_eq!(turbine_lw(2000.0), 103.0);
        assert_eq!(turbine_lw(6000.0), 107.0);
    }

    #[test]
    fn test_unknown_rated_power_uses_default() {
        assert_eq!(turbine_lw(0.0), 103.0); // unknown → 2000 kW default
        assert!(turbine_lw(f64::NAN).is_infinite() && turbine_lw(f64::NAN).is_sign_negative());
    }

    #[test]
    fn test_turbine_bands() {
        let bands = turbine_emission_bands(3000.0);
        let aw = a_weighted_total(&bands);
        // 3 MW turbine: Lw=105, A-weighted slightly less due to spectral shape
        // A-weighted total can exceed broadband Lw because positive spectrum values add energy
        assert!(aw > 100.0 && aw < 115.0, "3MW turbine: {:.1}", aw);
    }
}
