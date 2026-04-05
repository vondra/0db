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

/// Get profile by NACE 2-digit sector code.
/// WHY: OSM source_type only gives 5 coarse categories. NACE codes from IRZ/E-PRTR
/// enable sector-specific profiles (metallurgy ≠ warehouse ≠ power plant).
/// Values from docs/about/index.md emission tables, calibrated against SHM 2022.
/// Sources: EU 2000/14/EC equipment limits, 3M Noise Navigator, FHWA RCNM.
pub fn nace_profile(nace_2digit: u8) -> Option<IndustrialProfile> {
    Some(match nace_2digit {
        // Heavy industry — high base Lw
        8 => IndustrialProfile { // Mining/quarrying
            base_lw: 75.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -8.0, night_offset: -20.0,
        },
        23 => IndustrialProfile { // Cement, glass, minerals — grinding, crushing
            base_lw: 75.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -2.0, night_offset: -4.0, // often 24/7
        },
        24 => IndustrialProfile { // Metallurgy — smelting, forging
            base_lw: 78.0, spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -2.0, night_offset: -4.0,
        },
        // Medium industry
        10 | 11 => IndustrialProfile { // Food/beverage processing
            base_lw: 65.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -12.0,
        },
        13 | 14 | 15 => IndustrialProfile { // Textiles, leather
            base_lw: 65.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -15.0,
        },
        16 | 17 => IndustrialProfile { // Wood, paper — saws, presses
            base_lw: 70.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0, night_offset: -15.0,
        },
        20 => IndustrialProfile { // Chemical industry
            base_lw: 72.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -2.0, night_offset: -4.0,
        },
        22 => IndustrialProfile { // Rubber, plastics
            base_lw: 68.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -10.0,
        },
        25 => IndustrialProfile { // Metal fabrication — welding, cutting
            base_lw: 70.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0, night_offset: -10.0,
        },
        27 | 28 => IndustrialProfile { // Electrical/mechanical equipment
            base_lw: 68.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -12.0,
        },
        29 | 30 => IndustrialProfile { // Motor vehicles, transport equipment
            base_lw: 70.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -12.0,
        },
        // Energy/utilities
        35 => IndustrialProfile { // Power generation — turbines, transformers
            base_lw: 72.0, spectrum: [-2.0, 0.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -1.0, night_offset: -2.0, // near 24/7
        },
        37 => IndustrialProfile { // Wastewater treatment
            base_lw: 65.0, spectrum: [-6.0, -3.0, -1.0, 0.0, 0.0, -1.0, -4.0, -7.0],
            evening_offset: 0.0, night_offset: 0.0, // 24/7
        },
        38 => IndustrialProfile { // Waste/recycling — loaders, compactors
            base_lw: 72.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -8.0,
        },
        // Light industry / services
        1 | 2 | 3 => IndustrialProfile { // Agriculture
            base_lw: 55.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -20.0,
        },
        46 | 47 => IndustrialProfile { // Wholesale/retail trade — logistics
            base_lw: 58.0, spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -8.0, night_offset: -20.0,
        },
        52 => IndustrialProfile { // Warehousing/logistics
            base_lw: 60.0, spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -8.0,
        },
        _ => return None, // unknown NACE → fall back to site_type profile
    })
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
