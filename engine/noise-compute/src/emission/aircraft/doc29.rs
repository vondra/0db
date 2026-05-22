//! Doc 29 4th Edition airborne SEL kernel.
//!
//! Master equation (Eq. 4-8b):
//!   SEL_seg = L_E(P, d_p) + ΔV + ΔI(φ) - Λ(β, l) + ΔF
//!
//! `segment_energy_kernel` is the shared per-segment hot path; both the
//! popup wrapper (`segment_sel::*`) and pipeline-worker scatter delegate
//! here.

use std::f64::consts::{LOG10_2, PI};

use crate::types::AircraftSegment;

use super::npd::{
    AIRCRAFT_FAR_FIELD_THRESHOLD_M, FT_PER_M, Installation, NpdLuts, NpdProfile,
};

// Doc 29 reference value — slightly higher precision than the
// crate-wide `crate::constants::M_PER_DEG_LAT` (110_540.0) used by the
// general geo helpers. Re-exported via `aircraft::*` so external callers
// (e.g. heatmap-aircraft's per-sub-seg line-perpendicular tile-envelope
// prune) project lat/lon to local meters consistent with the kernel's
// own distance math.
pub const M_PER_DEG_LAT: f64 = 111_132.92;

/// Slant² from receiver to the segment evaluated at the same unclamped CPA
/// foot the airborne kernel uses (`segment_energy_kernel`). Conservative
/// pre-filter for the source-reader R-tree loop: rejecting on `> reach²`
/// never drops a real contributor because both this helper and the kernel
/// use identical lateral CPA + altitude-extrapolation geometry, so they
/// produce the same `slant²` for the same `(seg, receiver)`. The kernel
/// can still drop the segment via Filter D — that path stays in the
/// kernel; the pre-filter never falsely rejects.
///
/// Earlier versions clamped altitude to `[min_alt, max_alt]`, which over-
/// estimated slant² for descending/ascending segments whose extrapolated
/// CPA foot crossed receiver elevation. /gg consensus (Codex + Gemini)
/// caught the false-negative band; this formulation matches the kernel
/// exactly.
///
/// `cos_lat` is hoisted by the caller (one cos per query, not per segment).
#[inline]
pub fn segment_min_slant_sq(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    cos_lat: f64,
) -> f64 {
    let m_per_deg_lon = M_PER_DEG_LAT * cos_lat;

    let x1 = (seg.start_lon - rx_lon) * m_per_deg_lon;
    let y1 = (seg.start_lat - rx_lat) * M_PER_DEG_LAT;
    let x2 = (seg.end_lon - rx_lon) * m_per_deg_lon;
    let y2 = (seg.end_lat - rx_lat) * M_PER_DEG_LAT;

    let dx = x2 - x1;
    let dy = y2 - y1;
    let seg_len_sq = dx * dx + dy * dy;
    // Same `inv_lsq * ...` formulation the kernel uses (FP-equivalent to
    // `... / seg_len_sq` only modulo 1 ULP, so we mirror exactly). For
    // degenerate segments (sub-mm horizontal length) `inv_lsq = 0` makes
    // `t = 0`, which is also what the kernel sees — pre-filter never
    // takes a different branch from the kernel.
    let inv_lsq = if seg_len_sq > 1e-6 { 1.0 / seg_len_sq } else { 0.0 };
    let t = -(x1 * dx + y1 * dy) * inv_lsq;
    let cx = x1 + t * dx;
    let cy = y1 + t * dy;
    let lateral_sq = cx * cx + cy * cy;

    let start_alt = seg.start_alt_m as f64;
    let sdz = seg.end_alt_m as f64 - start_alt;
    let rel_alt = start_alt + t * sdz - rx_elev_m;

    lateral_sq + rel_alt * rel_alt
}

