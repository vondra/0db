//! ISO 9613-2 single-edge diffraction (§7.3, max 20 dB) + CNOSSOS-EU §2.5.6(c)
//! Rayleigh δ\* mean-ground gate + Maekawa per-band attenuation.
//!
//! The dominant edge is selected upstream by [`super::horizon`] (largest
//! path-length difference δ); this module computes that edge's δ geometry
//! ([`compute_single_edge`]), the bare-earth δ\* OLS mean-ground fit
//! ([`compute_delta_star`]), and the banded attenuation
//! ([`diffraction_attenuation_rayleigh`]).

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Single-edge diffraction geometry + the CNOSSOS Rayleigh δ\*.
pub struct DiffractionResult {
    pub delta: f64, // path difference in meters
    /// CNOSSOS-EU §2.5.6(c) Rayleigh δ*: path difference over the dominant edge
    /// with mirror source/receiver reflected across the per-side mean ground
    /// planes. 0.0 when there is no obstruction.
    pub delta_star: f64,
    /// Number of diffraction edges found (0 = clear path, 1 = dominant edge).
    pub n_edges: u8,
    /// Profile sample index of the dominant edge (meaningful when `n_edges == 1`).
    pub edge_idx: usize,
}

#[inline]
fn empty_result() -> DiffractionResult {
    DiffractionResult {
        delta: 0.0,
        delta_star: 0.0,
        n_edges: 0,
        edge_idx: 0,
    }
}

/// δ + Rayleigh δ\* over a single pre-selected edge `idx`. `edge_profile` is the
/// composite (or bare) top the δ geometry runs on; `ols_profile` MUST be
/// bare-earth elevation for the §2.5.6(c) mean-ground fit.
pub(super) fn compute_single_edge(
    t: &[f64],
    edge_profile: &[f64],
    ols_profile: &[f64],
    total_dist: f64,
    idx: usize,
    src_elev: f64,
    rcv_elev: f64,
    dsr: f64,
    source_height: f64,
    receiver_height: f64,
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
    let delta_star = compute_delta_star(
        t,
        ols_profile,
        idx,
        total_dist,
        source_height,
        receiver_height,
    );
    DiffractionResult {
        delta: d_sb + d_br - dsr,
        delta_star,
        n_edges: 1,
        edge_idx: idx,
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

fn maekawa_bands(delta: f64, delta_star: f64) -> [f64; NUM_BANDS] {
    let mut atten = [0.0_f64; NUM_BANDS];
    if delta <= 0.0 {
        return atten;
    }
    for i in 0..NUM_BANDS {
        let lambda = SPEED_OF_SOUND / BAND_FREQ[i];
        if delta <= lambda / 4.0 - delta_star {
            continue;
        }
        let a_bar = 10.0 * (3.0 + 20.0 * delta * BAND_FREQ[i] / SPEED_OF_SOUND).log10();
        atten[i] = a_bar.min(SINGLE_DIFF_CAP);
    }
    atten
}

/// Pure Maekawa band attenuation (no Rayleigh gate) — reference-vector helper.
pub fn diffraction_attenuation(delta: f64) -> [f64; NUM_BANDS] {
    maekawa_bands(delta, f64::INFINITY)
}

pub fn diffraction_attenuation_rayleigh(result: &DiffractionResult) -> [f64; NUM_BANDS] {
    maekawa_bands(result.delta, result.delta_star)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_k6_barrier_atten() {
        let atten = diffraction_attenuation(0.5);
        let at_1khz = atten[4];
        assert!(
            (at_1khz - 15.28).abs() < 1.0,
            "K6 1kHz: expected ~15.28, got {:.2}",
            at_1khz
        );
    }
}
