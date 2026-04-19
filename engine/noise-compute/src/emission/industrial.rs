//! Industrial noise emission (ISO 8297 + NACE profiles).
//!
//! Lw = baseLw + 10×log₁₀(area_m² / 10000)
//! Pre-discretized: Lw_per_point = Lw_total - 10×log₁₀(N_points)

use crate::types::NUM_BANDS;

/// Industrial emission profile.
pub struct IndustrialProfile {
    pub base_lw: f64,               // reference Lw at 10000 m² [dB]
    pub spectrum: [f64; NUM_BANDS], // relative dB per band
    pub evening_offset: f64,
    pub night_offset: f64,
}

/// Get profile by site_type.
/// base_lw values calibrated against Czech SHM 2022 + CNOSSOS-EU Lw'' methodology.
/// Reviewed by GPT-5.4 + Gemini 3.1 Pro against ISO 8297 and real EIS data.
pub fn industrial_profile(site_type: u8) -> IndustrialProfile {
    match site_type {
        0 => IndustrialProfile {
            // generic industrial
            base_lw: 93.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -10.0,
        },
        1 => IndustrialProfile {
            // quarry — crushing, loading, blasting
            base_lw: 99.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        2 => IndustrialProfile {
            // farmyard — animal husbandry, machinery, seasonal
            base_lw: 70.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        3 => IndustrialProfile {
            // works/factory
            base_lw: 94.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -8.0,
        },
        4 => IndustrialProfile {
            // wastewater plant
            base_lw: 89.0,
            spectrum: [-6.0, -3.0, -1.0, 0.0, 0.0, -1.0, -4.0, -7.0],
            evening_offset: 0.0,
            night_offset: 0.0, // 24/7
        },
        10 => IndustrialProfile {
            // wind turbine (handled by wind.rs)
            base_lw: 0.0,
            spectrum: [0.0; NUM_BANDS],
            evening_offset: 0.0,
            night_offset: 0.0,
        },
        _ => IndustrialProfile {
            // default
            base_lw: 92.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -10.0,
        },
    }
}

/// Get profile by NACE 4-digit sector code.
/// WHY: OSM source_type only gives 5 coarse categories. NACE codes from IRZ/E-PRTR/GEM
/// enable sector-specific profiles (metallurgy ≠ warehouse ≠ solar farm).
/// 4-digit resolution distinguishes solar (3599, quiet) from thermal power (3511, loud).
/// Values from docs/about/index.md emission tables, calibrated against SHM 2022.
/// Sources: EU 2000/14/EC equipment limits, 3M Noise Navigator, FHWA RCNM.
pub fn nace_profile(nace_4digit: u16) -> Option<IndustrialProfile> {
    // Try 4-digit match first (more specific), then fall back to 2-digit.
    // NOTE: NACE 3512 ("renewable") mixes solar, wind, and hydro in upstream source data.
    // Wind turbines are safe (source_type=10 early-returns before NACE is checked).
    // But hydro would wrongly get the solar profile, so we use a synthetic code 3599
    // for confirmed solar plants only. Enrichment scripts must write 3599 (=360000/100) for solar.
    match nace_4digit {
        // Solar farms — inverters only, ~45-55 dB Lw, zero at night.
        // Synthetic NACE 3599 (not real NACE) to avoid 3512 which mixes renewables.
        3599 => {
            return Some(IndustrialProfile {
                base_lw: 55.0,
                spectrum: [-8.0, -5.0, -2.0, 0.0, 0.0, -1.0, -3.0, -6.0],
                evening_offset: -3.0,
                night_offset: -50.0, // effectively silent at night
            });
        }
        // Thermal/nuclear power — turbines, cooling towers, transformers
        3511 => {
            return Some(IndustrialProfile {
                base_lw: 97.0,
                spectrum: [-2.0, 0.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
                evening_offset: -1.0,
                night_offset: -2.0, // near 24/7
            });
        }
        // Hydro power — turbines, spillways
        3512 => {
            return Some(IndustrialProfile {
                base_lw: 90.0,
                spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
                evening_offset: 0.0,
                night_offset: 0.0, // 24/7 baseload
            });
        }
        _ => {}
    }
    // Fall back to 2-digit match
    let nace_2 = nace_4digit / 100;
    Some(match nace_2 {
        // Heavy industry — high base Lw
        // Calibrated against Czech SHM 2022 + Irish Cement EIS (120.8 dBA plant total).
        8 => IndustrialProfile {
            // Mining/quarrying
            base_lw: 99.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -8.0,
            night_offset: -20.0,
        },
        23 => IndustrialProfile {
            // Cement, glass, minerals — grinding, crushing
            base_lw: 100.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -2.0,
            night_offset: -4.0, // often 24/7
        },
        24 => IndustrialProfile {
            // Metallurgy — smelting, forging
            base_lw: 100.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -2.0,
            night_offset: -4.0,
        },
        // Medium industry
        10 | 11 => IndustrialProfile {
            // Food/beverage processing
            base_lw: 90.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -12.0,
        },
        13 | 14 | 15 => IndustrialProfile {
            // Textiles, leather
            base_lw: 88.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        16 | 17 => IndustrialProfile {
            // Wood, paper — saws, presses
            base_lw: 93.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        20 => IndustrialProfile {
            // Chemical industry
            base_lw: 94.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -2.0,
            night_offset: -4.0,
        },
        22 => IndustrialProfile {
            // Rubber, plastics
            base_lw: 90.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -10.0,
        },
        25 => IndustrialProfile {
            // Metal fabrication — welding, cutting
            base_lw: 93.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -10.0,
        },
        27 | 28 => IndustrialProfile {
            // Electrical/mechanical equipment
            base_lw: 90.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -12.0,
        },
        29 | 30 => IndustrialProfile {
            // Motor vehicles, transport equipment
            base_lw: 93.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -12.0,
        },
        // Energy/utilities — generic NACE 35 (not matched by 4-digit above)
        35 => IndustrialProfile {
            // Power generation — turbines, transformers (fallback)
            base_lw: 97.0,
            spectrum: [-2.0, 0.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -1.0,
            night_offset: -2.0, // near 24/7
        },
        37 => IndustrialProfile {
            // Wastewater treatment
            base_lw: 89.0,
            spectrum: [-6.0, -3.0, -1.0, 0.0, 0.0, -1.0, -4.0, -7.0],
            evening_offset: 0.0,
            night_offset: 0.0, // 24/7
        },
        38 => IndustrialProfile {
            // Waste/recycling — loaders, compactors
            base_lw: 95.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -8.0,
        },
        // Light industry / services
        1 | 2 | 3 => IndustrialProfile {
            // Agriculture
            base_lw: 70.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        46 | 47 => IndustrialProfile {
            // Wholesale/retail trade — logistics
            base_lw: 84.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -8.0,
            night_offset: -20.0,
        },
        52 => IndustrialProfile {
            // Warehousing/logistics
            base_lw: 86.0,
            spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -8.0,
        },
        _ => return None, // unknown NACE → fall back to site_type profile
    })
}

/// Get profile by site_subtype from OSM tags (industrial=*, product=*).
/// Fallback between nace_profile (most specific) and industrial_profile (coarsest).
/// Subtype values set by osm-extract site_subtype_from_tags().
pub fn subtype_profile(subtype: u8) -> Option<IndustrialProfile> {
    let spec = [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0]; // generic industrial
    match subtype {
        0 => None, // unknown — fall through to source_type
        1 => Some(IndustrialProfile { // warehouse/logistics — quiet
            base_lw: 75.0, spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -15.0,
        }),
        2 => Some(IndustrialProfile { // factory/works — generic loud
            base_lw: 95.0, spectrum: spec,
            evening_offset: -3.0, night_offset: -6.0,
        }),
        3 => Some(IndustrialProfile { // mine/quarry — very loud
            base_lw: 99.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -5.0, night_offset: -20.0, // daytime only
        }),
        4 => Some(IndustrialProfile { // chemical/refinery
            base_lw: 90.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -1.0, night_offset: -3.0, // 24/7
        }),
        5 => Some(IndustrialProfile { // cement/mineral — very loud
            base_lw: 100.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -2.0, -5.0, -8.0],
            evening_offset: -1.0, night_offset: -3.0, // 24/7
        }),
        6 => Some(IndustrialProfile { // metal/steel/smelter — very loud
            base_lw: 100.0, spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -1.0, night_offset: -3.0, // 24/7
        }),
        7 => Some(IndustrialProfile { // food/brewery — moderate
            base_lw: 88.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -10.0,
        }),
        8 => Some(IndustrialProfile { // wood/sawmill — moderate-loud
            base_lw: 90.0, spectrum: spec,
            evening_offset: -5.0, night_offset: -15.0,
        }),
        9 => Some(IndustrialProfile { // waste/recycling
            base_lw: 93.0, spectrum: spec,
            evening_offset: -3.0, night_offset: -6.0,
        }),
        10 => Some(IndustrialProfile { // farm/agriculture — quiet
            base_lw: 70.0, spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -15.0,
        }),
        11 => Some(IndustrialProfile { // office/commercial — very quiet
            base_lw: 60.0, spectrum: [-5.0, -3.0, -1.0, 0.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0, night_offset: -20.0,
        }),
        12 => Some(IndustrialProfile { // port/shipyard
            base_lw: 92.0, spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0, night_offset: -6.0,
        }),
        _ => None,
    }
}

/// Compute industrial Lw from profile and site area.
/// Area capped at 500,000 m² (50 ha) — larger OSM polygons contain buffer zones,
/// not additional emission sources.
pub fn industrial_lw(profile: &IndustrialProfile, area_m2: f64) -> f64 {
    let effective = area_m2.clamp(100.0, 500_000.0);
    profile.base_lw + 10.0 * (effective / 10000.0).log10()
}

/// Compute emission bands.
pub fn industrial_emission_bands(profile: &IndustrialProfile, lw: f64) -> [f64; NUM_BANDS] {
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = lw + profile.spectrum[i];
    }
    bands
}