/// CPA result for one segment-receiver pair.
pub struct CpaResult {
    pub q_m: f64,            // signed distance from S1 to perpendicular foot
    pub d_p_m: f64,          // perpendicular slant distance (for NPD lookup)
    pub lateral_m: f64,      // horizontal distance to ground track extension
    pub relative_alt_m: f64, // signed altitude at foot relative to receiver
    pub beta_deg: f64,       // elevation angle from ground plane
    pub seg_len_m: f64,      // segment length
    pub t: f64,              // parametric projection (0..1 inside segment, else extrapolation)
}

/// Compute CPA on INFINITE segment extension (Doc 29 §4.4.1).
/// t is NOT clamped — this is the key correctness fix over all other implementations.
#[inline]
pub fn compute_cpa(
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    s1_lat: f64,
    s1_lon: f64,
    s1_alt_m: f64,
    s2_lat: f64,
    s2_lon: f64,
    s2_alt_m: f64,
) -> CpaResult {
    let cos_lat = rx_lat.to_radians().cos().max(0.2);
    let m_per_deg_lon = M_PER_DEG_LAT * cos_lat;

    let x1 = (s1_lon - rx_lon) * m_per_deg_lon;
    let y1 = (s1_lat - rx_lat) * M_PER_DEG_LAT;
    let x2 = (s2_lon - rx_lon) * m_per_deg_lon;
    let y2 = (s2_lat - rx_lat) * M_PER_DEG_LAT;

    let dx = x2 - x1;
    let dy = y2 - y1;
    let seg_len_sq = dx * dx + dy * dy;
    let seg_len = seg_len_sq.sqrt().max(1.0);

    // Parametric projection — NO CLAMP (infinite-line CPA per Doc 29).
    let t = if seg_len_sq > 1e-6 {
        -(x1 * dx + y1 * dy) / seg_len_sq
    } else {
        0.5
    };

    let cx = x1 + t * dx;
    let cy = y1 + t * dy;
    let lateral_m = (cx * cx + cy * cy).sqrt();

    let relative_alt_m = s1_alt_m + t * (s2_alt_m - s1_alt_m) - rx_elev_m;
    let d_p_m = (lateral_m * lateral_m + relative_alt_m * relative_alt_m).sqrt();
    let q_m = t * seg_len;

    let beta_deg = if lateral_m > 0.01 || relative_alt_m.abs() > 0.01 {
        relative_alt_m.atan2(lateral_m).to_degrees()
    } else {
        90.0
    };

    CpaResult {
        q_m,
        d_p_m,
        lateral_m,
        relative_alt_m,
        beta_deg,
        seg_len_m: seg_len,
        t,
    }
}

/// ΔV = 10 × log10(V_ref / V_seg) (Doc 29 §4.5.1, Eq. 4-14).
#[inline]
pub fn delta_v(speed_kt: f64, profile: &NpdProfile) -> f64 {
    if speed_kt > 10.0 {
        10.0 * (profile.v_ref_kt / speed_kt).log10()
    } else {
        0.0
    }
}

/// ΔF finite segment correction (Doc 29 §4.5.6, Eq. 4-20).
/// Full dipole formula with α/(1+α²) terms.
#[inline]
pub fn delta_f(q_m: f64, seg_len_m: f64, d_bar_m: f64) -> f64 {
    if seg_len_m < 1.0 || d_bar_m < 1.0 {
        return 0.0;
    }

    let alpha1 = -q_m / d_bar_m;
    let alpha2 = -(q_m - seg_len_m) / d_bar_m;

    let g1 = alpha1 / (1.0 + alpha1 * alpha1) + alpha1.atan();
    let g2 = alpha2 / (1.0 + alpha2 * alpha2) + alpha2.atan();
    let f = (g2 - g1) / PI;

    10.0 * f.max(1e-15).log10()
}

// `fast_atan` / `fast_delta_f` / `fast_lateral_attenuation` replace libm
// `atan` (~50-80 cycles) with a Padé [3/2] approximation (~8 cycles) at the
// cost of < 0.05 dB error per ΔF and < 0.15 dB per Λ. Pipeline ships all
// tile output through these, popup follows so popup ≡ tile parity is by
// construction (same approximations, same regime). The exact variants
// above remain for verification, tests, and any future acoustically
// strict caller.

