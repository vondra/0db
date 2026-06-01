//! ISO 9613-2 terrain/barrier diffraction + CNOSSOS-EU §2.5.6(c) Rayleigh gate.
//!
//! Single diffraction (one edge, §7.3): max 20 dB
//! Double diffraction (two edges, §7.4): max 25 dB
//! Triple diffraction (three edges, project simplification — SPEC.md): max 25 dB
//!
//! Edge detection: upper convex hull of the sampled (t·dist, elevation) profile,
//! filtered to samples above the source→receiver line-of-sight. Up to 3 edges
//! kept (top-3 by LOS excess, then re-hulled for geometric validity).

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Result of path difference computation.
pub struct DiffractionResult {
    pub delta: f64,         // path difference in meters
    pub is_double: bool,    // true for 2 or 3 edges (back-compat)
    pub edge_distance: f64, // N=2: |E1→E2|; N=3: |E1→E3| (first-to-last); 0 for single
    /// CNOSSOS-EU §2.5.6(c) Rayleigh δ*: path difference over the dominant edge
    /// with mirror source/receiver reflected across the per-side mean ground
    /// planes. 0.0 when there is no obstruction.
    pub delta_star: f64,
    /// Number of diffraction edges found (0, 1, 2, or 3).
    pub n_edges: u8,
    /// Profile sample indexes of the edges (first `n_edges` entries valid).
    pub edge_indices: [usize; 3],
}

#[inline]
fn empty_result() -> DiffractionResult {
    DiffractionResult {
        delta: 0.0,
        is_double: false,
        edge_distance: 0.0,
        delta_star: 0.0,
        n_edges: 0,
        edge_indices: [0; 3],
    }
}

/// Compute path difference over a single elevation profile.
pub fn compute_path_difference(
    t: &[f64],
    profile: &[f64],
    total_dist: f64,
    source_height: f64,
    receiver_height: f64,
) -> DiffractionResult {
    compute_path_difference_with_ols(t, profile, profile, total_dist, source_height, receiver_height)
}

/// Compute path difference with separate profiles for edge detection vs. OLS
/// mean-ground fit.
///
/// `edge_profile`: profile used for edge finding + δ geometry (may include
///   building heights as a composite top).
/// `ols_profile`: profile used for the CNOSSOS §2.5.6(c) δ* mean-ground fit —
///   **must be bare-earth elevation** even when edges come from a composite.
pub fn compute_path_difference_with_ols(
    t: &[f64],
    edge_profile: &[f64],
    ols_profile: &[f64],
    total_dist: f64,
    source_height: f64,
    receiver_height: f64,
) -> DiffractionResult {
    let n = edge_profile.len();
    debug_assert_eq!(t.len(), n, "t and edge_profile must have same length");
    debug_assert_eq!(ols_profile.len(), n, "ols_profile length must match");
    if n < 3 || total_dist < 30.0 {
        return empty_result();
    }

    let src_elev = ols_profile[0] + source_height;
    let rcv_elev = ols_profile[n - 1] + receiver_height;

    // Upper convex hull over (t·dist, edge_profile).
    let hull = upper_convex_hull(t, edge_profile, total_dist);

    // Filter hull to middle vertices above the source→receiver LOS.
    let mut candidates: Vec<usize> = hull
        .into_iter()
        .filter(|&i| i != 0 && i != n - 1)
        .filter(|&i| edge_profile[i] > src_elev + (rcv_elev - src_elev) * t[i])
        .collect();

    if candidates.is_empty() {
        return empty_result();
    }

    // Cap at 3 edges — project simplification (SPEC.md). Drop lowest-excess,
    // then re-hull on {top_3 ∪ endpoints} to guarantee geometric validity.
    if candidates.len() > 3 {
        let mut by_excess: Vec<(usize, f64)> = candidates
            .iter()
            .map(|&i| {
                let los = src_elev + (rcv_elev - src_elev) * t[i];
                (i, edge_profile[i] - los)
            })
            .collect();
        by_excess.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        by_excess.truncate(3);
        let mut top3: Vec<usize> = by_excess.into_iter().map(|(i, _)| i).collect();
        top3.sort();
        candidates = rehull_over_points(&top3, t, edge_profile, total_dist, src_elev, rcv_elev, n);
        if candidates.is_empty() {
            return empty_result();
        }
    }

    // Adjacent-edge collapse: treat as single diffraction at higher-excess index.
    if candidates.len() >= 2 && candidates[1] - candidates[0] <= 1 {
        let e1 = candidates[0];
        let e2 = candidates[1];
        let los1 = src_elev + (rcv_elev - src_elev) * t[e1];
        let los2 = src_elev + (rcv_elev - src_elev) * t[e2];
        let pick = if (edge_profile[e1] - los1) >= (edge_profile[e2] - los2) { e1 } else { e2 };
        candidates = vec![pick];
    }

    let dsr = ((total_dist * total_dist) + (rcv_elev - src_elev).powi(2)).sqrt();

    match candidates.len() {
        0 => empty_result(),
        1 => compute_single_edge(t, edge_profile, ols_profile, total_dist, candidates[0],
            src_elev, rcv_elev, dsr, source_height, receiver_height),
        2 => compute_double_edge(t, edge_profile, ols_profile, total_dist, candidates[0], candidates[1],
            src_elev, rcv_elev, dsr, source_height, receiver_height),
        3 => compute_triple_edge(t, edge_profile, ols_profile, total_dist, candidates[0], candidates[1], candidates[2],
            src_elev, rcv_elev, dsr, source_height, receiver_height),
        _ => empty_result(),
    }
}

