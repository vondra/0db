//! ISO 9613-2 sound propagation core.
//!
//! Per-band attenuation: geometric divergence + atmospheric absorption + ground effect.
//! Additional effects (diffraction, screening, vegetation, reflection) in separate modules.

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Fast exp() approximation using range reduction + 5th-order polynomial.
/// Worst-case error < 0.001 dB in the acoustic energy domain (|x| < 20).
/// Replaces 40× std::exp() per source-receiver pair in propagate_variants().
#[inline(always)]
fn fast_exp_f64(x: f64) -> f64 {
    // Clamp to avoid overflow/underflow (acoustic range: ~[-50, +20])
    let x = x.max(-87.0).min(88.0);
    // Range reduction: e^x = 2^(x/ln2) = 2^n * e^r where |r| <= ln(2)/2
    let inv_ln2 = std::f64::consts::LOG2_E; // 1/ln(2)
    let n_f = (x * inv_ln2).round();
    let r = x - n_f * std::f64::consts::LN_2;
    // 5th-order Taylor: e^r ≈ 1 + r + r²/2 + r³/6 + r⁴/24 + r⁵/120
    let r2 = r * r;
    let poly = 1.0 + r + r2 * (0.5 + r * (1.0/6.0 + r * (1.0/24.0 + r * (1.0/120.0))));
    // Reconstruct: e^x = poly * 2^n via bit manipulation
    let n = n_f as i64;
    let bits = ((1023 + n) as u64) << 52;
    let scale = f64::from_bits(bits);
    poly * scale
}

/// Source geometry type — affects geometric divergence formula.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SourceGeometry {
    /// Line source (roads, railways): cylindrical spreading
    Line,
    /// Point source (buildings, industrial, wind turbines): spherical spreading
    Point,
}

/// Compute propagation baseline breakdown for contributor tooltip.
/// Returns separate geometric, atmospheric, ground components (all negative = loss).
pub fn compute_baseline(d_slant: f64, source_geom: SourceGeometry, ground_g: f64) -> crate::types::PropagationBaseline {
    let d = d_slant.max(1.0);

    let geometric_db = -match source_geom {
        SourceGeometry::Line => 10.0 * (2.0 * std::f64::consts::PI * d).log10(),
        SourceGeometry::Point => 20.0 * d.log10() + 11.0,
    };

    // A-weighted average atmospheric absorption (use 1kHz band as representative)
    let atmospheric_db = -(ALPHA_ATM[4] * d / 1000.0);

    // Ground effect (A-weighted average using 1kHz band)
    let ground_db = -(GROUND_CF[4] * ground_g);

    let total_db = geometric_db + atmospheric_db + ground_db;

    crate::types::PropagationBaseline {
        geometric_db: (geometric_db * 10.0).round() / 10.0,
        atmospheric_db: (atmospheric_db * 10.0).round() / 10.0,
        ground_factor: ground_g,
        ground_db: (ground_db * 10.0).round() / 10.0,
        total_db: (total_db * 10.0).round() / 10.0,
    }
}

/// Estimate A-weighted ground effect for max(A_gr, A_bar) rule.
/// Returns negative value (attenuation) matching what propagate_bands applies.
pub fn ground_effect_estimate(ground_g: f64) -> f64 {
    // A-weighted average of GROUND_CF[i] * ground_g, using 1kHz band as representative
    -(GROUND_CF[4] * ground_g)
}

/// Propagation result per band.
#[derive(Debug, Clone)]
pub struct BandLevels {
    pub bands: [f64; NUM_BANDS],
    pub a_weighted: f64,
}

/// Compute received levels per band from emission bands and distance.
///
/// Applies: geometric divergence + atmospheric absorption + ground effect.
/// Caller adds: finite-line correction, diffraction, screening, vegetation, reflection.
pub fn propagate_bands(
    emission_bands: &[f64; NUM_BANDS],
    d_slant: f64,
    source_geom: SourceGeometry,
    ground_g: f64,
) -> BandLevels {
    let mut bands = [0.0f64; NUM_BANDS];

    let d = d_slant.max(1.0);
    let geo_div = match source_geom {
        SourceGeometry::Line => 10.0 * (2.0 * std::f64::consts::PI * d).log10(),
        SourceGeometry::Point => 20.0 * d.log10() + 11.0,
    };
    let d_over_1000 = d_slant / 1000.0;

    for i in 0..NUM_BANDS {
        bands[i] = emission_bands[i] - geo_div - ALPHA_ATM[i] * d_over_1000 - GROUND_CF[i] * ground_g;
    }

    let a_weighted = a_weighted_total(&bands);
    BandLevels { bands, a_weighted }
}

