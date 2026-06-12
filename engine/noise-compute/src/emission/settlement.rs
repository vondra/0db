//! Settlement (building) noise emission — custom model (NOT standardized).
//!
//! Two-component Lw model:
//!   Lw = 10×log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))
//! where GFA = area_m² × floors
//!
//! Buildings pre-discretized at import (centroid or facade points).
//! This module computes emission for a single point source.
//!
//! Calibration (settlement v2 phase 1, 2026-06-12): constants are HONEST
//! radiated dB(A) — `a_weighted_total(building_emission_bands(p, lw)) == lw`.
//! Values anchored to measured plant/activity literature collected in
//! `.claude/plans/audit-2026-06/settlement-noise-v2-plan.md` §A/§C (dual
//! /gg-reviewed; per-class provenance inline below). The pre-v2 constants were
//! an uncalibrated heuristic kept alive by the C7 net-zero `AW_*` compensation;
//! that compensation is gone — do NOT reintroduce offsets here, band
//! normalization happens in `spectrum::normalized_emission_bands`.
//!
//! Known phase-1 limits (extract-side, fixed in phase 2 with re-extract):
//! `building_type` is a coarse u8 — houses and apartment blocks share type 0,
//! `building=supermarket` falls into the default, sheds/roofs/huts (18 M
//! objects) wrongly carry the residential profile, and POI nodes inside
//! `building=yes` footprints are not joined.

use crate::types::NUM_BANDS;

/// Building emission profile.
pub struct BuildingProfile {
    pub lw_fixed: f64,              // point sources (loading dock, HVAC unit) [dB]
    pub lw_per_m2: f64,             // distributed (facade breakout, HVAC per area) [dB/m²]
    pub spectrum: [f64; NUM_BANDS], // relative dB per band
    pub evening_offset: f64,        // dB (typically -3 to -10)
    pub night_offset: f64,          // dB (typically -2 to -25)
}