/// Upper convex hull via Andrew's monotone chain.
#[inline]
fn upper_convex_hull(t: &[f64], profile: &[f64], total_dist: f64) -> Vec<usize> {
    let n = profile.len();
    let mut hull: Vec<usize> = Vec::with_capacity(n);
    for i in 0..n {
        let px = t[i] * total_dist;
        let py = profile[i];
        while hull.len() >= 2 {
            let a = hull[hull.len() - 2];
            let b = hull[hull.len() - 1];
            let ax = t[a] * total_dist;
            let ay = profile[a];
            let bx = t[b] * total_dist;
            let by = profile[b];
            let cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
            if cross >= 0.0 {
                hull.pop();
            } else {
                break;
            }
        }
        hull.push(i);
    }
    hull
}

/// After top-3 truncation, rebuild the hull over {endpoints ∪ top_3}.
fn rehull_over_points(
    top3: &[usize],
    t: &[f64],
    profile: &[f64],
    total_dist: f64,
    src_elev: f64,
    rcv_elev: f64,
    n: usize,
) -> Vec<usize> {
    let mut idx = vec![0usize];
    idx.extend_from_slice(top3);
    idx.push(n - 1);
    let mut xs = Vec::with_capacity(idx.len());
    let mut ys = Vec::with_capacity(idx.len());
    for (k, &i) in idx.iter().enumerate() {
        xs.push(t[i] * total_dist);
        let h = if k == 0 {
            src_elev
        } else if k == idx.len() - 1 {
            rcv_elev
        } else {
            profile[i]
        };
        ys.push(h);
    }
    let mut hull: Vec<usize> = Vec::with_capacity(idx.len());
    for k in 0..idx.len() {
        while hull.len() >= 2 {
            let a = hull[hull.len() - 2];
            let b = hull[hull.len() - 1];
            let cross = (xs[b] - xs[a]) * (ys[k] - ys[a]) - (ys[b] - ys[a]) * (xs[k] - xs[a]);
            if cross >= 0.0 {
                hull.pop();
            } else {
                break;
            }
        }
        hull.push(k);
    }
    hull.into_iter()
        .filter(|&k| k != 0 && k != idx.len() - 1)
        .map(|k| idx[k])
        .collect()
}

pub(super) fn compute_single_edge(
    t: &[f64], edge_profile: &[f64], ols_profile: &[f64], total_dist: f64, idx: usize,
    src_elev: f64, rcv_elev: f64, dsr: f64,
    source_height: f64, receiver_height: f64,
) -> DiffractionResult {
    let los = src_elev + (rcv_elev - src_elev) * t[idx];
    if edge_profile[idx] <= los {
        return empty_result();
    }
    let d_sg = t[idx] * total_dist;
    let d_rg = (1.0 - t[idx]) * total_dist;
    let top = edge_profile[idx];
    let d_sb = (d_sg * d_sg + (top - src_elev).powi(2)).sqrt();
    let d_br = (d_rg * d_rg + (top - rcv_elev).powi(2)).sqrt();
    let delta_star =
        compute_delta_star(t, ols_profile, idx, total_dist, source_height, receiver_height);
    DiffractionResult {
        delta: d_sb + d_br - dsr,
        is_double: false,
        edge_distance: 0.0,
        delta_star,
        n_edges: 1,
        edge_indices: [idx, 0, 0],
    }
}

