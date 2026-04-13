//! Settlement (building) noise emission — custom model (NOT standardized).
//!
//! Two-component Lw model:
//!   Lw = 10×log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))
//! where GFA = area_m² × floors
//!
//! Buildings pre-discretized at import (centroid or facade points).
//! This module computes emission for a single point source.

use crate::types::NUM_BANDS;

/// Building emission profile.
pub struct BuildingProfile {
    pub lw_fixed: f64,              // point sources (loading dock, HVAC unit) [dB]
    pub lw_per_m2: f64,             // distributed (facade breakout, HVAC per area) [dB/m²]
    pub spectrum: [f64; NUM_BANDS], // relative dB per band
    pub evening_offset: f64,        // dB (typically -3 to -10)
    pub night_offset: f64,          // dB (typically -10 to -25)
}

/// Get emission profile by building type.
pub fn building_profile(building_type: u8) -> BuildingProfile {
    match building_type {
        0 => BuildingProfile {
            // residential
            lw_fixed: 45.0,
            lw_per_m2: 15.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        1 => BuildingProfile {
            // commercial
            lw_fixed: 55.0,
            lw_per_m2: 20.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 1.0, -1.0, -3.0],
            evening_offset: -3.0,
            night_offset: -20.0,
        },
        2 => BuildingProfile {
            // warehouse/industrial building — HVAC, ventilation, handling
            // WHY: Was Lw=0 (silent). But warehouses have ventilation, HVAC, loading activity.
            // Industrial landuse polygon = outdoor activity; building = facade/roof breakout.
            // Both contribute — NOT double counting (different physical noise sources).
            lw_fixed: 40.0,
            lw_per_m2: 15.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        3 => BuildingProfile {
            // school
            lw_fixed: 60.0,
            lw_per_m2: 22.0,
            spectrum: [-2.0, 0.0, 1.0, 2.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -10.0,
            night_offset: -25.0,
        },
        4 => BuildingProfile {
            // hospital
            lw_fixed: 50.0,
            lw_per_m2: 18.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -3.0,
            night_offset: -5.0, // 24/7 operation
        },
        5 => BuildingProfile {
            // church/worship — bells, organ, gatherings
            lw_fixed: 50.0,
            lw_per_m2: 20.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        6 => BuildingProfile {
            // hotel
            lw_fixed: 48.0,
            lw_per_m2: 16.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -2.0,
            night_offset: -10.0,
        },
        7 => BuildingProfile {
            // garage/parking — ventilation fans, engine starts
            lw_fixed: 35.0,
            lw_per_m2: 12.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        8 => BuildingProfile {
            // farm building — animals, machinery, seasonal
            lw_fixed: 40.0,
            lw_per_m2: 14.0,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        9 => BuildingProfile {
            // public/civic/government — office HVAC, visitor traffic
            lw_fixed: 52.0,
            lw_per_m2: 18.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -8.0,
            night_offset: -20.0,
        },
        _ => BuildingProfile {
            // default (residential)
            lw_fixed: 45.0,
            lw_per_m2: 15.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
    }
}

/// Compute building Lw from profile and building dimensions.
pub fn building_lw(profile: &BuildingProfile, area_m2: f64, floors: u8) -> f64 {
    let gfa = area_m2 * floors.max(1) as f64;
    let e_fixed = 10f64.powf(profile.lw_fixed / 10.0);
    let e_dist = gfa * 10f64.powf(profile.lw_per_m2 / 10.0);
    10.0 * (e_fixed + e_dist).log10()
}

/// Compute emission bands for a building (day period).
pub fn building_emission_bands(profile: &BuildingProfile, lw: f64) -> [f64; NUM_BANDS] {
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = lw + profile.spectrum[i];
    }
    bands
}

/// Max distance at which building is audible (inverse of free-field propagation).
pub fn building_max_dist(lw: f64) -> f64 {
    if lw < 25.0 {
        return 0.0;
    }
    // Lp(d) = Lw - 20·log₁₀(d) - 11 = 0 → d = 10^((Lw-11)/20)
    let d = 10f64.powf((lw - 11.0) / 20.0);
    d.min(2000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_residential_lw() {
        let p = building_profile(0);
        let lw = building_lw(&p, 200.0, 3);
        // GFA = 600 m². Lw_fixed=45, Lw_per_m2=15 → Lw = 10·log₁₀(10^4.5 + 600×10^1.5) ≈ 42.8
        assert!(lw > 35.0 && lw < 55.0, "residential: {:.1}", lw);
    }

    #[test]
    fn test_commercial_louder() {
        let rp = building_profile(0); // residential
        let cp = building_profile(1); // commercial
        let r_lw = building_lw(&rp, 500.0, 2);
        let c_lw = building_lw(&cp, 500.0, 2);
        assert!(
            c_lw > r_lw,
            "commercial ({:.1}) should be louder than residential ({:.1})",
            c_lw,
            r_lw
        );
    }

    #[test]
    fn test_max_dist() {
        assert_eq!(building_max_dist(20.0), 0.0); // too quiet
        let d = building_max_dist(50.0);
        assert!(d > 50.0 && d < 500.0, "d={:.0}", d);
        assert_eq!(building_max_dist(90.0), 2000.0); // capped
    }
}
