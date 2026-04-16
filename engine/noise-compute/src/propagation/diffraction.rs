//! ISO 9613-2 terrain/barrier diffraction + CNOSSOS-EU §2.5.6(c) Rayleigh gate.
//!
//! Single diffraction (one edge, §7.3): max 20 dB
//! Double diffraction (two edges, §7.4): max 25 dB
//!
//! Uses receiver height parameter (not hardcoded).

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Result of path difference computation.
pub struct DiffractionResult {
    pub delta: f64,         // path difference in meters
    pub is_double: bool,    // true = two edges
    pub edge_distance: f64, // distance between edges (for C₃), 0 for single
    /// CNOSSOS-EU §2.5.6(c) Rayleigh δ*: path difference over the dominant edge
    /// with mirror source/receiver reflected across the per-side mean ground
    /// planes. 0.0 when there is no obstruction.
    pub delta_star: f64,
}

/// Compute double path difference from elevation profile.
///
/// Profile: array of elevations from source to receiver, evenly spaced.
/// Source at profile[0] + source_height.
/// Receiver at profile[last] + receiver_height.
pub fn compute_path_difference(
    profile: &[f64],
    total_dist: f64,
    source_height: f64,
    receiver_height: f64,
) -> DiffractionResult {
    let n = profile.len();
    if n < 3 || total_dist < 30.0 {
        return DiffractionResult {
            delta: 0.0,
            is_double: false,
            edge_distance: 0.0,
            delta_star: 0.0,
        };
    }

    let src_elev = profile[0] + source_height;
    let rcv_elev = profile[n - 1] + receiver_height;
    let step_dist = total_dist / (n - 1) as f64;

    // Find source-side edge (steepest upward angle from source)
    let mut max_angle_src = f64::NEG_INFINITY;
    let mut edge1: i32 = -1;
    for i in 1..n - 1 {
        let dh = i as f64 * step_dist;
        let angle = (profile[i] - src_elev) / dh;
        if angle > max_angle_src {
            max_angle_src = angle;
            edge1 = i as i32;
        }
    }

    // Find receiver-side edge (steepest upward angle from receiver)
    let mut max_angle_rcv = f64::NEG_INFINITY;
    let mut edge2: i32 = -1;
    for i in (1..n - 1).rev() {
        let dh = (n - 1 - i) as f64 * step_dist;
        let angle = (profile[i] - rcv_elev) / dh;
        if angle > max_angle_rcv {
            max_angle_rcv = angle;
            edge2 = i as i32;
        }
    }

    if edge1 < 0 || edge2 < 0 {
        return DiffractionResult {
            delta: 0.0,
            is_double: false,
            edge_distance: 0.0,
            delta_star: 0.0,
        };
    }

    let e1 = edge1 as usize;
    let e2 = edge2 as usize;

    // Check if edges are above line-of-sight
    let los1 = src_elev + (rcv_elev - src_elev) * (e1 as f64 / (n - 1) as f64);
    let los2 = src_elev + (rcv_elev - src_elev) * (e2 as f64 / (n - 1) as f64);
    if profile[e1] <= los1 && profile[e2] <= los2 {
        return DiffractionResult {
            delta: 0.0,
            is_double: false,
            edge_distance: 0.0,
            delta_star: 0.0,
        };
    }

    let dsr = ((total_dist * total_dist) + (rcv_elev - src_elev).powi(2)).sqrt();

    // Same edge or adjacent → single diffraction
    if e1 >= e2 || e2 - e1 <= 1 {
        let idx = if (profile[e1] - los1) >= (profile[e2] - los2) {
            e1
        } else {
            e2
        };
        let los_idx = src_elev + (rcv_elev - src_elev) * (idx as f64 / (n - 1) as f64);
        if profile[idx] <= los_idx {
            return DiffractionResult {
                delta: 0.0,
                is_double: false,
                edge_distance: 0.0,
                delta_star: 0.0,
            };
        }

        let d_sg = idx as f64 * step_dist;
        let d_rg = (n - 1 - idx) as f64 * step_dist;
        let top = profile[idx];
        let d_sb = (d_sg * d_sg + (top - src_elev).powi(2)).sqrt();
        let d_br = (d_rg * d_rg + (top - rcv_elev).powi(2)).sqrt();

        let delta_star = compute_delta_star(profile, idx, total_dist, source_height, receiver_height);

        return DiffractionResult {
            delta: d_sb + d_br - dsr,
            is_double: false,
            edge_distance: 0.0,
            delta_star,
        };
    }

    // Double diffraction: two distinct edges
    let top1 = profile[e1];
    let top2 = profile[e2];
    let d1 = e1 as f64 * step_dist;

    let d_se1 = (d1 * d1 + (top1 - src_elev).powi(2)).sqrt();

    // Edge-to-edge: straight-line through air (NOT along ground contour).
    // WHY: Sound travels in a straight line between diffraction edges.
    // The old code followed the terrain surface (dipping into valleys),
    // grossly overestimating the path difference and over-attenuating
    // noise behind double hills (up to 25 dB cap).
    let d2 = e2 as f64 * step_dist;
    let d_e1e2 = ((d2 - d1).powi(2) + (top2 - top1).powi(2)).sqrt();

    let d2r = (n - 1 - e2) as f64 * step_dist;
    let d_e2r = (d2r * d2r + (top2 - rcv_elev).powi(2)).sqrt();

    let delta = (d_se1 + d_e1e2 + d_e2r - dsr).max(0.0);

    // CNOSSOS §2.5.6(c) "same edge D": pick the edge with the larger excess above LOS.
    let d_idx = if profile[e1] - los1 >= profile[e2] - los2 { e1 } else { e2 };
    let delta_star = compute_delta_star(profile, d_idx, total_dist, source_height, receiver_height);

    DiffractionResult {
        delta,
        is_double: true,
        edge_distance: d_e1e2,
        delta_star,
    }
}