/// Padé [3/2] atan for |x| ≤ 1. Max error 0.0034 rad (0.19°).
#[inline(always)]
fn fast_atan_small(x: f64) -> f64 {
    let x2 = x * x;
    x * (1.0 + 0.1827 * x2) / (1.0 + 0.5124 * x2)
}

/// `atan(x)` via Padé [3/2] over the full real line. Max error ~0.003 rad.
#[inline(always)]
pub fn fast_atan(x: f64) -> f64 {
    if x.abs() > 1.0 {
        return x.signum() * std::f64::consts::FRAC_PI_2 - fast_atan_small(1.0 / x);
    }
    fast_atan_small(x)
}

/// Padé-atan variant of `delta_f`. Max error vs exact: < 0.05 dB.
#[inline]
pub fn fast_delta_f(q_m: f64, seg_len_m: f64, d_bar_m: f64) -> f64 {
    if seg_len_m < 1.0 || d_bar_m < 1.0 {
        return 0.0;
    }
    let alpha1 = -q_m / d_bar_m;
    let alpha2 = -(q_m - seg_len_m) / d_bar_m;

    let g1 = alpha1 / (1.0 + alpha1 * alpha1) + fast_atan(alpha1);
    let g2 = alpha2 / (1.0 + alpha2 * alpha2) + fast_atan(alpha2);
    let f = (g2 - g1) * std::f64::consts::FRAC_1_PI;

    10.0 * f.max(1e-15).log10()
}

/// Fast lateral attenuation. Computes `β` via `fast_atan` (no atan2) from
/// `rel_alt / lateral_m`, then applies the Doc 29 §4.5.4 Γ × Λ(β) formula
/// using the same Doc 29 piecewise. Skips the `atan2` call (caller passes
/// rel_alt + lateral instead of beta_deg + lateral). For `airport_ground`
/// callers Λ collapses to 0 — this kernel does the same gate.
/// Max error vs exact: < 0.15 dB per segment.
///
/// Λ(β) ≠ 0 only for **Wing-mounted jets** per Doc 29 §4.5.4 Eq. 4-19a /
/// FAA AEDT TM §6.2.4. Fuselage-mounted engines and propeller installations
/// (including helicopters) get Λ = 0 — engine-airframe geometry doesn't
/// produce wing-shielding lateral attenuation in those cases.
#[inline]
pub fn fast_lateral_attenuation(
    rel_alt: f64,
    lateral_m: f64,
    airport_ground: bool,
    installation: Installation,
) -> f64 {
    if airport_ground || !matches!(installation, Installation::Wing) {
        return 0.0;
    }

    let beta_deg = fast_atan(rel_alt / lateral_m.max(0.01)).to_degrees();
    if beta_deg > 50.0 || beta_deg < 0.0 {
        return if beta_deg < 0.0 { 10.857 } else { 0.0 };
    }

    let gamma = if lateral_m <= 914.0 {
        1.089 * (1.0 - (-0.00274 * lateral_m).exp())
    } else {
        1.0
    };

    let lambda_beta = 1.137 - 0.0229 * beta_deg + 9.72 * (-0.142 * beta_deg).exp();
    gamma * lambda_beta
}

/// Per-installation `(installation, di_a, di_b, di_c)` constants for the
/// inline ΔI formula in `segment_energy_kernel`. Returning the `Installation`
/// echo lets pipeline's SoA build store both the enum and the trig
/// coefficients in one call. Output of the inline formula matches
/// `delta_i(beta_deg, installation)` to FP rounding for the same
/// `(rel_alt, slant)` pair, so swapping in this fast path doesn't move
/// popup ↔ tile parity.
#[inline]
pub fn delta_i_constants(installation: Installation) -> (Installation, f64, f64, f64) {
    match installation {
        Installation::Wing => (Installation::Wing, 0.0039, 0.062, 0.8786),
        Installation::Fuselage => (Installation::Fuselage, 0.1225, 0.329, 1.0),
        Installation::Propeller => (Installation::Propeller, 0.0, 0.0, 1.0),
    }
}

