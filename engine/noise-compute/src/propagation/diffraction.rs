//! ISO 9613-2 single-edge diffraction (§7.3, max 20 dB) + CNOSSOS-EU §2.5.6(c)
//! Rayleigh δ\* mean-ground gate + Maekawa per-band attenuation.
//!
//! The dominant edge is selected upstream by [`super::horizon`] (largest
//! path-length difference δ); this module computes that edge's δ geometry
//! ([`compute_single_edge`] for a cadence sample, [`compute_single_edge_at`]
//! for an explicit vector-obstacle crossing between samples), the bare-earth
//! δ\* OLS mean-ground fit ([`compute_delta_star`]), and the banded
//! attenuation ([`diffraction_attenuation_rayleigh`]).

use crate::constants::*;
use crate::types::NUM_BANDS;

/// Single-edge diffraction geometry + the CNOSSOS Rayleigh δ\*.
pub struct DiffractionResult {
    pub delta: f64, // path difference in meters
    /// CNOSSOS-EU (2.5.25) favourable-conditions path difference over the SAME
    /// edge: ray curved toward the ground with Γ = max(1000, 8·d_SR), which
    /// shortens the detour over the top — δ_F < δ (and can go negative, i.e.
    /// the curved ray clears the edge entirely). Consumed only when
    /// [`FAVOURABLE_MIXING`] is on; the edge itself stays max-δ-selected on
    /// straight geometry (plan-accepted second-order simplification).
    pub delta_fav: f64,
    /// CNOSSOS-EU §2.5.6(c) Rayleigh δ*: path difference over the dominant edge
    /// with mirror source/receiver reflected across the per-side mean ground
    /// planes. 0.0 when there is no obstruction. Kept straight-geometry under
    /// the favourable state too (review-pinned conservative choice).
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
        delta_fav: 0.0,
        delta_star: 0.0,
        n_edges: 0,
        edge_idx: 0,
    }
}

/// CNOSSOS-EU (2.5.24)/(2.5.25) favourable-conditions path difference: each
/// straight chord is replaced by the arc of a circle with radius
/// Γ = max(1000, 8·dsr) through its endpoints (arc = 2Γ·asin(ℓ/2Γ)).
/// Γ ≥ 8·dsr keeps every asin argument ≤ ~1/16, far from the domain edge.
pub(crate) fn curved_path_difference(d_sb: f64, d_br: f64, dsr: f64, gamma: f64) -> f64 {
    let arc = |chord: f64| 2.0 * gamma * (chord / (2.0 * gamma)).asin();
    arc(d_sb) + arc(d_br) - arc(dsr)
}

/// CNOSSOS-EU (2.5.9) long-term energetic mix of the favourable and
/// homogeneous states, expressed on ATTENUATIONS: both states share every
/// other term of the level chain (emission, divergence, atmosphere, ground,
/// vegetation), so mixing the diffraction attenuation is algebraically
/// identical to mixing the received levels — and with the single flat
/// [`P_FAV`] it is also identical to mixing per period or mixing Lden
/// (verified in the plan review). Mixing leans to the LOUDER (favourable)
/// state, which is the standard's point.
pub(crate) fn mix_fav_hom(
    hom: &[f64; NUM_BANDS],
    fav: &[f64; NUM_BANDS],
    p_fav: f64,
) -> [f64; NUM_BANDS] {
    let mut mixed = [0.0_f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        let e =
            p_fav * 10.0_f64.powf(-fav[i] / 10.0) + (1.0 - p_fav) * 10.0_f64.powf(-hom[i] / 10.0);
        mixed[i] = -10.0 * e.log10();
    }
    mixed
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
    let gamma = FAV_RAY_CURVATURE_MIN_M.max(FAV_RAY_CURVATURE_PER_DSR * dsr);
    DiffractionResult {
        delta: d_sb + d_br - dsr,
        delta_fav: curved_path_difference(d_sb, d_br, dsr, gamma),
        delta_star,
        n_edges: 1,
        edge_idx: idx,
    }
}