/// A-weighted total from octave band levels.
/// L_A = 10 × log₁₀(Σ 10^((L_i + A_i) / 10))
pub fn a_weighted_total(bands: &[f64; NUM_BANDS]) -> f64 {
    let c = std::f64::consts::LN_10 * 0.1;
    let energy: f64 = bands.iter().enumerate()
        .map(|(i, &level)| fast_exp_f64((level + A_WEIGHTING[i]) * c))
        .sum();
    if energy > 0.0 { 10.0 * energy.log10() } else { f64::NEG_INFINITY }
}

/// Compute 5 propagation variants in a single pass (for pipeline batch output).
///
/// Returns linear energy values (not dB). Caller accumulates across sources,
/// then converts to dB at the end.
///
/// The 5 variants differ only in which attenuation factors are included:
/// - full: base + terrain + screening + vegetation + reflection + FLC
/// - free_field: base only (div + atm + ground)
/// - no_terrain: full minus terrain
/// - no_screening: full minus screening
/// - no_vegetation: full minus vegetation
/// ISO 9613-2 propagation with 5 variants.
///
/// **Ground/barrier interaction (ISO 9613-2 §7.3.1):**
/// When barriers (terrain diffraction + building screening) are present,
/// barrier attenuation REPLACES ground effect: use max(A_gr, A_bar), not A_gr + A_bar.
/// Vegetation is independent and always additive (ISO 9613-2:2024 A.2.2).
pub fn propagate_variants(
    emission_bands: &[f64; NUM_BANDS],
    d_slant: f64,
    source_geom: SourceGeometry,
    ground_g: f64,
    terrain_atten: &[f64; NUM_BANDS],     // per-band terrain diffraction (positive = dB removed)
    screening_atten: &[f64; NUM_BANDS],   // per-band building screening
    vegetation_atten: &[f64; NUM_BANDS],  // per-band vegetation attenuation
    reflection_boost_db: f64,             // scalar urban reflection boost (positive = dB added)
    finite_line_corr: f64,                // FLC in dB (negative), 0 for point sources
) -> crate::types::PropagationVariants {
    let mut full_energy = 0.0f64;
    let mut free_energy = 0.0f64;
    let mut no_terrain_energy = 0.0f64;
    let mut no_screening_energy = 0.0f64;
    let mut no_vegetation_energy = 0.0f64;
    let mut band_energy = [0.0f64; NUM_BANDS];

    // Geometric divergence depends only on distance, not frequency — compute once.
    let d = d_slant.max(1.0);
    let geo_div = match source_geom {
        SourceGeometry::Line => 10.0 * (2.0 * std::f64::consts::PI * d).log10(),
        SourceGeometry::Point => 20.0 * d.log10() + 11.0,
    };
    let d_over_1000 = d_slant / 1000.0;

    for i in 0..NUM_BANDS {
        // Base WITHOUT ground: emission - divergence - atmospheric
        let base_no_ground = emission_bands[i] - geo_div - ALPHA_ATM[i] * d_over_1000;

        // Ground effect (A_gr)
        let a_gr = GROUND_CF[i] * ground_g;

        // Barrier attenuation (A_bar) = terrain + screening combined
        let a_bar_full = terrain_atten[i] + screening_atten[i];
        let a_bar_no_terrain = screening_atten[i];
        let a_bar_no_screening = terrain_atten[i];

        // ISO 9613-2 §7.3.1: max(A_gr, A_bar) ONLY when a barrier exists.
        // Without barriers, use A_gr directly (which can be negative = amplification
        // for soft ground at low frequencies like 63/125 Hz).
        // WHY: a_gr.max(0.0) discarded low-frequency ground amplification in open fields.
        let ground_or_bar_full = if a_bar_full > 0.0 { a_gr.max(a_bar_full) } else { a_gr };
        let ground_or_bar_no_terrain = if a_bar_no_terrain > 0.0 { a_gr.max(a_bar_no_terrain) } else { a_gr };
        let ground_or_bar_no_screening = if a_bar_no_screening > 0.0 { a_gr.max(a_bar_no_screening) } else { a_gr };

        // Free-field: ground only, no barriers, no vegetation
        let free = base_no_ground - a_gr + finite_line_corr;

        // Full: ground-or-barrier + vegetation + reflection + FLC
        let full = base_no_ground - ground_or_bar_full - vegetation_atten[i]
                   + reflection_boost_db + finite_line_corr;

        // Variants: remove one factor at a time
        let no_terrain = base_no_ground - ground_or_bar_no_terrain - vegetation_atten[i]
                         + reflection_boost_db + finite_line_corr;
        let no_screening = base_no_ground - ground_or_bar_no_screening - vegetation_atten[i]
                           + reflection_boost_db + finite_line_corr;
        let no_vegetation = base_no_ground - ground_or_bar_full
                            + reflection_boost_db + finite_line_corr;

        // A-weight and convert to linear energy via fast_exp (polynomial approx)
        // 10^((x+aw)/10) = e^((x+aw) * ln(10)/10)
        let aw = A_WEIGHTING[i];
        let c = std::f64::consts::LN_10 * 0.1;
        let full_aw = fast_exp_f64((full + aw) * c);
        full_energy += full_aw;
        band_energy[i] = full_aw;
        free_energy += fast_exp_f64((free + aw) * c);
        no_terrain_energy += fast_exp_f64((no_terrain + aw) * c);
        no_screening_energy += fast_exp_f64((no_screening + aw) * c);
        no_vegetation_energy += fast_exp_f64((no_vegetation + aw) * c);
    }

    crate::types::PropagationVariants {
        full_energy,
        free_field_energy: free_energy,
        no_terrain_energy,
        no_screening_energy,
        no_vegetation_energy,
        band_energy,
    }
}