/// Output of the shared airborne kernel. Energy is what pipeline
/// accumulates; SEL + a few CPA fields cover everything popup needs for
/// trace bookkeeping (peak altitude, min slant) without rebuilding a
/// separate per-segment CPA pass.
#[derive(Clone, Copy, Debug)]
pub struct AircraftKernelResult {
    /// `exp(SEL · ln(10) · 0.1)` — accumulator-ready energy.
    pub energy: f64,
    /// SEL in dB after Doc 29 master Eq. 4-8b.
    pub sel: f64,
    /// Slant distance from receiver to CPA foot.
    pub d_p_m: f64,
    /// Signed altitude at CPA foot relative to `rcv_elev`.
    pub rel_alt_m: f64,
    /// Signed parametric distance from segment start to CPA foot.
    pub q_m: f64,
    /// Segment length (input echo).
    pub seg_len_m: f64,
    /// Horizontal CPA distance (perpendicular to ground track).
    pub lateral_m: f64,
    /// Elevation angle β from ground plane (degrees). For CFFK fast-path
    /// hits we don't need β to compute λ, so the kernel sets it to a
    /// 90° sentinel rather than paying for `fast_atan` — popup callers
    /// that need β at cruise distance recompute it themselves.
    pub beta_deg: f64,
    /// Unclamped parametric projection (foot in [0,1] = inside segment).
    pub t: f64,
}