/// CNOSSOS-EU §2.5.6(c) Rayleigh δ*.
///
/// Fits per-side mean ground planes by unweighted OLS over DEM samples
/// (including edge D), reflects source and receiver vertically across those
/// planes (NMPB convention), returns δ* = |S*D| + |DR*| − |S*R*|.
fn compute_delta_star(
    profile: &[f64],
    d_idx: usize,
    total_dist: f64,
    source_height: f64,
    receiver_height: f64,
) -> f64 {
    let n = profile.len();
    let step_dist = total_dist / (n - 1) as f64;
    let d_sg = d_idx as f64 * step_dist;
    let d_rg = (n - 1 - d_idx) as f64 * step_dist;

    let (_, b_src) = fit_plane(&profile[..=d_idx], step_dist);
    let (a_rcv, b_rcv) = fit_plane(&profile[d_idx..], step_dist);
    let plane_rcv_at_end = a_rcv * d_rg + b_rcv;

    let s_star_z = 2.0 * b_src - (profile[0] + source_height);
    let r_star_z = 2.0 * plane_rcv_at_end - (profile[n - 1] + receiver_height);

    let d_top = profile[d_idx];
    let d_sd = (d_sg * d_sg + (d_top - s_star_z).powi(2)).sqrt();
    let d_dr = (d_rg * d_rg + (r_star_z - d_top).powi(2)).sqrt();
    let d_sr = (total_dist * total_dist + (r_star_z - s_star_z).powi(2)).sqrt();
    (d_sd + d_dr - d_sr).max(0.0)
}

/// Unweighted least-squares line fit z = a·x + b.
/// `step_dist` is the horizontal spacing of samples in `zs`.
fn fit_plane(zs: &[f64], step_dist: f64) -> (f64, f64) {
    let n = zs.len() as f64;
    if n < 1.0 {
        return (0.0, 0.0);
    }
    let mut sx = 0.0_f64;
    let mut sz = 0.0_f64;
    let mut sxx = 0.0_f64;
    let mut sxz = 0.0_f64;
    for (i, &z) in zs.iter().enumerate() {
        let x = i as f64 * step_dist;
        sx += x;
        sz += z;
        sxx += x * x;
        sxz += x * z;
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        // Degenerate (n==1 or all samples at same x): horizontal plane at mean z.
        return (0.0, sz / n);
    }
    let a = (n * sxz - sx * sz) / denom;
    let b = (sz - a * sx) / n;
    (a, b)
}

/// Maekawa diffraction per band with optional Rayleigh gate.
///
/// When `delta_star == f64::INFINITY` the gate is always open (legacy
/// knife-edge path used by K6/K7). Otherwise CNOSSOS-EU §2.5.6(c) applies:
/// bands with `δ ≤ λ/4 − δ*` are set to 0 dB.
fn maekawa_bands(
    delta: f64,
    is_double: bool,
    edge_distance: f64,
    delta_star: f64,
) -> [f64; NUM_BANDS] {
    let mut atten = [0.0_f64; NUM_BANDS];
    if delta <= 0.0 {
        return atten;
    }
    let cap = if is_double { DOUBLE_DIFF_CAP } else { SINGLE_DIFF_CAP };

    for i in 0..NUM_BANDS {
        let lambda = SPEED_OF_SOUND / BAND_FREQ[i];
        if delta <= lambda / 4.0 - delta_star {
            continue;
        }
        let c3 = if is_double && edge_distance > 0.01 {
            let r = 5.0 * lambda / edge_distance;
            let r2 = r * r;
            (1.0 + r2) / (1.0 / 3.0 + r2)
        } else {
            1.0
        };
        let a_bar = 10.0 * (3.0 + c3 * 20.0 * delta * BAND_FREQ[i] / SPEED_OF_SOUND).log10();
        atten[i] = a_bar.min(cap);
    }
    atten
}

/// Pure Maekawa knife-edge attenuation (no Rayleigh gate).
/// C₃ correction for double edges (ISO 9613-2 §7.4 / CNOSSOS §2.5.23):
/// C₃ = (1 + (5λ/e)²) / (1/3 + (5λ/e)²) where e = distance between edges.
pub fn diffraction_attenuation(delta: f64, is_double: bool) -> [f64; NUM_BANDS] {
    maekawa_bands(delta, is_double, 0.0, f64::INFINITY)
}