/// δ + Rayleigh δ\* over an EXPLICIT edge point `(t_e, top_e)` that need not
/// coincide with any profile sample — the vector-obstacle candidate path
/// (geodata-v2 1.3). Same geometry as [`compute_single_edge`]. Per SPEC §3.5b
/// (and the sample path at [`compute_delta_star`]), the diffraction point D —
/// the bare ground LERPed at `t_e` — belongs to BOTH §2.5.6(c) mean-ground
/// fits: source side = samples with `t < t_e` plus D, receiver side = D plus
/// samples with `t > t_e`. At an exact sample t these are the sample path's
/// point sets verbatim (bit-parity on any terrain), and between samples the
/// fits vary continuously as `t_e` crosses a cadence sample.
#[allow(clippy::too_many_arguments)]
pub(super) fn compute_single_edge_at(
    t: &[f64],
    ols_profile: &[f64],
    t_e: f64,
    top_e: f64,
    total_dist: f64,
    src_elev: f64,
    rcv_elev: f64,
    dsr: f64,
    source_height: f64,
    receiver_height: f64,
) -> DiffractionResult {
    let los = src_elev + (rcv_elev - src_elev) * t_e;
    if top_e <= los {
        return empty_result();
    }
    let d_sg = t_e * total_dist;
    let d_rg = (1.0 - t_e) * total_dist;
    let d_sb = (d_sg * d_sg + (top_e - src_elev).powi(2)).sqrt();
    let d_br = (d_rg * d_rg + (top_e - rcv_elev).powi(2)).sqrt();

    let n = ols_profile.len();
    // Strict partitions: src samples t < t_e, rcv samples t > t_e; D joins
    // both fits exactly once. Candidates carry t ∈ (0, 1) so each side keeps
    // at least its endpoint sample.
    let p_lo = t.partition_point(|&x| x < t_e);
    let p_hi = t.partition_point(|&x| x <= t_e);
    // Bare ground under the candidate edge, LERPed between its neighbours
    // (equals the sample's elevation when t_e sits exactly on a sample).
    let i1 = p_hi.clamp(1, n - 1);
    let (t0, t1) = (t[i1 - 1], t[i1]);
    let frac = if t1 > t0 {
        ((t_e - t0) / (t1 - t0)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let d_top = ols_profile[i1 - 1] + frac * (ols_profile[i1] - ols_profile[i1 - 1]);

    let (_, b_src) = fit_plane_with_point(
        &t[..p_lo],
        &ols_profile[..p_lo],
        t_e,
        d_top,
        0.0,
        total_dist,
    );
    let (a_rcv, b_rcv) = fit_plane_with_point(
        &t[p_hi..],
        &ols_profile[p_hi..],
        t_e,
        d_top,
        t_e,
        total_dist,
    );
    let plane_rcv_at_end = a_rcv * d_rg + b_rcv;
    let s_star_z = 2.0 * b_src - (ols_profile[0] + source_height);
    let r_star_z = 2.0 * plane_rcv_at_end - (ols_profile[n - 1] + receiver_height);
    let d_sd = (d_sg * d_sg + (d_top - s_star_z).powi(2)).sqrt();
    let d_dr = (d_rg * d_rg + (r_star_z - d_top).powi(2)).sqrt();
    let d_sr = (total_dist * total_dist + (r_star_z - s_star_z).powi(2)).sqrt();
    let delta_star = (d_sd + d_dr - d_sr).max(0.0);

    let gamma = FAV_RAY_CURVATURE_MIN_M.max(FAV_RAY_CURVATURE_PER_DSR * dsr);
    DiffractionResult {
        delta: d_sb + d_br - dsr,
        delta_fav: curved_path_difference(d_sb, d_br, dsr, gamma),
        delta_star,
        n_edges: 1,
        edge_idx: p_hi.clamp(1, n - 1),
    }
}

/// [`fit_plane`] with one extra point `(extra_t, extra_z)` folded into the
/// regression — the diffraction point D for the explicit-edge δ\* fits.
fn fit_plane_with_point(
    ts: &[f64],
    zs: &[f64],
    extra_t: f64,
    extra_z: f64,
    t_offset: f64,
    total_dist: f64,
) -> (f64, f64) {
    let n = zs.len() as f64 + 1.0;
    let mut sx = 0.0_f64;
    let mut sz = 0.0_f64;
    let mut sxx = 0.0_f64;
    let mut sxz = 0.0_f64;
    for (&ti, &z) in ts
        .iter()
        .zip(zs.iter())
        .chain(std::iter::once((&extra_t, &extra_z)))
    {
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
    let hom = maekawa_bands(result.delta, result.delta_star);
    if !FAVOURABLE_MIXING || result.n_edges == 0 {
        return hom;
    }
    let fav = maekawa_bands(result.delta_fav, result.delta_star);
    mix_fav_hom(&hom, &fav, P_FAV)
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

    /// Kytín-shaped geometry: source and receiver ~2.2 km apart, an edge 25 m
    /// above the LOS near mid-path. δ_H comes out sub-metre (matches the live
    /// popup's δ = 0.9 m); the curved favourable ray must always shorten the
    /// detour (δ_F < δ_H), here enough to go NEGATIVE — the curved ray clears
    /// the hill, which is exactly the "distant motorway audible under
    /// inversion" mechanism the plan implements.
    fn kytin_edge() -> (f64, f64, f64) {
        let d_sg = 1000.0_f64;
        let d_rg = 1172.0_f64;
        let rise = 25.0_f64;
        let d_sb = (d_sg * d_sg + rise * rise).sqrt();
        let d_br = (d_rg * d_rg + rise * rise).sqrt();
        let dsr = d_sg + d_rg; // level endpoints
        (d_sb, d_br, dsr)
    }

    #[test]
    fn curved_ray_shortens_the_detour() {
        let (d_sb, d_br, dsr) = kytin_edge();
        let delta_h = d_sb + d_br - dsr;
        assert!(
            delta_h > 0.5 && delta_h < 1.0,
            "fixture δ_H ≈ 0.58 m, got {delta_h:.3}"
        );
        let gamma = FAV_RAY_CURVATURE_MIN_M.max(FAV_RAY_CURVATURE_PER_DSR * dsr);
        let delta_f = curved_path_difference(d_sb, d_br, dsr, gamma);
        assert!(delta_f < delta_h, "δ_F must be smaller than δ_H");
        assert!(
            delta_f < 0.0,
            "at 2.2 km the Γ=8·d curvature clears this sub-metre-δ hill (got {delta_f:.3})"
        );
    }

    /// Γ → ∞ recovers straight rays: δ_F → δ_H.
    #[test]
    fn infinite_curvature_recovers_straight_delta() {
        let (d_sb, d_br, dsr) = kytin_edge();
        let delta_h = d_sb + d_br - dsr;
        let delta_f = curved_path_difference(d_sb, d_br, dsr, 1.0e12);
        assert!(
            (delta_f - delta_h).abs() < 1e-6,
            "Γ→∞: δ_F {delta_f:.9} must equal δ_H {delta_h:.9}"
        );
    }

    /// (2.5.9) mix endpoints and monotonicity: p=0 → homogeneous, p=1 →
    /// favourable, p=0.5 strictly between and BELOW the arithmetic midpoint
    /// (energetic mean leans to the louder, less-attenuated state).
    #[test]
    fn mix_endpoints_and_energetic_lean() {
        let hom = [12.0_f64; NUM_BANDS];
        let fav = [2.0_f64; NUM_BANDS];
        let m0 = mix_fav_hom(&hom, &fav, 0.0);
        let m1 = mix_fav_hom(&hom, &fav, 1.0);
        let mh = mix_fav_hom(&hom, &fav, 0.5);
        for i in 0..NUM_BANDS {
            assert!((m0[i] - hom[i]).abs() < 1e-9);
            assert!((m1[i] - fav[i]).abs() < 1e-9);
            assert!(mh[i] > fav[i] && mh[i] < hom[i]);
            assert!(
                mh[i] < (hom[i] + fav[i]) / 2.0,
                "energetic mean must sit below the dB midpoint (louder state dominates)"
            );
        }
        // 10 dB spread at p=0.5 → mixed ≈ fav + 2.6 dB (= −10·log10(0.5·(1+10⁻¹)) above fav).
        assert!((mh[0] - (fav[0] + 2.61)).abs() < 0.05, "got {:.3}", mh[0]);
    }

    /// Flag ON (the shipped state since the 2026-07-28 flip): the public band
    /// function must equal the explicit favourable/homogeneous mix. The
    /// constant assert forces whoever flips the flag again to rewrite this
    /// test consciously (the OFF-era twin did the same job in reverse).
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn flag_on_matches_explicit_mix() {
        assert!(FAVOURABLE_MIXING, "shipped state is ON (flip 2026-07-28)");
        let r = DiffractionResult {
            delta: 0.7,
            delta_fav: -0.1,
            delta_star: 0.05,
            n_edges: 1,
            edge_idx: 3,
        };
        let public = diffraction_attenuation_rayleigh(&r);
        let hom = maekawa_bands(r.delta, r.delta_star);
        let fav = maekawa_bands(r.delta_fav, r.delta_star);
        assert_eq!(public, mix_fav_hom(&hom, &fav, P_FAV));
    }

    /// Mixed attenuation is never above homogeneous and never below favourable
    /// (per band), across a sweep of edge geometries including a two-bump-like
    /// tall/late edge — the property G1 pins for the ON state.
    #[test]
    fn mixed_bands_bounded_by_states() {
        for (d_sg, d_rg, rise) in [
            (1000.0_f64, 1172.0_f64, 25.0_f64), // Kytín-shaped
            (300.0, 1900.0, 60.0),              // tall late edge (two-bump winner shape)
            (50.0, 150.0, 8.0),                 // short urban path
        ] {
            let d_sb = (d_sg * d_sg + rise * rise).sqrt();
            let d_br = (d_rg * d_rg + rise * rise).sqrt();
            let dsr = d_sg + d_rg;
            let gamma = FAV_RAY_CURVATURE_MIN_M.max(FAV_RAY_CURVATURE_PER_DSR * dsr);
            let delta_h = d_sb + d_br - dsr;
            let delta_f = curved_path_difference(d_sb, d_br, dsr, gamma);
            assert!(delta_f < delta_h);
            let hom = maekawa_bands(delta_h, 0.0);
            let fav = maekawa_bands(delta_f, 0.0);
            let mixed = mix_fav_hom(&hom, &fav, P_FAV);
            for i in 0..NUM_BANDS {
                assert!(mixed[i] <= hom[i] + 1e-9 && mixed[i] >= fav[i] - 1e-9);
            }
        }
    }
}