/// Shared Doc 29 per-segment kernel: CPA → reach gate → Filter D → NPD →
/// CFFK fast path or full ΔF / Λ / ΔI corrections → SEL → energy. Inputs
/// are pre-projected by the caller (receiver-local meters), so popup pays
/// one cos/sin per receiver and pipeline pays them once at
/// `ProjectedAircraft::build`.
///
/// **Filter D** rejects per-(segment, receiver) pairs where BOTH the CPA
/// foot `t` falls outside the observed endpoints (`t ∉ [0, 1]`, i.e. the
/// implied aircraft position is a straight-line projection past the last
/// trace sample) AND the linearly-extrapolated altitude at the foot is
/// > 30 m below terrain at `(foot_lat, foot_lon)`. Airport-ground segments
/// bypass the filter (they set `terrain_*_cut_m = f64::MIN`).
///
/// Why the `t ∈ [0, 1]` gate: legitimate cases keep CPA inside the
/// observed segment (Schiphol-style sub-sea descents have CPA within the
/// descent segment; hill-top receivers with aircraft in a valley have CPA
/// within the cruise segment). Only fictional extrapolations past
/// touchdown or beyond the last cruise sample can land outside `[0, 1]`.
///
/// Why the 30 m margin (encoded as `terrain_*_cut_m = terrain - 30 m`
/// pre-computed at hex load): DEM error plus short-segment extrapolation
/// uncertainty.
///
/// Historical: an earlier blanket filter at `CPA rel_alt < -50 m` / jet
/// `rel_alt < 30 m AGL` was tried and removed after independent review —
/// it created spatial discontinuities for valid hill-top receivers.
/// Filter D is the geometry-aware replacement.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn segment_energy_kernel(
    ax: f64,
    ay: f64,
    sdx: f64,
    sdy: f64,
    sdz: f64,
    sz1: f64,
    inv_lsq: f64,
    slen: f64,
    rcv_elev: f64,
    npd_luts: &NpdLuts,
    noise_class: usize,
    is_dep: bool,
    seg_dv: f64,
    d_bar_m: f64,
    inst: Installation,
    di_a: f64,
    di_b: f64,
    di_c: f64,
    airport_ground: bool,
    reach_sq: f64,
    terrain_start_cut_m: f64,
    terrain_end_cut_m: f64,
) -> Option<AircraftKernelResult> {
    let t = -(ax * sdx + ay * sdy) * inv_lsq;
    let cpx = ax + t * sdx;
    let cpy = ay + t * sdy;
    let lateral_sq = cpx * cpx + cpy * cpy;

    let rel_alt = sz1 + t * sdz - rcv_elev;
    let slant_sq = lateral_sq + rel_alt * rel_alt;
    if slant_sq > reach_sq {
        return None;
    }

    // Filter D: reject sub-terrain extrapolation past observed endpoints.
    if t < 0.0 {
        if sz1 + t * sdz < terrain_start_cut_m {
            return None;
        }
    } else if t > 1.0 && sz1 + t * sdz < terrain_end_cut_m {
        return None;
    }

    let d_p_m = slant_sq.sqrt();
    let d_ft = (d_p_m * FT_PER_M).max(100.0);
    // log2 × log10(2) is identical to log10 to f64 precision and skips
    // the libm log10 division by ln(10) — saves a few cycles per call,
    // pipeline already shipped this way.
    let log_d = d_ft.log2() * LOG10_2;
    let sel_npd = npd_luts.lookup(noise_class, is_dep, log_d);

    // CFFK fast path: above 7.62 km slant Λ and ΔI collapse to within
    // fractions of a dB and the kernel can skip them; ΔF stays.
    //
    // For long aggregated segments **with the unclamped CPA foot well
    // inside the endpoints** (t in (q_m/d_bar, (slen-q_m)/d_bar) both
    // ≫ 1) ΔF ≈ 0 — matches the previous skip within fractions of a dB.
    // For aggregated segments where the foot is near an endpoint or
    // outside (e.g., receiver off the side of a 50 km cruise leg), ΔF
    // correctly suppresses by 3-10 dB; the previous skip was a latent
    // Doc 29 deviation, fixed here.
    //
    // For per-sample airborne (Commit A): one sub-segment owns the foot
    // (ΔF ≈ 0 → full event energy); the other N-1 sub-segments project
    // the foot far outside their endpoints (α₁, α₂ same sign, |α| ≫ 1
    // ⇒ f → 0 ⇒ ΔF strongly negative ⇒ negligible energy). Sum across
    // sub-segments converges to one event, avoiding the N× over-count
    // the previous skip would produce for collinear short segments.
    if d_p_m > AIRCRAFT_FAR_FIELD_THRESHOLD_M {
        let q_m = t * slen;
        let df = fast_delta_f(q_m, slen, d_bar_m);
        let sel = sel_npd + seg_dv + df;
        if sel < 20.0 {
            return None;
        }
        let energy = (sel * std::f64::consts::LN_10 * 0.1).exp();
        return Some(AircraftKernelResult {
            energy,
            sel,
            d_p_m,
            rel_alt_m: rel_alt,
            q_m,
            seg_len_m: slen,
            lateral_m: lateral_sq.sqrt(),
            beta_deg: 90.0, // CFFK doesn't need β; sentinel
            t,
        });
    }

    let q_m = t * slen;
    let df = fast_delta_f(q_m, slen, d_bar_m);

    let lateral_m = lateral_sq.sqrt();
    let lambda = fast_lateral_attenuation(rel_alt, lateral_m, airport_ground, inst);

    // Inline ΔI: works off u² = rel_alt²/slant² (= sin²β) instead of trig
    // on β. Identical math to `delta_i(beta_deg, installation)` for the
    // same (rel_alt, slant) — verified to FP rounding.
    let di = if matches!(inst, Installation::Propeller) {
        0.0
    } else {
        let rel_alt_di = rel_alt.max(0.0);
        let u2 = (rel_alt_di * rel_alt_di) / slant_sq.max(1e-12);
        let v2 = 1.0 - u2;
        let x = di_a * v2 + u2;
        let den = di_c * (4.0 * u2 * v2) + (v2 - u2) * (v2 - u2);
        if den > 0.0 && x > 0.0 {
            // 4.342944819032518 = 10 / ln(10) → converts ln to dB.
            4.342944819032518_f64 * (di_b * x.ln() - den.ln())
        } else {
            0.0
        }
    };

    let sel = sel_npd + seg_dv + di - lambda + df;
    if sel < 20.0 {
        return None;
    }
    let energy = (sel * std::f64::consts::LN_10 * 0.1).exp();
    let beta_deg = fast_atan(rel_alt / lateral_m.max(0.01)).to_degrees();

    Some(AircraftKernelResult {
        energy,
        sel,
        d_p_m,
        rel_alt_m: rel_alt,
        q_m,
        seg_len_m: slen,
        lateral_m,
        beta_deg,
        t,
    })
}