fn compute_double_edge(
    t: &[f64], edge_profile: &[f64], ols_profile: &[f64], total_dist: f64, e1: usize, e2: usize,
    src_elev: f64, rcv_elev: f64, dsr: f64,
    source_height: f64, receiver_height: f64,
) -> DiffractionResult {
    let top1 = edge_profile[e1];
    let top2 = edge_profile[e2];
    let d1 = t[e1] * total_dist;
    let d2 = t[e2] * total_dist;
    let d_se1 = (d1 * d1 + (top1 - src_elev).powi(2)).sqrt();
    let d_e1e2 = ((d2 - d1).powi(2) + (top2 - top1).powi(2)).sqrt();
    let d2r = (1.0 - t[e2]) * total_dist;
    let d_e2r = (d2r * d2r + (top2 - rcv_elev).powi(2)).sqrt();
    let delta = (d_se1 + d_e1e2 + d_e2r - dsr).max(0.0);

    let los1 = src_elev + (rcv_elev - src_elev) * t[e1];
    let los2 = src_elev + (rcv_elev - src_elev) * t[e2];
    let d_idx = if edge_profile[e1] - los1 >= edge_profile[e2] - los2 { e1 } else { e2 };
    let delta_star =
        compute_delta_star(t, ols_profile, d_idx, total_dist, source_height, receiver_height);

    DiffractionResult {
        delta,
        is_double: true,
        edge_distance: d_e1e2,
        delta_star,
        n_edges: 2,
        edge_indices: [e1, e2, 0],
    }
}

/// Triple-edge cascade. ISO/CNOSSOS silent for N=3; project simplification.
/// `e` for C₃ is first-to-last path distance.
fn compute_triple_edge(
    t: &[f64], edge_profile: &[f64], ols_profile: &[f64], total_dist: f64, e1: usize, e2: usize, e3: usize,
    src_elev: f64, rcv_elev: f64, dsr: f64,
    source_height: f64, receiver_height: f64,
) -> DiffractionResult {
    let top1 = edge_profile[e1];
    let top2 = edge_profile[e2];
    let top3 = edge_profile[e3];
    let d1 = t[e1] * total_dist;
    let d2 = t[e2] * total_dist;
    let d3 = t[e3] * total_dist;

    let d_se1 = (d1 * d1 + (top1 - src_elev).powi(2)).sqrt();
    let d_e1e2 = ((d2 - d1).powi(2) + (top2 - top1).powi(2)).sqrt();
    let d_e2e3 = ((d3 - d2).powi(2) + (top3 - top2).powi(2)).sqrt();
    let d_e3r = ((total_dist - d3).powi(2) + (top3 - rcv_elev).powi(2)).sqrt();
    let delta = (d_se1 + d_e1e2 + d_e2e3 + d_e3r - dsr).max(0.0);

    let e_first_to_last = ((d3 - d1).powi(2) + (top3 - top1).powi(2)).sqrt();

    let los1 = src_elev + (rcv_elev - src_elev) * t[e1];
    let los2 = src_elev + (rcv_elev - src_elev) * t[e2];
    let los3 = src_elev + (rcv_elev - src_elev) * t[e3];
    let exc1 = edge_profile[e1] - los1;
    let exc2 = edge_profile[e2] - los2;
    let exc3 = edge_profile[e3] - los3;
    let d_idx = if exc1 >= exc2 && exc1 >= exc3 { e1 }
        else if exc2 >= exc3 { e2 }
        else { e3 };
    let delta_star =
        compute_delta_star(t, ols_profile, d_idx, total_dist, source_height, receiver_height);

    DiffractionResult {
        delta,
        is_double: true,
        edge_distance: e_first_to_last,
        delta_star,
        n_edges: 3,
        edge_indices: [e1, e2, e3],
    }
}

/// CNOSSOS-EU §2.5.6(c) Rayleigh δ*.
fn compute_delta_star(
    t: &[f64],
    profile: &[f64],
    d_idx: usize,
    total_dist: f64,
    source_height: f64,
    receiver_height: f64,
) -> f64 {
    let n = profile.len();
    let d_sg = t[d_idx] * total_dist;
    let d_rg = (1.0 - t[d_idx]) * total_dist;

    let (_, b_src) = fit_plane(&t[..=d_idx], &profile[..=d_idx], 0.0, total_dist);
    let (a_rcv, b_rcv) = fit_plane(&t[d_idx..], &profile[d_idx..], t[d_idx], total_dist);
    let plane_rcv_at_end = a_rcv * d_rg + b_rcv;

    let s_star_z = 2.0 * b_src - (profile[0] + source_height);
    let r_star_z = 2.0 * plane_rcv_at_end - (profile[n - 1] + receiver_height);

    let d_top = profile[d_idx];
    let d_sd = (d_sg * d_sg + (d_top - s_star_z).powi(2)).sqrt();
    let d_dr = (d_rg * d_rg + (r_star_z - d_top).powi(2)).sqrt();
    let d_sr = (total_dist * total_dist + (r_star_z - s_star_z).powi(2)).sqrt();
    (d_sd + d_dr - d_sr).max(0.0)
}