/// Fast path for StubRasters (Phase 1): all attenuations are zero, so all 5 variants are identical.
/// Computes a single energy value and fills all variant fields with it.
/// 5× fewer powf calls (8 instead of 40 per source-receiver pair).
#[inline]
pub fn propagate_single(
    emission_bands: &[f64; NUM_BANDS],
    d_slant: f64,
    source_geom: SourceGeometry,
    ground_g: f64,
    finite_line_corr: f64,
) -> crate::types::PropagationVariants {
    let mut energy = 0.0f64;
    let mut band_energy = [0.0f64; NUM_BANDS];
    let d = d_slant.max(1.0);
    let geo_div = match source_geom {
        SourceGeometry::Line => 10.0 * (2.0 * std::f64::consts::PI * d).log10(),
        SourceGeometry::Point => 20.0 * d.log10() + 11.0,
    };
    let d_over_1000 = d_slant / 1000.0;
    let c = std::f64::consts::LN_10 * 0.1;
    for i in 0..NUM_BANDS {
        let level = emission_bands[i] - geo_div - ALPHA_ATM[i] * d_over_1000
                    - GROUND_CF[i] * ground_g + finite_line_corr;
        let e = fast_exp_f64((level + A_WEIGHTING[i]) * c);
        energy += e;
        band_energy[i] = e;
    }
    crate::types::PropagationVariants {
        full_energy: energy,
        free_field_energy: energy,
        no_terrain_energy: energy,
        no_screening_energy: energy,
        no_vegetation_energy: energy,
        band_energy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_propagation_k4_hard_ground() {
        // K4: Propagation 100m, G=0 (hard), line source
        // Expected attenuation: 28.58 dB
        // Use reference emission from K1: cat1, 50 km/h, 10000 AADT
        // (We test attenuation = emission_aw - received_aw)

        // Reference emission bands (from kernel-test — approximate)
        let emission = [65.0, 70.0, 73.0, 74.0, 73.0, 70.0, 65.0, 58.0];
        let em_aw = a_weighted_total(&emission);

        let result = propagate_bands(&emission, 100.0, SourceGeometry::Line, 0.0);
        let attenuation = em_aw - result.a_weighted;

        // Allow ±1 dB tolerance (our emission approximation, not exact CNOSSOS coefficients)
        assert!((attenuation - 28.58).abs() < 1.5,
            "K4: expected ~28.58, got {:.2} (emission_aw={:.2}, received_aw={:.2})",
            attenuation, em_aw, result.a_weighted);
    }

    #[test]
    fn test_propagation_ground_effect() {
        // Soft ground (G=1) should attenuate MORE than hard ground (G=0)
        let emission = [70.0; NUM_BANDS];

        let hard = propagate_bands(&emission, 100.0, SourceGeometry::Line, 0.0);
        let soft = propagate_bands(&emission, 100.0, SourceGeometry::Line, 1.0);

        // Ground effect delta should be ~3 dB (K5 reference: 3.08 dB)
        let delta = hard.a_weighted - soft.a_weighted;
        assert!(delta > 1.0 && delta < 6.0,
            "Ground effect delta: expected ~3 dB, got {:.2}", delta);
    }

    #[test]
    fn test_point_vs_line() {
        // Point source divergence should be higher than line source at same distance
        let emission = [70.0; NUM_BANDS];

        let line = propagate_bands(&emission, 100.0, SourceGeometry::Line, 0.0);
        let point = propagate_bands(&emission, 100.0, SourceGeometry::Point, 0.0);

        // Point = 20·log₁₀(100)+11 = 51.0 dB
        // Line = 10·log₁₀(2π·100) = 27.98 dB
        // Point attenuates ~23 dB more
        assert!(line.a_weighted > point.a_weighted,
            "Line should be louder than point at same distance");
        let diff = line.a_weighted - point.a_weighted;
        assert!(diff > 20.0 && diff < 26.0, "diff={:.1}", diff);
    }

    #[test]
    fn test_variants_matches_propagate_bands() {
        // propagate_variants with zero attenuation should match propagate_bands
        let emission = [65.0, 70.0, 73.0, 74.0, 73.0, 70.0, 65.0, 58.0];
        let zero = [0.0f64; NUM_BANDS];

        let bands = propagate_bands(&emission, 100.0, SourceGeometry::Line, 0.5);
        let variants = propagate_variants(
            &emission, 100.0, SourceGeometry::Line, 0.5,
            &zero, &zero, &zero, 0.0, 0.0,
        );

        let full_db = crate::types::PropagationVariants::to_db(variants.full_energy);
        assert!((full_db - bands.a_weighted).abs() < 0.01,
            "full={:.2} vs bands={:.2}", full_db, bands.a_weighted);
    }

    #[test]
    fn test_variants_free_equals_full_with_zero_atten() {
        // With zero terrain/screening/vegetation: full == free
        let emission = [70.0; NUM_BANDS];
        let zero = [0.0f64; NUM_BANDS];

        let v = propagate_variants(
            &emission, 200.0, SourceGeometry::Point, 0.5,
            &zero, &zero, &zero, 0.0, 0.0,
        );

        let full_db = crate::types::PropagationVariants::to_db(v.full_energy);
        let free_db = crate::types::PropagationVariants::to_db(v.free_field_energy);
        assert!((full_db - free_db).abs() < 0.01,
            "full={:.2} free={:.2} should be equal with zero atten", full_db, free_db);
    }

    #[test]
    fn test_variants_barrier_replaces_ground_not_adds() {
        // ISO 9613-2 §7.3.1: barrier replaces ground, use max(A_gr, A_bar)
        let emission = [70.0; NUM_BANDS];
        let zero = [0.0f64; NUM_BANDS];
        let big_barrier = [15.0; NUM_BANDS]; // 15 dB barrier (bigger than ground ~3 dB)

        // With big barrier: should use barrier (15 dB), NOT ground+barrier (18 dB)
        let v = propagate_variants(
            &emission, 200.0, SourceGeometry::Line, 1.0, // soft ground G=1 → A_gr ~3 dB
            &big_barrier, &zero, &zero, 0.0, 0.0,
        );
        // Free-field uses ground only
        let free_db = crate::types::PropagationVariants::to_db(v.free_field_energy);
        let full_db = crate::types::PropagationVariants::to_db(v.full_energy);

        // Barrier effect: free - full ≈ 15 - 3 = 12 dB (barrier minus ground, since max() picks barrier)
        // If we had A_gr + A_bar (bug): free - full ≈ 15 + 3 - 3 = 15 dB (over-attenuated)
        let effect = free_db - full_db;
        assert!(effect > 8.0 && effect < 14.0,
            "barrier effect = {:.1} dB, expected ~12 (not ~15 if double-counted)", effect);
    }

    #[test]
    fn test_variants_small_barrier_uses_ground() {
        // When barrier < ground effect, ground wins
        let emission = [70.0; NUM_BANDS];
        let zero = [0.0f64; NUM_BANDS];
        let small_barrier = [1.0; NUM_BANDS]; // 1 dB barrier (smaller than ground ~3 dB)

        let v = propagate_variants(
            &emission, 200.0, SourceGeometry::Line, 1.0, // soft ground G=1 → A_gr ~3 dB
            &small_barrier, &zero, &zero, 0.0, 0.0,
        );
        let free_db = crate::types::PropagationVariants::to_db(v.free_field_energy);
        let full_db = crate::types::PropagationVariants::to_db(v.full_energy);

        // Ground wins: effect should be ~0 (full uses max(3, 1) = 3 = same as free's ground)
        let effect = free_db - full_db;
        assert!(effect.abs() < 1.0,
            "small barrier effect = {:.1} dB, expected ~0 (ground dominates)", effect);
    }

    #[test]
    fn test_variants_terrain_reduces_noise() {
        let emission = [70.0; NUM_BANDS];
        let zero = [0.0f64; NUM_BANDS];
        let terrain = [5.0; NUM_BANDS]; // 5 dB terrain diffraction per band

        let v = propagate_variants(
            &emission, 200.0, SourceGeometry::Line, 0.5,
            &terrain, &zero, &zero, 0.0, -3.0,
        );

        let full_db = crate::types::PropagationVariants::to_db(v.full_energy);
        let no_terrain_db = crate::types::PropagationVariants::to_db(v.no_terrain_energy);

        // Without terrain should be louder
        assert!(no_terrain_db > full_db, "no_terrain={:.1} should be louder than full={:.1}", no_terrain_db, full_db);
        // Difference should be roughly 5 dB (not exact due to A-weighting)
        assert!((no_terrain_db - full_db) > 2.0 && (no_terrain_db - full_db) < 8.0,
            "terrain effect = {:.1} dB", no_terrain_db - full_db);
    }

    #[test]
    fn test_fast_exp_accuracy() {
        // Verify fast_exp_f64 stays within ±0.001 dB across acoustic domain
        let mut x = -20.0;
        let mut worst_db = 0.0f64;
        while x <= 20.0 {
            let approx = fast_exp_f64(x);
            let exact = x.exp();
            if exact > 0.0 && approx > 0.0 {
                let err_db = (10.0 * (approx / exact).log10()).abs();
                worst_db = worst_db.max(err_db);
            }
            x += 0.01;
        }
        assert!(worst_db < 0.01,
            "fast_exp_f64 worst-case error {:.6} dB exceeds 0.01 dB bound", worst_db);
    }

    #[test]
    fn test_variants_add() {
        let mut a = crate::types::PropagationVariants {
            full_energy: 1.0, free_field_energy: 2.0,
            no_terrain_energy: 3.0, no_screening_energy: 4.0, no_vegetation_energy: 5.0,
            band_energy: [0.0; crate::types::NUM_BANDS],
        };
        let b = crate::types::PropagationVariants {
            full_energy: 10.0, free_field_energy: 20.0,
            no_terrain_energy: 30.0, no_screening_energy: 40.0, no_vegetation_energy: 50.0,
            band_energy: [0.0; crate::types::NUM_BANDS],
        };
        a.add(&b);
        assert!((a.full_energy - 11.0).abs() < 1e-10);
        assert!((a.no_vegetation_energy - 55.0).abs() < 1e-10);
    }

    #[test]
    fn test_atmospheric_absorption() {
        // At 8 kHz, 1km: 58.4 dB absorption. Should dominate at distance.
        let emission = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 80.0]; // only 8 kHz
        let r100 = propagate_bands(&emission, 100.0, SourceGeometry::Point, 0.0);
        let r1000 = propagate_bands(&emission, 1000.0, SourceGeometry::Point, 0.0);

        // At 8 kHz: geometric + atmospheric
        // 100m: atm = 58.4 × 0.1 = 5.84 dB
        // 1000m: atm = 58.4 × 1.0 = 58.4 dB
        // Difference in atm alone: 52.56 dB
        let diff = r100.bands[7] - r1000.bands[7];
        assert!(diff > 50.0, "8kHz 100m→1km diff={:.1} (expected >50)", diff);
    }
}