/// Lateral attenuation Λ(β, l) = Γ(l) × Λ(β) (Doc 29 §4.5.4, Eq. 4-18/4-19).
///
/// Only applied to **Wing-mounted jets** per Eq. 4-19a / FAA AEDT TM §6.2.4.
/// Fuselage-mounted engines, propeller installations, and helicopters get
/// Λ = 0 (no engine-wing shielding).
#[inline]
pub fn lateral_attenuation(beta_deg: f64, lateral_m: f64, installation: Installation) -> f64 {
    if !matches!(installation, Installation::Wing) {
        return 0.0;
    }
    if beta_deg < 0.0 {
        return 10.857;
    }

    let gamma = if lateral_m <= 914.0 {
        1.089 * (1.0 - (-0.00274 * lateral_m).exp())
    } else {
        1.0
    };

    let lambda_beta = if beta_deg <= 50.0 {
        1.137 - 0.0229 * beta_deg + 9.72 * (-0.142 * beta_deg).exp()
    } else {
        0.0
    };

    gamma * lambda_beta
}

/// ΔI engine installation correction (Doc 29 §4.5.3, Eq. 4-15).
#[inline]
pub fn delta_i(phi_deg: f64, installation: Installation) -> f64 {
    match installation {
        Installation::Propeller => 0.0,
        Installation::Wing | Installation::Fuselage => {
            let (a, b, c) = match installation {
                Installation::Wing => (0.0039_f64, 0.062_f64, 0.8786_f64),
                Installation::Fuselage => (0.1225_f64, 0.329_f64, 1.0_f64),
                _ => unreachable!(),
            };
            let phi = phi_deg.max(0.0).to_radians();
            let cos_phi = phi.cos();
            let sin_phi = phi.sin();
            let cos_2phi = (2.0 * phi).cos();
            let sin_2phi = (2.0 * phi).sin();

            let numerator = (a * cos_phi * cos_phi + sin_phi * sin_phi).powf(b);
            let denominator = c * sin_2phi * sin_2phi + cos_2phi * cos_2phi;

            if denominator > 0.0 && numerator > 0.0 {
                10.0 * (numerator / denominator).log10()
            } else {
                0.0
            }
        }
    }
}

/// Period durations in seconds (EU Directive 2002/49/EC).
pub const PERIOD_SECONDS: [f64; 3] = [43200.0, 14400.0, 28800.0];

/// Convert period energy sum to Leq (Doc 29 §5, Eq. 5-1).
/// Divides by n_days × period_seconds.
#[inline]
pub fn period_leq(total_energy: f64, n_days: f64, period_seconds: f64) -> f64 {
    if total_energy <= 0.0 || n_days <= 0.0 {
        return f64::NEG_INFINITY;
    }
    10.0 * (total_energy / (n_days * period_seconds)).log10()
}

#[cfg(test)]
mod tests {
    use super::super::npd::PROFILES;
    use super::*;