fn fit_plane(ts: &[f64], zs: &[f64], t_offset: f64, total_dist: f64) -> (f64, f64) {
    let n = zs.len() as f64;
    debug_assert_eq!(ts.len(), zs.len());
    if n < 1.0 {
        return (0.0, 0.0);
    }
    let mut sx = 0.0_f64;
    let mut sz = 0.0_f64;
    let mut sxx = 0.0_f64;
    let mut sxz = 0.0_f64;
    for (&ti, &z) in ts.iter().zip(zs.iter()) {
        let x = (ti - t_offset) * total_dist;
        sx += x;
        sz += z;
        sxx += x * x;
        sxz += x * z;
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return (0.0, sz / n);
    }
    let a = (n * sxz - sx * sz) / denom;
    let b = (sz - a * sx) / n;
    (a, b)
}

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
        // CNOSSOS §2.5.23: C'' = 1 when the edge-span e ≤ 0.3 m (noise floor).
        let c3 = if is_double && edge_distance > 0.3 {
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

pub fn diffraction_attenuation_rayleigh(result: &DiffractionResult) -> [f64; NUM_BANDS] {
    maekawa_bands(result.delta, result.is_double, result.edge_distance, result.delta_star)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniform_t(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64 / (n - 1).max(1) as f64).collect()
    }

    #[test]
    fn test_no_obstruction() {
        let profile = vec![100.0; 10];
        let t = uniform_t(10);
        let result = compute_path_difference(&t, &profile, 500.0, 0.05, 1.5);
        assert_eq!(result.delta, 0.0);
        assert_eq!(result.delta_star, 0.0);
    }

    #[test]
    fn test_single_hill() {
        let mut profile = vec![100.0; 10];
        profile[5] = 110.0;
        let t = uniform_t(10);
        let result = compute_path_difference(&t, &profile, 500.0, 0.05, 1.5);
        assert!(result.delta > 0.0, "should detect hill");
        assert!(!result.is_double);
        assert!(result.delta_star > 0.0);
    }

    #[test]
    fn test_uniform_vs_bilateral_stable() {
        let total_dist = 1000.0;
        let t_uniform = uniform_t(11);
        let prof_uniform: Vec<f64> = t_uniform
            .iter()
            .map(|&tt| if (tt - 0.5_f64).abs() < 1e-9 { 115.0_f64 } else { 100.0_f64 })
            .collect();
        let r_uniform = compute_path_difference(&t_uniform, &prof_uniform, total_dist, 0.05, 1.5);

        let t_bilat = vec![0.0, 0.03, 0.06, 0.1, 0.25, 0.5, 0.75, 0.9, 0.94, 0.97, 1.0];
        let prof_bilat: Vec<f64> = t_bilat
            .iter()
            .map(|&tt| if (tt - 0.5_f64).abs() < 1e-9 { 115.0_f64 } else { 100.0_f64 })
            .collect();
        let r_bilat = compute_path_difference(&t_bilat, &prof_bilat, total_dist, 0.05, 1.5);

        assert!(r_uniform.delta > 0.0);
        assert!(r_bilat.delta > 0.0);
        let rel_err = (r_uniform.delta - r_bilat.delta).abs() / r_uniform.delta;
        assert!(
            rel_err < 0.02,
            "δ must be stable across cadences: uniform={:.4}, bilateral={:.4}, rel_err={:.3}",
            r_uniform.delta,
            r_bilat.delta,
            rel_err
        );
    }

    #[test]
    fn test_k6_barrier_atten() {
        let atten = diffraction_attenuation(0.5, false);
        let at_1khz = atten[4];
        assert!(
            (at_1khz - 15.28).abs() < 1.0,
            "K6 1kHz: expected ~15.28, got {:.2}",
            at_1khz
        );
    }

    #[test]
    fn test_k7_double_barrier() {
        // Maekawa component only (δ=1.0 m, 25 dB cap). The system-level K7
        // vector in SPEC.md (16.30 dB) folds in G=0.5 ground effect over a
        // full 200 m propagation; this unit test checks just the band math.
        // At 1 kHz with C₃=1 (edge_distance=0 → C'' floor), a_bar =
        // 10·log10(3 + 20·1.0·1000/340) ≈ 17.91 dB.
        let atten = diffraction_attenuation(1.0, true);
        let at_1khz = atten[4];
        assert!(
            at_1khz > 14.0 && at_1khz < 20.0,
            "K7 Maekawa 1kHz: expected ~17.9, got {:.2}",
            at_1khz
        );
    }

    #[test]
    fn test_k9_rayleigh_gate_shallow_hill() {
        let n = 61;
        let mut profile = vec![400.0_f64; n];
        profile[n / 2] = 419.0;
        let t = uniform_t(n);
        let result = compute_path_difference(&t, &profile, 1850.0, 0.05, 4.0);
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

    #[test]
    fn test_k10_rayleigh_noop_high_source() {
        let n = 31;
        let mut profile = vec![100.0_f64; n];
        profile[n / 2] = 100.2;
        let t = uniform_t(n);
        let result = compute_path_difference(&t, &profile, 300.0, 10.0, 4.0);
        if result.delta > 0.0 {
            assert_gate_invariant(&result);
        }
    }

    #[test]
    fn test_k11_double_edge_d_selection() {
        let n = 21;
        let mut profile = vec![100.0_f64; n];
        profile[3] = 105.0;
        profile[17] = 115.0;
        let t = uniform_t(n);
        let result = compute_path_difference(&t, &profile, 600.0, 0.05, 4.0);
        assert!(result.is_double, "should be detected as double diffraction");
        assert_eq!(result.n_edges, 2);
        assert!(result.delta > 0.0);
        assert!(result.delta_star > 0.0);
        assert_gate_invariant(&result);
    }

    #[test]
    fn test_k12_triple_edge_cascade() {
        let n = 31;
        let mut profile = vec![100.0_f64; n];
        profile[5] = 112.0;
        profile[15] = 115.0;
        profile[25] = 110.0;
        let t = uniform_t(n);
        let result = compute_path_difference(&t, &profile, 1500.0, 0.05, 4.0);
        assert_eq!(result.n_edges, 3, "should find three edges (got {})", result.n_edges);
        assert!(result.is_double, "triple diffraction keeps is_double=true for back-compat");
        assert!(result.delta > 0.0);
        assert!(result.delta_star > 0.0);
        let d1 = t[result.edge_indices[0]] * 1500.0;
        let d3 = t[result.edge_indices[2]] * 1500.0;
        let top1 = profile[result.edge_indices[0]];
        let top3 = profile[result.edge_indices[2]];
        let expected_e = ((d3 - d1).powi(2) + (top3 - top1).powi(2)).sqrt();
        assert!(
            (result.edge_distance - expected_e).abs() < 0.01,
            "edge_distance should be first-to-last, got {:.3} expected {:.3}",
            result.edge_distance,
            expected_e
        );
        assert_gate_invariant(&result);
    }

    #[test]
    fn test_hull_drops_subdominant_middle_peak() {
        let n = 21;
        let mut profile = vec![100.0_f64; n];
        profile[6] = 105.0;
        profile[10] = 130.0;
        let t = uniform_t(n);
        let result = compute_path_difference(&t, &profile, 1000.0, 0.05, 4.0);
        assert_eq!(result.n_edges, 1, "subdominant bump must not become a hull edge");
        assert_eq!(result.edge_indices[0], 10);
    }

    #[test]
    fn test_c3_floor_short_edge_distance() {
        let a_01 = maekawa_bands(0.1, true, 0.1, 0.0);
        let a_025 = maekawa_bands(0.1, true, 0.25, 0.0);
        let a_029 = maekawa_bands(0.1, true, 0.29, 0.0);
        for i in 0..NUM_BANDS {
            assert!(
                (a_01[i] - a_025[i]).abs() < 1e-9 && (a_01[i] - a_029[i]).abs() < 1e-9,
                "band {i}: C3 must be 1 across e ∈ [0.1, 0.29], got {:.4}/{:.4}/{:.4}",
                a_01[i], a_025[i], a_029[i]
            );
        }
        let a_large_e = maekawa_bands(0.1, true, 100.0, 0.0);
        assert!(a_large_e[4] > a_01[4] + 1.0, "C3 effect above 0.3 m must be visible");
    }
}
