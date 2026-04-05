//! Industrial noise emission (ISO 8297 + NACE profiles).
//!
//! Lw = baseLw + 10×log₁₀(area_m² / 10000)
//! Pre-discretized: Lw_per_point = Lw_total - 10×log₁₀(N_points)

use crate::types::NUM_BANDS;

/// Industrial emission profile.
pub struct IndustrialProfile {
    pub base_lw: f64,                // reference Lw at 10000 m² [dB]
    pub spectrum: [f64; NUM_BANDS],  // relative dB per band
    pub evening_offset: f64,
    pub night_offset: f64,
}

/// Get profile by site_type.
pub fn industrial_profile(site_type: u8) -> IndustrialProfile {
    match site_type {
        0 => IndustrialProfile { // generic industrial
            base_lw: 70.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -10.0,
        },
        1 => IndustrialProfile { // quarry — crushing, loading, blasting
            base_lw: 75.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -5.0, night_offset: -20.0,
        },
        2 => IndustrialProfile { // farmyard — animal husbandry, machinery, seasonal
            // WHY: Was missing (fallthrough to default 68 dB). Farms are quieter than
            // industry and mostly active during daytime only.
            base_lw: 55.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -20.0, // virtually silent at night
        },
        3 => IndustrialProfile { // works/factory
            base_lw: 72.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -8.0,
        },
        4 => IndustrialProfile { // wastewater plant
            base_lw: 65.0,
            spectrum: [-6.0, -3.0, -1.0, 0.0, 0.0, -1.0, -4.0, -7.0],
            evening_offset: 0.0, night_offset: 0.0, // 24/7
        },
        10 => IndustrialProfile { // wind turbine (handled by wind.rs)
            base_lw: 0.0,
            spectrum: [0.0; NUM_BANDS],
            evening_offset: 0.0, night_offset: 0.0,
        },
        _ => IndustrialProfile { // default
            base_lw: 68.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -10.0,
        },
    }
}

/// Compute industrial Lw from profile and site area.
pub fn industrial_lw(profile: &IndustrialProfile, area_m2: f64) -> f64 {
    profile.base_lw + 10.0 * (area_m2 / 10000.0).max(0.01).log10()
}

/// Compute emission bands.
pub fn industrial_emission_bands(profile: &IndustrialProfile, lw: f64) -> [f64; NUM_BANDS] {
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = lw + profile.spectrum[i];
    }
    bands
}