    #[test]
    fn test_cpa_alongside() {
        let cpa = compute_cpa(50.005, 14.01, 300.0, 50.0, 14.0, 1000.0, 50.01, 14.0, 1000.0);
        assert!(cpa.q_m > 0.0, "q should be positive");
        assert!(cpa.d_p_m > 500.0 && cpa.d_p_m < 2000.0, "d_p = {}", cpa.d_p_m);
        assert!(cpa.beta_deg > 20.0 && cpa.beta_deg < 70.0, "β = {}", cpa.beta_deg);
    }

    #[test]
    fn test_cpa_behind_segment() {
        let cpa = compute_cpa(49.99, 14.01, 300.0, 50.0, 14.0, 1000.0, 50.01, 14.0, 1000.0);
        assert!(cpa.q_m < 0.0, "q should be negative (behind), got {}", cpa.q_m);
    }

    #[test]
    fn test_cpa_directly_below() {
        let cpa = compute_cpa(50.005, 14.0, 300.0, 50.0, 14.0, 3000.0, 50.01, 14.0, 3000.0);
        assert!(cpa.lateral_m < 50.0, "lateral should be ~0, got {}", cpa.lateral_m);
        assert!(cpa.beta_deg > 80.0, "β should be ~90°, got {}", cpa.beta_deg);
    }

    #[test]
    fn test_cpa_below_receiver_keeps_signed_altitude() {
        let cpa = compute_cpa(
            49.7846, 14.0306, 684.0, 49.7813, 14.0350, 0.0, 49.7863, 14.0283, 0.0,
        );
        assert!(cpa.lateral_m < 50.0, "lateral should stay near the ridge crossing, got {}", cpa.lateral_m);
        assert!(cpa.relative_alt_m < -600.0, "relative altitude should stay signed, got {}", cpa.relative_alt_m);
        assert!(cpa.d_p_m > 600.0, "slant distance should include the vertical gap, got {}", cpa.d_p_m);
        assert!(cpa.beta_deg < 0.0, "beta should be negative for segments below the receiver, got {}", cpa.beta_deg);
    }

    #[test]
    fn test_delta_v_at_reference() {
        assert!(delta_v(160.0, &PROFILES[0]).abs() < 0.001);
    }

    #[test]
    fn test_delta_v_slow() {
        let dv = delta_v(80.0, &PROFILES[0]);
        assert!((dv - 3.01).abs() < 0.1, "ΔV = {dv}");
    }

    #[test]
    fn test_delta_f_alongside() {
        let df = delta_f(500.0, 1000.0, 370.0);
        assert!(df < 0.0 && df > -10.0, "ΔF = {df}");
    }

    #[test]
    fn test_delta_f_behind() {
        let df = delta_f(-500.0, 1000.0, 370.0);
        assert!(df < -5.0, "ΔF behind = {df}");
    }

    #[test]
    fn test_lateral_directly_below() {
        let att = lateral_attenuation(90.0, 0.0, Installation::Wing);
        assert!(att.abs() < 0.01, "Expected 0, got {att}");
    }

    #[test]
    fn test_lateral_far_side() {
        let att = lateral_attenuation(0.1, 2000.0, Installation::Wing);
        assert!((att - 10.86).abs() < 0.2, "Expected ~10.86, got {att}");
    }

    #[test]
    fn test_lateral_negative_beta() {
        let att = lateral_attenuation(-5.0, 100.0, Installation::Wing);
        assert!((att - 10.857).abs() < 0.01);
    }

    /// Doc 29 §4.5.4 / FAA AEDT TM §6.2.4: Λ ≠ 0 only for Wing-mounted jets.
    #[test]
    fn test_lateral_non_wing_installations_zero() {
        for beta in [0.1, 10.0, 30.0, 50.0, 90.0] {
            for lat in [50.0, 500.0, 2000.0, 5000.0] {
                assert_eq!(lateral_attenuation(beta, lat, Installation::Fuselage), 0.0);
                assert_eq!(lateral_attenuation(beta, lat, Installation::Propeller), 0.0);
            }
        }
    }

