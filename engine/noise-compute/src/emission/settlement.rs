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

// Per-spectrum-shape A-weighted offsets: `a_weighted_total(spectrum)` with the
// relative spectrum treated as absolute band levels. Full-f64 values printed
// from the runtime function on the pre-C7 tree (5f1b969f) so the compensation
// below cancels the normalization bit-exactly.
const AW_RESIDENTIAL: f64 = 6.413343012075016; // [-2,-1,0,1,1,0,-2,-5] (also hotel, default)
const AW_COMMERCIAL: f64 = 7.049099243870941; // [-3,-1,0,1,1,1,-1,-3]
const AW_WAREHOUSE: f64 = 5.599199408851733; // [-4,-2,0,1,0,-1,-3,-6] (also farm)
const AW_SCHOOL: f64 = 6.604288486468003; // [-2,0,1,2,1,0,-2,-5]
const AW_HOSPITAL: f64 = 6.475626690346978; // [-3,-1,0,1,1,0,-2,-4] (also public)
const AW_CHURCH: f64 = 6.413034239102395; // [-3,-1,0,1,1,0,-2,-5]
const AW_GARAGE: f64 = 5.604290014558924; // [-3,-1,0,1,0,-1,-3,-6]

/// Get emission profile by building type.
///
/// Net-zero compensation (audit 2026-06 B4+B6, /gg verdict W7): every class
/// carries `base + AW_*` — the same spectrum offset that
/// `spectrum::normalized_emission_bands` now subtracts. Pre-C7 the bands hid
/// that surplus, so a building radiated `base + offset` dB(A) while claiming
/// `base`; post-C7 `lw` is the honest radiated dB(A) and the radiated energy
/// is unchanged. WHY net-zero instead of a recalibration: the settlement
/// model is a custom heuristic that was never calibrated against
/// measurements, so this wave only fixes the units — the real recalibration
/// (likely several dB down, audit building-report) is backlog C8a.
///
/// base lw_fixed/lw_per_m2 → effective (bump): residential 45/15 →
/// 51.41/21.41 (+6.4133), commercial 55/20 → 62.05/27.05 (+7.0491),
/// warehouse 40/15 → 45.60/20.60 (+5.5992), school 60/22 → 66.60/28.60
/// (+6.6043), hospital 50/18 → 56.48/24.48 (+6.4756), church 50/20 →
/// 56.41/26.41 (+6.4130), hotel 48/16 → 54.41/22.41 (+6.4133), garage 35/12
/// → 40.60/17.60 (+5.6043), farm 40/14 → 45.60/19.60 (+5.5992), public 52/18
/// → 58.48/24.48 (+6.4756), default = residential.
pub fn building_profile(building_type: u8) -> BuildingProfile {
    match building_type {
        0 => BuildingProfile {
            // residential
            lw_fixed: 45.0 + AW_RESIDENTIAL,
            lw_per_m2: 15.0 + AW_RESIDENTIAL,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        1 => BuildingProfile {
            // commercial
            lw_fixed: 55.0 + AW_COMMERCIAL,
            lw_per_m2: 20.0 + AW_COMMERCIAL,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 1.0, -1.0, -3.0],
            evening_offset: -3.0,
            night_offset: -20.0,
        },
        2 => BuildingProfile {
            // warehouse/industrial building — HVAC, ventilation, handling
            // WHY: Was Lw=0 (silent). But warehouses have ventilation, HVAC, loading activity.
            // Industrial landuse polygon = outdoor activity; building = facade/roof breakout.
            // Both contribute — NOT double counting (different physical noise sources).
            lw_fixed: 40.0 + AW_WAREHOUSE,
            lw_per_m2: 15.0 + AW_WAREHOUSE,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        3 => BuildingProfile {
            // school
            lw_fixed: 60.0 + AW_SCHOOL,
            lw_per_m2: 22.0 + AW_SCHOOL,
            spectrum: [-2.0, 0.0, 1.0, 2.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -10.0,
            night_offset: -25.0,
        },
        4 => BuildingProfile {
            // hospital
            lw_fixed: 50.0 + AW_HOSPITAL,
            lw_per_m2: 18.0 + AW_HOSPITAL,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -3.0,
            night_offset: -5.0, // 24/7 operation
        },
        5 => BuildingProfile {
            // church/worship — bells, organ, gatherings
            lw_fixed: 50.0 + AW_CHURCH,
            lw_per_m2: 20.0 + AW_CHURCH,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        6 => BuildingProfile {
            // hotel
            lw_fixed: 48.0 + AW_RESIDENTIAL,
            lw_per_m2: 16.0 + AW_RESIDENTIAL,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -2.0,
            night_offset: -10.0,
        },
        7 => BuildingProfile {
            // garage/parking — ventilation fans, engine starts
            lw_fixed: 35.0 + AW_GARAGE,
            lw_per_m2: 12.0 + AW_GARAGE,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        8 => BuildingProfile {
            // farm building — animals, machinery, seasonal
            lw_fixed: 40.0 + AW_WAREHOUSE,
            lw_per_m2: 14.0 + AW_WAREHOUSE,
            spectrum: [-4.0, -2.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        9 => BuildingProfile {
            // public/civic/government — office HVAC, visitor traffic
            lw_fixed: 52.0 + AW_HOSPITAL,
            lw_per_m2: 18.0 + AW_HOSPITAL,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -8.0,
            night_offset: -20.0,
        },
        _ => BuildingProfile {
            // default (residential)
            lw_fixed: 45.0 + AW_RESIDENTIAL,
            lw_per_m2: 15.0 + AW_RESIDENTIAL,
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

/// Compute emission bands for a building (day period), normalized so
/// `a_weighted_total(bands) == lw`.
pub fn building_emission_bands(profile: &BuildingProfile, lw: f64) -> [f64; NUM_BANDS] {
    super::spectrum::normalized_emission_bands(lw, &profile.spectrum)
}

/// Max distance at which building is audible (inverse of free-field propagation).
/// Lp(d) = Lw - 20·log₁₀(d) - 11 = 0 → d = 10^((Lw-11)/20).
pub fn building_max_dist(lw: f64) -> f64 {
    10f64.powf((lw - 11.0) / 20.0).min(2000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_residential_lw() {
        let p = building_profile(0);
        let lw = building_lw(&p, 200.0, 3);
        // GFA = 600 m², effective Lw_fixed=51.41, Lw_per_m2=21.41
        // → Lw = 10·log₁₀(10^5.141 + 600×10^2.141) ≈ 53.5 (honest dB(A) total)
        assert!(lw > 45.0 && lw < 60.0, "residential: {:.1}", lw);
    }

    /// W7 net-zero pin: the compensated class constants + band normalization
    /// must radiate exactly what the pre-C7 code radiated. 53.454543656970074
    /// = `a_weighted_total(building_emission_bands(...))` for residential at
    /// 200 m² × 3 floors, measured on the pre-C7 tree (5f1b969f: lw_old
    /// 47.04119982655925 + hidden spectrum surplus 6.413343012075016).
    /// Tolerance 1e-5 covers the ~1e-6 dB `fast_exp_f64` shift-variance the
    /// old un-normalized path carried (the new path corrects it away).
    #[test]
    fn building_radiated_dba_unchanged_by_normalization() {
        let p = building_profile(0);
        let lw = building_lw(&p, 200.0, 3);
        let aw = crate::propagation::iso9613::a_weighted_total(&building_emission_bands(&p, lw));
        assert!(
            (aw - 53.454543656970074).abs() < 1e-5,
            "settlement net-zero broken: {:.12}",
            aw
        );
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
        // Very quiet: d < R11 pixel pitch → invisible on heatmap but not rejected.
        let d_quiet = building_max_dist(20.0);
        assert!(d_quiet > 0.0 && d_quiet < 5.0, "quiet d={:.2}", d_quiet);
        let d = building_max_dist(50.0);
        assert!(d > 50.0 && d < 500.0, "d={:.0}", d);
        assert_eq!(building_max_dist(90.0), 2000.0); // capped
    }
}