/// Get emission profile by building type.
///
/// Spectra: "LF" plant/HVAC peaks 63–250 Hz (diffracts well → carries far,
/// plan B10 — real building-services plant is LF-dominant, not the old
/// 500 Hz–2 kHz voice band); voices peak mid; bells/whistles HF.
pub fn building_profile(building_type: u8) -> BuildingProfile {
    match building_type {
        0 => BuildingProfile {
            // residential (houses AND apartment blocks until phase 2 splits them)
            // Anchor: 1 ASHP outdoor unit Lw 54–62 (Daikin EN14825; EU 813/2013
            // cap 65) running day+night → whole-house fixed term ≈ 57; night cut
            // −10 not −15 (heat pumps run hardest on winter nights; plan §A/§C).
            lw_fixed: 57.0,
            lw_per_m2: 21.0,
            spectrum: [-1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -10.0,
        },
        1 => BuildingProfile {
            // commercial/retail/office (coarse class — includes food retail
            // until phase 2). Anchor: AHU Lw 85–90, chillers 89–97 SPL@0.9m
            // (Guyer) → generic-mix plant ≈ Lw 70 fixed + strong area term.
            // Night −10 (NOT −20: part of the class is 24/7 refrigeration —
            // the worst single audit finding, B2; true food-retail −2 lands
            // with the phase-2 subtype).
            lw_fixed: 70.0,
            lw_per_m2: 30.0,
            spectrum: [-1.0, 1.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -10.0,
        },
        2 => BuildingProfile {
            // warehouse/industrial building — roof/facade breakout only
            // (outdoor yard activity = industrial layer, no double-count).
            // Anchor: plan §A Lw ~60 breakout; 24/7 DCs exist → night −8.
            lw_fixed: 58.0,
            lw_per_m2: 21.0,
            spectrum: [0.0, 1.0, 1.0, 0.0, -1.0, -2.0, -4.0, -7.0],
            evening_offset: -3.0,
            night_offset: -8.0,
        },
        3 => BuildingProfile {
            // school — yard shouting dominates (just-outside-yard 71.7 dB
            // during breaks, ~190 d/yr → 57 Leq annual at the fence, plan §A).
            // Term-time day-weekday source; deep evening/night cuts stay.
            lw_fixed: 66.0,
            lw_per_m2: 28.0,
            spectrum: [-2.0, 0.0, 1.0, 2.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -10.0,
            night_offset: -25.0,
        },
        4 => BuildingProfile {
            // hospital — 24/7 chillers/cooling towers (Lw to 103 for big
            // plants), gensets, A&E. Plan §A: campus plant ≈ Lw 72–80.
            lw_fixed: 72.0,
            lw_per_m2: 26.0,
            spectrum: [-1.0, 0.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -3.0,
            night_offset: -5.0, // 24/7 operation
        },
        5 => BuildingProfile {
            // church/worship — bells: ~110–125 dB at tower, annualized −20.8
            // (12 min/day) → ≈ Lw 89 IF the tower rings; many OSM churches
            // don't → fleet-average 72 fixed, PROP-MEAS (plan §A corrected
            // derivation; confirm bell share + Lw by measurement).
            lw_fixed: 72.0,
            lw_per_m2: 26.0,
            spectrum: [-3.0, -2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0],
            evening_offset: -5.0,
            night_offset: -20.0,
        },
        6 => BuildingProfile {
            // hotel — HVAC + kitchen extract (Lw 75–85 per unit, modest
            // whole-building mix → 58), 24/7 but quieter night.
            lw_fixed: 58.0,
            lw_per_m2: 22.0,
            spectrum: [-1.0, 0.0, 0.0, 1.0, 1.0, -1.0, -3.0, -6.0],
            evening_offset: -2.0,
            night_offset: -10.0,
        },
        7 => BuildingProfile {
            // garage/parking structure — vent fans; keep quiet (per-movement
            // parking noise belongs to the Parkplatzlärm lane, not here).
            lw_fixed: 41.0,
            lw_per_m2: 18.0,
            spectrum: [-3.0, -1.0, 0.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        8 => BuildingProfile {
            // farm building — livestock vent fans 30–80 dB(A) source,
            // summer-heavy (annualized into the constant), machinery.
            lw_fixed: 56.0,
            lw_per_m2: 20.0,
            spectrum: [-1.0, 0.0, 1.0, 0.0, -1.0, -2.0, -4.0, -7.0],
            evening_offset: -5.0,
            night_offset: -15.0,
        },
        9 => BuildingProfile {
            // public/civic — office-grade HVAC, day-centric.
            lw_fixed: 62.0,
            lw_per_m2: 25.0,
            spectrum: [-1.0, 0.0, 1.0, 1.0, 0.0, -1.0, -3.0, -6.0],
            evening_offset: -8.0,
            night_offset: -20.0,
        },
        _ => BuildingProfile {
            // default (residential) — also the `building=yes` 79 % + the
            // silent tail (sheds/roofs/huts) until the phase-2 re-extract.
            lw_fixed: 57.0,
            lw_per_m2: 21.0,
            spectrum: [-1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -3.0, -6.0],
            evening_offset: -5.0,
            night_offset: -10.0,
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
    use crate::propagation::iso9613::a_weighted_total;

    #[test]
    fn test_residential_lw() {
        let p = building_profile(0);
        let lw = building_lw(&p, 200.0, 3);
        // GFA = 600 m²: 10·log₁₀(10^5.7 + 600×10^2.1) ≈ 57.6 — the v2 phase-1
        // calibration (heat-pump-era fixed term 57 dominates a small house).
        assert!((lw - 57.61).abs() < 0.1, "residential: {:.2}", lw);
    }

    /// v2 phase-1 invariant: constants are honest radiated dB(A) — for EVERY
    /// class the normalized bands must A-sum back to the input lw exactly
    /// (the C7 normalization contract, now without any AW_* compensation).
    #[test]
    fn radiated_dba_equals_lw_for_all_classes() {
        for t in 0..=10u8 {
            let p = building_profile(t);
            let lw = building_lw(&p, 500.0, 2);
            let aw = a_weighted_total(&building_emission_bands(&p, lw));
            assert!(
                (aw - lw).abs() < 1e-6,
                "class {t}: radiated {aw:.6} != lw {lw:.6}"
            );
        }
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

    /// Night ordering encodes the v2 calibration's core finding: 24/7 plant
    /// classes (hospital −5, warehouse −8) cut far less than day-only classes
    /// (school −25); commercial is no longer "shut at night" (−10, was −20).
    #[test]
    fn night_offsets_follow_operating_patterns() {
        assert!(building_profile(4).night_offset > building_profile(3).night_offset);
        assert!(building_profile(2).night_offset > building_profile(9).night_offset);
        assert_eq!(building_profile(1).night_offset, -10.0);
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