    #[test]
    fn test_fast_lateral_non_wing_installations_zero() {
        for &(rel_alt, lat) in &[(50.0, 500.0), (200.0, 500.0), (1000.0, 500.0), (5000.0, 100.0)] {
            assert_eq!(fast_lateral_attenuation(rel_alt, lat, false, Installation::Fuselage), 0.0);
            assert_eq!(fast_lateral_attenuation(rel_alt, lat, false, Installation::Propeller), 0.0);
        }
    }

    #[test]
    fn test_delta_i_propeller() {
        assert_eq!(delta_i(45.0, Installation::Propeller), 0.0);
    }

    #[test]
    fn test_delta_i_wing() {
        let di = delta_i(30.0, Installation::Wing);
        assert!(di.abs() < 2.0, "ΔI = {di}");
    }

    #[test]
    fn test_period_leq() {
        let energy = 1000.0 * 10f64.powf(91.0 / 10.0);
        let leq = period_leq(energy, 365.0, PERIOD_SECONDS[0]);
        assert!(leq > 40.0 && leq < 80.0, "Leq = {leq}");
    }

    /// Doc 29 §A.3.4 invariant: emitting N collinear sub-segments must
    /// give the same total linear energy as one aggregated segment over
    /// the same geometry. CFFK previously skipped ΔF in the far field
    /// (slant > 7.62 km), which let each sub-segment re-emit the full
    /// event and over-counted by factor N. With ΔF restored, the
    /// off-foot sub-segments collapse to ~0 and the foot-owning piece
    /// contributes the full event.
    #[test]
    fn cffk_partition_preserves_linear_energy() {
        use super::super::npd::{CLASS_REP_PROFILE_IDX, REACH_SQ_TABLE};
        let npd_luts = NpdLuts::shared();
        let class_idx = 0; // WING_FALLBACK
        let profile = &PROFILES[CLASS_REP_PROFILE_IDX[class_idx] as usize];
        let (inst_code, di_a, di_b, di_c) = delta_i_constants(profile.installation);
        let reach_sq = REACH_SQ_TABLE[class_idx][1]; // departure
        // Geometry: 20 km-long flight at 8 km altitude, receiver 8 km
        // off to the side at sea level → slant ~11 km (far field).
        let start_x = -10_000.0;
        let start_y = 8_000.0;
        let end_x = 10_000.0;
        let end_y = 8_000.0;
        let alt_m = 8_000.0;
        let dv = delta_v(profile.v_ref_kt, profile);
        let kernel = |ax: f64, ay: f64, sdx: f64, sdy: f64, slen: f64| {
            let inv_lsq = 1.0 / (sdx * sdx + sdy * sdy);
            segment_energy_kernel(
                ax, ay, sdx, sdy, 0.0,
                alt_m, inv_lsq, slen, 0.0,
                npd_luts, class_idx, true, dv,
                profile.d_bar_m, inst_code, di_a, di_b, di_c,
                false, reach_sq, f64::MIN, f64::MIN,
            )
        };
        // One aggregated segment.
        let agg = kernel(start_x, start_y, end_x - start_x, end_y - start_y, 20_000.0).unwrap();
        // Same geometry split into 10 collinear sub-segments.
        let n = 10;
        let mut sum_energy = 0.0;
        for i in 0..n {
            let t0 = i as f64 / n as f64;
            let t1 = (i + 1) as f64 / n as f64;
            let sx = start_x + (end_x - start_x) * t0;
            let ex = start_x + (end_x - start_x) * t1;
            let slen = (end_x - start_x) / n as f64;
            if let Some(r) = kernel(sx, start_y, ex - sx, 0.0, slen) {
                sum_energy += r.energy;
            }
        }
        let ratio = sum_energy / agg.energy;
        assert!(
            (0.7..1.3).contains(&ratio),
            "partition / aggregate energy ratio = {ratio:.3} (expected ~1.0)"
        );
    }
}