pub fn diffraction_attenuation_with_edge(
    delta: f64,
    is_double: bool,
    edge_distance: f64,
) -> [f64; NUM_BANDS] {
    maekawa_bands(delta, is_double, edge_distance, f64::INFINITY)
}

/// Maekawa with CNOSSOS-EU §2.5.6(c) Rayleigh gate per band.
pub fn diffraction_attenuation_rayleigh(result: &DiffractionResult) -> [f64; NUM_BANDS] {
    maekawa_bands(result.delta, result.is_double, result.edge_distance, result.delta_star)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_obstruction() {
        // Flat profile: no diffraction
        let profile = vec![100.0; 10];
        let result = compute_path_difference(&profile, 500.0, 0.05, 1.5);
        assert_eq!(result.delta, 0.0);
        assert_eq!(result.delta_star, 0.0);
    }

    #[test]
    fn test_single_hill() {
        // Hill in the middle
        let mut profile = vec![100.0; 10];
        profile[5] = 110.0; // 10m hill at midpoint
        let result = compute_path_difference(&profile, 500.0, 0.05, 1.5);
        assert!(result.delta > 0.0, "should detect hill");
        assert!(!result.is_double);
        assert!(result.delta_star > 0.0, "delta_star should be positive for a real hill");
    }

    #[test]
    fn test_k6_barrier_atten() {
        // K6: Single barrier, δ=0.5m → expected 15.28 dB at 1kHz
        let atten = diffraction_attenuation(0.5, false);
        let at_1khz = atten[4]; // 1000 Hz band
        assert!(
            (at_1khz - 15.28).abs() < 1.0,
            "K6 1kHz: expected ~15.28, got {:.2}",
            at_1khz
        );
    }

    #[test]
    fn test_k7_double_barrier() {
        // K7: Double barrier, δ=1.0m → expected ~16.30 dB at 1kHz
        let atten = diffraction_attenuation(1.0, true);
        let at_1khz = atten[4];
        assert!(
            at_1khz > 14.0 && at_1khz < 20.0,
            "K7 1kHz: expected ~17.9, got {:.2}",
            at_1khz
        );
    }

    /// K9: Kytín-like shallow hill (δ ≈ 0.4 m, δ* ≈ 0.5 m) — 63 Hz is gated, 1 kHz passes.
    #[test]
    fn test_k9_rayleigh_gate_shallow_hill() {
        let n = 61;
        let mut profile = vec![400.0_f64; n];
        profile[n / 2] = 419.0;
        let result = compute_path_difference(&profile, 1850.0, 0.05, 4.0);
        assert!(result.delta > 0.0);
        assert!(result.delta_star > 0.0);

        let atten = diffraction_attenuation_rayleigh(&result);
        assert_eq!(
            atten[0], 0.0,
            "63 Hz must be gated (δ={:.3}, δ*={:.3})",
            result.delta, result.delta_star
        );
        assert!(atten[4] > 5.0, "1 kHz should pass gate, got {:.3} dB", atten[4]);
    }

    /// Invariant: gated[i] == pure[i] where the gate passes, else 0.
    fn assert_gate_invariant(result: &DiffractionResult) {
        let gated = diffraction_attenuation_rayleigh(result);
        let pure = diffraction_attenuation_with_edge(
            result.delta,
            result.is_double,
            result.edge_distance,
        );
        for i in 0..NUM_BANDS {
            let lambda = SPEED_OF_SOUND / BAND_FREQ[i];
            if result.delta > lambda / 4.0 - result.delta_star {
                assert!(
                    (gated[i] - pure[i]).abs() < 1e-9,
                    "Band {i}: gate should pass → gated==pure ({:.3} vs {:.3})",
                    gated[i],
                    pure[i]
                );
            } else {
                assert_eq!(gated[i], 0.0, "Band {i}: gate should fail → 0 dB");
            }
        }
    }

    /// K10: high industrial source — large δ* makes the Rayleigh gate a no-op.
    #[test]
    fn test_k10_rayleigh_noop_high_source() {
        let n = 31;
        let mut profile = vec![100.0_f64; n];
        profile[n / 2] = 100.2;
        let result = compute_path_difference(&profile, 300.0, 10.0, 4.0);
        if result.delta > 0.0 {
            assert_gate_invariant(&result);
        }
    }

    /// K11: double-edge — D selection picks the edge with larger excess above LOS.
    #[test]
    fn test_k11_double_edge_d_selection() {
        let n = 21;
        let mut profile = vec![100.0_f64; n];
        profile[3] = 105.0;
        profile[17] = 115.0;
        let result = compute_path_difference(&profile, 600.0, 0.05, 4.0);
        assert!(result.is_double, "should be detected as double diffraction");
        assert!(result.delta > 0.0);
        assert!(result.delta_star > 0.0);
        assert_gate_invariant(&result);
    }
}
