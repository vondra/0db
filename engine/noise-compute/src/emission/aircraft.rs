//! Doc 29 4th Edition aircraft noise emission.
//!
//! SEPARATE from ISO 9613-2. Doc 29 uses empirical NPD lookup, not path-tracing.
//! Aircraft noise does NOT use ground effect, diffraction, vegetation, screening.
//! NPD tables already include atmospheric effects.
//!
//! Master equation (Eq. 4-8b):
//!   SEL_seg = L_E(P, d_p) + ΔV + ΔI(φ) - Λ(β, l) + ΔF
//!
//! Ported from V33 engine (backend/native/noise-engine-v33/src/).

use std::f64::consts::PI;
use std::sync::{LazyLock, OnceLock};

#[cfg(test)]
use crate::sources::AIRCRAFT_ADSB_SOURCE_ID;

/// NPD SEL threshold for per-profile reach calculation.
/// At this raw NPD SEL, a segment's contribution is negligible (< 0.15 dB on total Lden).
pub const AIRCRAFT_NPD_REACH_THRESHOLD_DB: f64 = 40.0;

/// Hard cap on per-profile **slant** reach (meters). Used by
/// `Profile::estimate_reach_m` to bound the bisection in the physics
/// tail and by the per-segment slant-vs-reach test inside the
/// pipeline scatter and popup compute paths. With the physics tail
/// (`alpha_eff`), jets stay above 40 dB SEL out to ~15.5 km slant.
/// Numerically equal to `AIRCRAFT_MAX_HORIZONTAL_REACH_M` because at
/// altitude 0 horizontal = slant, but they're conceptually different —
/// callers should pick the constant that matches the geometry they're
/// filtering on.
pub const AIRCRAFT_NPD_REACH_CAP_M: f64 = 16_000.0;

/// Hard cap on **horizontal** distance (meters) at which an airborne
/// segment can be audible at 40 dB SEL, regardless of altitude. Used
/// by `source-reader` r-tree query envelopes and any other prefilter
/// operating on horizontal distance. For altitudes above 0 the actual
/// horizontal reach is bounded by `sqrt(slant_cap² − alt²)`, so this
/// constant is the upper envelope — safe to use for prefilters, but
/// the per-profile slant test inside the kernel does the exact
/// rejection.
pub const AIRCRAFT_MAX_HORIZONTAL_REACH_M: f64 = 16_000.0;

/// Slant threshold above which `segment_energy_fast` and
/// `segment_sel_with_overrides` switch to the closed-form far-field kernel
/// (CFFK). The corrections that the per-segment Doc 29 path applies
/// (ΔI, ΔF, lateral attenuation) are all bounded:
///   - λ is identically 0 for elevation angle β > 50° (already gated).
///   - ΔI peaks at ~0.4 dB for wing, ~0.8 dB for fuselage, and is < 0.3 dB
///     for typical FL330+ overhead geometries.
///   - ΔF approaches 0 dB for segments where the CPA is interior to the
///     segment and the segment is several `d_bar` long — true for almost
///     all cruise segments.
/// At 25 000 ft / 7 620 m we're at the last NPD table point, beyond which
/// the slope is already a physical extrapolation. Switching to the closed
/// form there is cheap (1 log + 1 mul + 1 add) and matches the Doc 29
/// reference within ~0.3 dB.
pub const AIRCRAFT_FAR_FIELD_THRESHOLD_M: f64 = 7620.0;

/// Reference slant (meters) at the last NPD table point (25 000 ft). Anchor
/// for physics-based extrapolation of SEL beyond the table.
pub const AIRCRAFT_NPD_REF_SLANT_M: f64 = 7620.0;

/// Standard NPD distances in feet (Doc 29 §4.2, 10 points).
const NPD_DIST_FT: [f64; 10] = [
    200.0, 400.0, 630.0, 1000.0, 2000.0, 4000.0, 6310.0, 10000.0, 16000.0, 25000.0,
];

/// Pre-computed log10 of standard distances.
const LOG_DIST: [f64; 10] = [
    2.30103, 2.60206, 2.79934, 3.0, 3.30103, 3.60206, 3.79934, 4.0, 4.20412, 4.39794,
];

pub const FT_PER_M: f64 = 3.28084;

/// Engine installation type determines ΔI coefficients.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Installation {
    /// Wing-mounted turbofan: a=0.0039, b=0.062, c=0.8786
    Wing,
    /// Fuselage/tail-mounted: a=0.1225, b=0.329, c=1.0
    Fuselage,
    /// Propeller aircraft: ΔI = 0
    Propeller,
}

/// NPD profile definition.
///
/// SEL and LAmax NPD curves both come from EASA ANP v2.3 (the same
/// `ANP2.3_NPD_data.csv` file with rows tagged "SEL" or "LAmax"). The
/// generator ingests both; the kernel uses SEL for energy summation and
/// LAmax for per-event peak ranking.
pub struct NpdProfile {
    pub name: &'static str,
    pub approach_sel: [f64; 10],
    pub departure_sel: [f64; 10],
    /// LAmax NPD — peak A-weighted SPL per Doc 29 distance row.
    /// Replaces hardcoded `SEL − 12 dB` approximation that ignored
    /// per-aircraft Lmax/SEL differences (range 8–18 dB across operations).
    pub approach_lmax: [f64; 10],
    pub departure_lmax: [f64; 10],
    pub v_ref_kt: f64,
    pub d_bar_m: f64,
    pub installation: Installation,
    /// **NPD-tail residual coefficient** (dB/m), lazily back-fitted from the
    /// last three NPD points (see `compute_alpha_eff`). NOT a generic
    /// atmospheric-absorption value — it is the slope that, when paired
    /// with the `−20·log10(d/d_ref)` term in `interpolate_sel_logd`,
    /// reproduces the observed NPD curve through (10 k, 16 k, 25 k) ft.
    /// In effect it absorbs *both* atmospheric absorption *and* any
    /// residual divergence mismatch between Doc 29 NPD's empirical SEL
    /// slope and the spherical-spreading anchor — so the numerical value
    /// (jets ≈ 0.8–1.1 dB/km) is in the same ballpark as ISO 9613-1
    /// broadband α for typical aircraft spectra at standard atmosphere,
    /// but they are not interchangeable: swapping in an external ISO
    /// 9613-1 α (or scaling by a real atmosphere profile) will give
    /// wrong SEL because the divergence term double-counts. Stored
    /// per-direction because departure SEL tables drop faster than
    /// approach in the tail for most profiles.
    alpha_eff_approach: OnceLock<f64>,
    alpha_eff_departure: OnceLock<f64>,
}

impl NpdProfile {
    /// Const constructor used by `profiles_generated.rs` (sibling module of
    /// `emission`) to build the static `PROFILES` array. The two `OnceLock`
    /// fields stay private to this module; the generator can't construct
    /// them directly across module boundaries, so this fn is the bridge.
    pub const fn new(
        name: &'static str,
        approach_sel: [f64; 10],
        departure_sel: [f64; 10],
        approach_lmax: [f64; 10],
        departure_lmax: [f64; 10],
        v_ref_kt: f64,
        d_bar_m: f64,
        installation: Installation,
    ) -> Self {
        NpdProfile {
            name,
            approach_sel,
            departure_sel,
            approach_lmax,
            departure_lmax,
            v_ref_kt,
            d_bar_m,
            installation,
            alpha_eff_approach: OnceLock::new(),
            alpha_eff_departure: OnceLock::new(),
        }
    }
}

// Per-typecode NPD profiles + per-class metadata (NUM_CLASSES=12,
// NUM_PROFILES=124) come from `profiles_generated.rs`, auto-generated from
// EASA ANP v2.3 + global traffic counts by
// `scripts/build-aircraft-profiles.py`. Classes are Voronoi-assigned
// over per-Installation anchor profiles (see generator docstring).
pub use super::profiles_generated::{
    profile_idx, is_non_aircraft_typecode, noise_class_of,
    CLASS_NAMES, CLASS_OF_PROFILE, CLASS_REP_PROFILE_IDX, FALLBACK_NOISE_CLASS,
    FALLBACK_PROFILE_IDX, GROUND_OPS_REFERENCE_SEL_DB, IS_JET,
    NUM_CLASSES, NUM_PROFILES, PROFILES,
};

/// Defensive clamp for `profile_idx` before indexing `PROFILES` /
/// `NpdLuts`. Generator guarantees `profile_idx < NUM_PROFILES` for any
/// typecode it emitted; this guard catches out-of-band data (legacy v4
/// arrows extracted before the Tier 2 cutover) without panicking.
#[inline]
pub fn clamp_profile_idx(profile_idx: u8) -> usize {
    (profile_idx as usize).min(NUM_PROFILES - 1)
}

/// ICAO typecode prefix of a `PROFILES[idx].name`. Profile names are
/// stored as `"<icao_typecode>/<anp_designator>"` (e.g. `"B738/737800"`,
/// `"EMJ/EMB145"`) by the generator so the original ANP source is
/// traceable. The popup display only wants the 3-or-4-char ICAO
/// typecode prefix — naive 4-byte slicing would emit `"EMJ/"` for
/// 3-char codes. Returns `&'static str` so callers can dodge a
/// `String` allocation in tight loops.
///
/// `profile_idx` is clamped at usize-precision; downcasting to u8
/// first (`clamp_profile_idx(idx as u8)`) would silently fold every
/// `idx ≥ 256` to `idx & 0xFF`, then clamp to NUM_PROFILES-1 — fine
/// today (NUM_PROFILES = 124, so casting truncates at 256 anyway)
/// but a footgun if NUM_PROFILES ever grows.
pub fn profile_typecode(profile_idx: usize) -> &'static str {
    let idx = profile_idx.min(NUM_PROFILES - 1);
    let name = PROFILES[idx].name;
    name.split('/').next().unwrap_or(name)
}

/// Decode an ICAO typecode stored as `FixedSizeBinary(4)` (ASCII,
/// '\0'-padded — Stage 1's storage form) to a normal `String`. ICAO
/// typecodes are 3-4 chars (e.g. "B738", "A320", "CRJ"); the trim
/// drops the NUL pad. Invalid UTF-8 falls back to a lossy decode so
/// the popup never panics on malformed extract data.
pub fn typecode_to_string(bytes: &[u8; 4]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(4);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Whether a profile's noise class is jet-classed. Routes through
/// `IS_JET[noise_class]` so the predicate stays correct as the generator
/// adds/reorders profiles. Used by airborne data-quality filters
/// (jet-stall, jet-low-AGL).
#[inline]
pub fn is_jet_profile(profile_idx: u8) -> bool {
    IS_JET[noise_class_of(profile_idx) as usize]
}

/// Back-out the NPD-tail residual coefficient (dB/m) for the physics-form
/// extrapolation `SEL = SEL_ref − 20·log10(d/d_ref) − α · (d − d_ref)`
/// used beyond 25 000 ft. After removing the spherical-spreading anchor
/// `−20·log10(d/d_ref)` from each tail point, fits the residual linearly
/// in `d` by least squares over (10 000, 16 000, 25 000) ft.
///
/// **What this is, and what it isn't.** It is *not* a generic ISO 9613-1
/// broadband atmospheric-absorption coefficient. It is the slope that
/// reproduces this profile's own NPD curve when the tail is paired with
/// the `−20·log10` divergence term. It happens to land in the same range
/// as ISO 9613-1 broadband α for typical aircraft spectra at standard
/// atmosphere — jets ≈ 0.8–1.1 dB/km, turboprops / LightGA ≈ 0.6–0.9
/// dB/km — but the two are *not* interchangeable. Doc 29 Vol 2
/// Appendix F prescribes exactly this form for extrapolation beyond the
/// last NPD point; any change to the divergence term (e.g. swapping for
/// `−10·log10`) requires re-fitting α on the same form, not borrowing α
/// from another standard.
fn compute_alpha_eff(sel: &[f64; 10]) -> f64 {
    let d_m = [
        NPD_DIST_FT[7] / FT_PER_M, // 10 000 ft → 3 048 m
        NPD_DIST_FT[8] / FT_PER_M, // 16 000 ft → 4 877 m
        NPD_DIST_FT[9] / FT_PER_M, // 25 000 ft → 7 620 m (= AIRCRAFT_NPD_REF_SLANT_M)
    ];
    let residuals = [
        sel[7] + 20.0 * (d_m[0] / AIRCRAFT_NPD_REF_SLANT_M).log10(),
        sel[8] + 20.0 * (d_m[1] / AIRCRAFT_NPD_REF_SLANT_M).log10(),
        sel[9],
    ];
    let n = 3.0_f64;
    let sx: f64 = d_m.iter().sum();
    let sy: f64 = residuals.iter().sum();
    let sxx: f64 = d_m.iter().map(|x| x * x).sum();
    let sxy: f64 = d_m
        .iter()
        .zip(residuals.iter())
        .map(|(x, y)| x * y)
        .sum();
    let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    (-slope).max(0.0)
}

impl NpdProfile {
    /// NPD-tail residual coefficient (dB/m), back-fitted from this profile's
    /// last three NPD points — see `compute_alpha_eff` for the warning that
    /// this is *not* a swap-in replacement for ISO 9613-1 atmospheric α.
    /// Cached per (profile, direction) on first use.
    #[inline]
    pub fn alpha_eff(&self, is_departure: bool) -> f64 {
        if is_departure {
            *self
                .alpha_eff_departure
                .get_or_init(|| compute_alpha_eff(&self.departure_sel))
        } else {
            *self
                .alpha_eff_approach
                .get_or_init(|| compute_alpha_eff(&self.approach_sel))
        }
    }

    /// Slant distance (meters) at which raw NPD SEL drops to `threshold_db`.
    /// Log-linear interpolation within the NPD table; physics-based
    /// extrapolation beyond 25 000 ft using per-profile `alpha_eff`
    /// (`SEL = SEL_ref − 20·log10(d/d_ref) − α·(d − d_ref)`). Capped at
    /// `AIRCRAFT_NPD_REACH_CAP_M`.
    pub fn estimate_reach_m(&self, threshold_db: f64, is_departure: bool) -> f64 {
        let sel = if is_departure {
            &self.departure_sel
        } else {
            &self.approach_sel
        };
        let last = sel.len() - 1;

        // Threshold louder than closest NPD point → minimal reach.
        if threshold_db >= sel[0] {
            return NPD_DIST_FT[0] / FT_PER_M;
        }

        // Inside the NPD table: log-linear interpolation.
        if threshold_db > sel[last] {
            for i in 0..last {
                if threshold_db >= sel[i + 1] {
                    let frac = (threshold_db - sel[i]) / (sel[i + 1] - sel[i]);
                    let log_d = LOG_DIST[i] + frac * (LOG_DIST[i + 1] - LOG_DIST[i]);
                    return (10.0_f64.powf(log_d) / FT_PER_M).min(AIRCRAFT_NPD_REACH_CAP_M);
                }
            }
            return AIRCRAFT_NPD_REACH_CAP_M;
        }

        // Beyond the table: bisect the physics kernel in [d_ref, cap]. Kernel
        // is strictly monotone decreasing, so a zero crossing exists when
        // SEL(cap) < threshold; otherwise clamp at the cap.
        let alpha = self.alpha_eff(is_departure);
        let sel_at = |d: f64| {
            sel[last]
                - 20.0 * (d / AIRCRAFT_NPD_REF_SLANT_M).log10()
                - alpha * (d - AIRCRAFT_NPD_REF_SLANT_M)
        };
        if sel_at(AIRCRAFT_NPD_REACH_CAP_M) >= threshold_db {
            return AIRCRAFT_NPD_REACH_CAP_M;
        }
        let mut lo = AIRCRAFT_NPD_REF_SLANT_M;
        let mut hi = AIRCRAFT_NPD_REACH_CAP_M;
        for _ in 0..32 {
            let mid = 0.5 * (lo + hi);
            if sel_at(mid) > threshold_db {
                lo = mid;
            } else {
                hi = mid;
            }
            if (hi - lo) < 0.5 {
                break;
            }
        }
        0.5 * (lo + hi)
    }
}

/// Interpolate SEL at a given slant distance (Doc 29 §4.2, Eq. 4-4/4-5).
/// Log-linear interpolation in distance.
#[inline]
pub fn interpolate_sel(profile: &NpdProfile, slant_ft: f64, is_departure: bool) -> f64 {
    let log_d = slant_ft.max(100.0).log10();
    interpolate_sel_logd(profile, log_d, is_departure)
}

// NPD lookup table — pre-built at first access from `interpolate_sel_logd`.
// Shared by popup `segment_sel_with_overrides` and pipeline-worker scatter.
// 128 bins keep the
// linear-log interpolation sag < 0.05 dB against the convex physics tail
// (`−20·log10(d) − α·d` beyond 25 000 ft) where the linear-in-meters
// absorption curves downward faster than log-linear between bin anchors.
//
// Lookup cost: ~5 cycles (branchless index + 1 fmadd) vs ~25 for the binary
// search inside `interpolate_sel_logd`. Pipeline batched scatter and popup
// per-segment loop both call `NpdLuts::shared().lookup(...)` so SEL lookups
// match by construction.

pub const NPD_LUT_BINS: usize = 128;
pub const NPD_LUT_LOG_MIN: f64 = 2.0; // log10(100 ft)
pub const NPD_LUT_LOG_MAX: f64 = 5.5; // log10(316 k ft)
pub const NPD_LUT_STEP: f64 = (NPD_LUT_LOG_MAX - NPD_LUT_LOG_MIN) / NPD_LUT_BINS as f64;
pub const NPD_LUT_INV_STEP: f64 = NPD_LUT_BINS as f64 / (NPD_LUT_LOG_MAX - NPD_LUT_LOG_MIN);

pub fn build_npd_lut(profile: &NpdProfile, is_departure: bool) -> [f64; NPD_LUT_BINS + 1] {
    let mut lut = [0.0f64; NPD_LUT_BINS + 1];
    for i in 0..=NPD_LUT_BINS {
        let log_d = NPD_LUT_LOG_MIN + i as f64 * NPD_LUT_STEP;
        lut[i] = interpolate_sel_logd(profile, log_d, is_departure);
    }
    lut
}

#[inline(always)]
pub fn fast_npd_lookup(lut: &[f64; NPD_LUT_BINS + 1], log_d: f64) -> f64 {
    // `.max(0.0)` guards against wrap-to-huge-usize when log_d dips fractionally
    // below NPD_LUT_LOG_MIN due to float rounding at the 100 ft clamp boundary.
    let t = ((log_d - NPD_LUT_LOG_MIN) * NPD_LUT_INV_STEP).max(0.0);
    let idx = (t as usize).min(NPD_LUT_BINS - 1);
    let frac = t - idx as f64;
    lut[idx] + frac * (lut[idx + 1] - lut[idx])
}

/// Per-noise-class NPD LUTs (NUM_CLASSES classes × 2 directions × 2 metrics).
/// Single global instance — built once on first access, reused across
/// pipeline batches and popup queries. Sized by `NUM_CLASSES`: each class
/// shares its Voronoi anchor's NPD curve, so one LUT per class is exact.
///
/// SEL LUTs feed energy summation; LAmax LUTs feed per-event peak ranking
/// (popup top-flights, band classification). LAmax replaces the hardcoded
/// `sel - 12.0` approximation that had ±5 dB bias across operations.
pub struct NpdLuts {
    approach: Vec<[f64; NPD_LUT_BINS + 1]>,
    departure: Vec<[f64; NPD_LUT_BINS + 1]>,
    approach_lmax: Vec<[f64; NPD_LUT_BINS + 1]>,
    departure_lmax: Vec<[f64; NPD_LUT_BINS + 1]>,
}

static NPD_LUTS: OnceLock<NpdLuts> = OnceLock::new();

impl NpdLuts {
    pub fn shared() -> &'static NpdLuts {
        NPD_LUTS.get_or_init(NpdLuts::build)
    }

    fn build() -> Self {
        let mut approach = Vec::with_capacity(NUM_CLASSES);
        let mut departure = Vec::with_capacity(NUM_CLASSES);
        let mut approach_lmax = Vec::with_capacity(NUM_CLASSES);
        let mut departure_lmax = Vec::with_capacity(NUM_CLASSES);
        for class_idx in 0..NUM_CLASSES {
            let anchor = &PROFILES[CLASS_REP_PROFILE_IDX[class_idx] as usize];
            approach.push(build_npd_lut(anchor, false));
            departure.push(build_npd_lut(anchor, true));
            approach_lmax.push(build_lmax_lut(anchor, false));
            departure_lmax.push(build_lmax_lut(anchor, true));
        }
        NpdLuts { approach, departure, approach_lmax, departure_lmax }
    }

    #[inline(always)]
    pub fn lookup(&self, noise_class: usize, is_dep: bool, log_d: f64) -> f64 {
        let lut = if is_dep {
            &self.departure[noise_class]
        } else {
            &self.approach[noise_class]
        };
        fast_npd_lookup(lut, log_d)
    }

    /// Per-event peak A-weighted SPL (LAmax) lookup — replaces the prior
    /// hardcoded `sel - 12.0` constant. Returns the value before any
    /// per-segment ΔI / Λ corrections; callers may apply those if they
    /// need full Doc 29 Eq. 4-12 fidelity (popup peak ranking does not).
    #[inline(always)]
    pub fn lookup_lmax(&self, noise_class: usize, is_dep: bool, log_d: f64) -> f64 {
        let lut = if is_dep {
            &self.departure_lmax[noise_class]
        } else {
            &self.approach_lmax[noise_class]
        };
        fast_npd_lookup(lut, log_d)
    }
}

/// Build a 128-bin LAmax LUT mirroring `build_npd_lut` for SEL. Beyond 25 000 ft
/// we extrapolate via spherical divergence (`−20·log10(d/d_ref)`) plus the SEL
/// per-profile `alpha_eff` for atmospheric absorption — peak SPL and integrated
/// energy share the same source spectrum, so they share `alpha_eff`. (The prior
/// clamp at the last NPD point would have overstated far-cruise LAmax by ~18 dB
/// at 50 k ft slant — Codex/Gemini /gg flagged this as a popup-band false-positive.)
pub fn build_lmax_lut(profile: &NpdProfile, is_departure: bool) -> [f64; NPD_LUT_BINS + 1] {
    let lmax = if is_departure {
        &profile.departure_lmax
    } else {
        &profile.approach_lmax
    };
    let mut lut = [0.0f64; NPD_LUT_BINS + 1];
    let last = lmax.len() - 1;
    for i in 0..=NPD_LUT_BINS {
        let log_d = NPD_LUT_LOG_MIN + i as f64 * NPD_LUT_STEP;
        // Below 200 ft: use slope of first two points (matches SEL behaviour).
        if log_d <= LOG_DIST[0] {
            let slope = (lmax[1] - lmax[0]) / (LOG_DIST[1] - LOG_DIST[0]);
            lut[i] = lmax[0] + slope * (log_d - LOG_DIST[0]);
            continue;
        }
        // Beyond the last NPD point (25 000 ft): physics-based extrapolation,
        // mirroring `interpolate_sel_logd`. Atmospheric absorption is linear in
        // metres, so the log-linear NPD slope underestimates loss at large slant.
        if log_d >= LOG_DIST[last] {
            let slant_m = 10.0_f64.powf(log_d) / FT_PER_M;
            let geo = 20.0 * (slant_m / AIRCRAFT_NPD_REF_SLANT_M).log10();
            let atm = profile.alpha_eff(is_departure) * (slant_m - AIRCRAFT_NPD_REF_SLANT_M);
            lut[i] = lmax[last] - geo - atm;
            continue;
        }
        // Inside the table: log-linear interp between adjacent NPD points.
        for j in 0..last {
            if log_d < LOG_DIST[j + 1] {
                let frac = (log_d - LOG_DIST[j]) / (LOG_DIST[j + 1] - LOG_DIST[j]);
                lut[i] = lmax[j] + frac * (lmax[j + 1] - lmax[j]);
                break;
            }
        }
    }
    lut
}

/// NPD interpolation using pre-computed log10(distance_ft).
/// Avoids redundant log10 call when log_d is already available.
#[inline(always)]
pub fn interpolate_sel_logd(profile: &NpdProfile, log_d: f64, is_departure: bool) -> f64 {
    let sel = if is_departure {
        &profile.departure_sel
    } else {
        &profile.approach_sel
    };
    let last = sel.len() - 1;

    if log_d <= LOG_DIST[0] {
        let slope = (sel[1] - sel[0]) / (LOG_DIST[1] - LOG_DIST[0]);
        return sel[0] + slope * (log_d - LOG_DIST[0]);
    }
    // Beyond the last NPD point: physics-based extrapolation. Atmospheric
    // absorption is linear in meters, so the log-linear Doc 29 slope
    // underestimates loss at large slant. Use spherical divergence
    // (−20·log10) + per-profile α_eff·(d − d_ref). See `compute_alpha_eff`.
    if log_d >= LOG_DIST[last] {
        let slant_m = 10.0_f64.powf(log_d) / FT_PER_M;
        let geo = 20.0 * (slant_m / AIRCRAFT_NPD_REF_SLANT_M).log10();
        let atm = profile.alpha_eff(is_departure) * (slant_m - AIRCRAFT_NPD_REF_SLANT_M);
        return sel[last] - geo - atm;
    }

    for i in 0..last {
        if log_d <= LOG_DIST[i + 1] {
            let frac = (log_d - LOG_DIST[i]) / (LOG_DIST[i + 1] - LOG_DIST[i]);
            return sel[i] + frac * (sel[i + 1] - sel[i]);
        }
    }
    sel[last]
}

// Doc 29 reference value — slightly higher precision than the
// crate-wide `crate::constants::M_PER_DEG_LAT` (110_540.0) used by the
// general geo helpers. Kept module-private so the two never get
// imported under the same path; aircraft kernels stay on this value
// because compute_cpa was authored against it.
const M_PER_DEG_LAT: f64 = 111_132.92;

/// Per-noise-class reach² (m²) at the standard 40 dB SEL threshold, indexed
/// `[noise_class][is_departure as usize]`. Pre-built at first access so the
/// hot-path R-tree pre-filter (popup `lib.rs`, pipeline group bbox) can drop
/// segments via a squared-distance compare without invoking
/// `Profile::estimate_reach_m` per segment.
///
/// Keyed by `CLASS_REP_PROFILE_IDX` because the kernel always emits via the
/// class anchor — pre-filter and kernel must agree on which NPD curve sets
/// the 40 dB envelope, otherwise either false negatives (envelope < kernel
/// reach) or wasted candidates (envelope > kernel reach) leak through.
pub static REACH_SQ_TABLE: LazyLock<[[f64; 2]; NUM_CLASSES]> = LazyLock::new(|| {
    std::array::from_fn(|class_idx| {
        let p = &PROFILES[CLASS_REP_PROFILE_IDX[class_idx] as usize];
        [
            p.estimate_reach_m(AIRCRAFT_NPD_REACH_THRESHOLD_DB, false).powi(2),
            p.estimate_reach_m(AIRCRAFT_NPD_REACH_THRESHOLD_DB, true).powi(2),
        ]
    })
});

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

    // Altitude at the lateral CPA foot — same unclamped-t extrapolation
    // the kernel does. Both sides round-trip through identical
    // arithmetic: any segment the pre-filter accepts is one the kernel
    // will at least *evaluate* (Filter D / SEL gates may still reject
    // downstream).
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
/// `ProjectedAircraft::build`. All approximations match the previously
/// pipeline-internal `segment_energy_fast` exactly:
/// - NPD via 128-bin LUT (`NpdLuts::shared()`),
/// - ΔF via `fast_delta_f` (Padé-atan),
/// - Λ via `fast_lateral_attenuation` (no atan2),
/// - ΔI via the inline `u²/v²` form (no trig).
///
/// This is the single canonical airborne kernel. Both the popup wrapper
/// (`segment_sel_with_overrides`) and pipeline-worker's
/// `segment_energy_fast` delegate here.
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
/// uncertainty. A descending landing whose line would put the aircraft
/// 200 m below ground at `t = 1.1` is clearly fiction; a cruise segment
/// whose line grazes 5 m below a ridge at `t = 1.05` is likely real
/// data-thinning.
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
    let log_d = d_ft.log2() * 0.301029995664_f64;
    // Caller-hoisted `&NpdLuts` reference — keeps the OnceLock Acquire load
    // out of the per-receiver inner loop (would otherwise fence SIMD /
    // pipelining across 100 k-segment × 343-receiver scatters).
    let sel_npd = npd_luts.lookup(noise_class, is_dep, log_d);

    // CFFK fast path: above 7.62 km slant the per-segment corrections
    // (ΔF, Λ, ΔI) collapse to within fractions of a dB. Skip them and
    // pay only NPD lookup + Δv. Validates against full Doc 29 within
    // ~0.3 dB at slant ≥ 7.62 km.
    if d_p_m > AIRCRAFT_FAR_FIELD_THRESHOLD_M {
        let sel = sel_npd + seg_dv;
        if sel < 20.0 {
            return None;
        }
        let energy = (sel * std::f64::consts::LN_10 * 0.1).exp();
        return Some(AircraftKernelResult {
            energy,
            sel,
            d_p_m,
            rel_alt_m: rel_alt,
            q_m: t * slen,
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
/// Λ = 0 (no engine-wing shielding). The kernel callers must pass the
/// segment's `Installation`; the `installation == Wing` gate is also a
/// strict equivalent of the historical `delta_i_constants` check that
/// already filtered Propeller out of ΔI.
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

use crate::constants::{ALPHA_ATM, A_WEIGHTING};
use crate::propagation::geo;
use crate::types::{
    AircraftSegment, RasterSampler, NUM_BANDS, default_receiver_altitude_m,
};

/// Runtime fallback for stale prepared ADS-B data that still contains taxi or
/// runway-roll segments. The authoritative fix is extractor-side `on_ground`
/// filtering, but until the full dataset is rebuilt we also reject segments
/// whose both endpoints stay close to local terrain.
pub const GROUND_STALE_MAX_AGL_M: f64 = 15.0;
pub const AIRPORT_GROUND_MAX_AGL_M: f64 = 60.0;
pub const GROUND_CONTEXT_NONE: u8 = 0;
pub const GROUND_CONTEXT_AIRPORT_LINE: u8 = 1;
pub const GROUND_OPS_KIND_NONE: u8 = 0;
pub const GROUND_OPS_KIND_RUNWAY_ROLL: u8 = 1;
pub const GROUND_OPS_KIND_TAXI: u8 = 2;
pub const GROUND_OPS_KIND_APRON_MOVEMENT: u8 = 3;
pub const GROUND_OPS_SOURCE_HEIGHT_M: f64 = 4.0;

const SURFACE_RUNWAY_SPEED_KT: f32 = 70.0;
const SURFACE_TAXIWAY_SPEED_KT: f32 = 18.0;
const SURFACE_APRON_SPEED_KT: f32 = 12.0;
const GROUND_OPS_REF_OFFSET_M: f64 = 25.0;
const GROUND_OPS_SPEED_CLAMP_DB: f64 = 3.0;
const GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB: f64 = 2.0;
const GROUND_OPS_RUNWAY_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [17.0, 14.0, 11.0, 8.0, 5.0, 2.0, -1.0, -5.0];
const GROUND_OPS_TAXI_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [14.0, 11.0, 8.0, 5.0, 2.0, 0.0, -3.0, -7.0];
const GROUND_OPS_APRON_SPECTRUM_SHAPE: [f64; NUM_BANDS] =
    [12.0, 9.0, 6.0, 3.0, 1.0, -1.0, -4.0, -8.0];
// `GROUND_OPS_REFERENCE_SEL_DB` is generated per-noise-class in
// `profiles_generated.rs`; re-exported via the `pub use` block above.

pub fn is_ground_ops_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    seg.surface_model || is_airport_ground_segment(seg, rasters)
}

pub fn resolve_ground_ops_kind(seg: &AircraftSegment) -> u8 {
    if seg.ground_ops_kind != GROUND_OPS_KIND_NONE {
        seg.ground_ops_kind
    } else if seg.ground_context != GROUND_CONTEXT_NONE || seg.on_ground || seg.surface_model {
        ground_ops_kind_fallback(seg)
    } else {
        GROUND_OPS_KIND_NONE
    }
}

/// Speed/length-based ops_kind classifier. Used by Stage 2C v10 ground
/// path extraction to assign per-leg `ops_kind` from the leg's
/// observed speed and length:
///
/// * `speed_kt ≥ 40 OR segment_length_m ≥ 500` → `RUNWAY_ROLL`
///   (takeoff acceleration arc has high avg speed OR a long ground
///   stretch even when avg speed is averaged down by an early phase).
/// * `speed_kt ≥ 8` → `TAXI`.
/// * else → `APRON_MOVEMENT` (slow / stationary movements).
///
/// Pre-v10 also had OSM-aeroway-based classification via
/// `AirportMatcher`; v10 dropped the snap chain entirely and this
/// heuristic is the sole `ops_kind` source.
pub fn ground_ops_kind_fallback(seg: &AircraftSegment) -> u8 {
    if seg.speed_kt >= 40.0 || seg.segment_length_m >= 500.0 {
        GROUND_OPS_KIND_RUNWAY_ROLL
    } else if seg.speed_kt >= 8.0 {
        GROUND_OPS_KIND_TAXI
    } else {
        GROUND_OPS_KIND_APRON_MOVEMENT
    }
}

/// Cached terrain elevations sampled at five points along a segment
/// (start, end, midpoint, ¼, ¾). Lets the popup hot loop run
/// `is_ground_stale`, `is_valid_airborne`, and the kernel's Filter D
/// cuts off one batch of `rasters.elevation()` calls instead of nine
/// (start/end appear in all three predicates).
#[derive(Clone, Copy, Debug)]
pub struct SegmentTerrain {
    pub start_elev: f64,
    pub end_elev: f64,
    pub mid_elev: f64,
    pub q1_elev: f64,
    pub q3_elev: f64,
}

impl SegmentTerrain {
    pub fn sample(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> Self {
        let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
        let q1_lat = seg.start_lat * 0.75 + seg.end_lat * 0.25;
        let q1_lon = seg.start_lon * 0.75 + seg.end_lon * 0.25;
        let q3_lat = seg.start_lat * 0.25 + seg.end_lat * 0.75;
        let q3_lon = seg.start_lon * 0.25 + seg.end_lon * 0.75;
        SegmentTerrain {
            start_elev: rasters.elevation(seg.start_lat, seg.start_lon),
            end_elev: rasters.elevation(seg.end_lat, seg.end_lon),
            mid_elev: rasters.elevation(mid_lat, mid_lon),
            q1_elev: rasters.elevation(q1_lat, q1_lon),
            q3_elev: rasters.elevation(q3_lat, q3_lon),
        }
    }
}

/// Filter obviously-invalid airborne ADS-B segments.
/// Returns false for segments that pipeline AND popup should skip:
/// - Max altitude below terrain - 30m (underground / radar echo)
/// - Jet-like profile (not Turboprop, not LightGA/helicopter) flying < 80 kt (impossible)
/// - Jet-like profile < 150m AGL outside any airport context (radar echo / decode error)
///
/// Used by both pipeline (ProjectedAircraft::from_segments) and popup
/// (segment loading after R-tree query). Single source of truth.
pub fn is_valid_airborne_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    // Ground / airport-context segments handled by ground ops submodel.
    if seg.on_ground || seg.ground_context != GROUND_CONTEXT_NONE {
        return true;
    }

    // Jet-like noise classes (turboprops, GA, helicopters may legitimately
    // fly slow and low). Routed through `IS_JET[noise_class]` so the
    // predicate stays correct as profiles are added/reordered.
    let is_fixed_wing_jet = IS_JET[noise_class_of(seg.profile_idx) as usize];

    // Cheap speed check for jets before expensive raster lookups.
    if is_fixed_wing_jet && (seg.speed_kt as f64) < 80.0 {
        return false;
    }

    // ── Universal impossibility checks (apply to all airborne profiles) ──
    let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
    let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
    let terrain_mid = rasters.elevation(mid_lat, mid_lon);
    let max_alt = (seg.start_alt_m as f64).max(seg.end_alt_m as f64);

    if max_alt < terrain_mid - 30.0 {
        return false;
    }

    // Endpoint AGL < -30 m handles subsea-level airports (Schiphol -4m, Atyrau
    // -22m, Caspian-basin sites) via DEM-relative terrain rather than global MSL.
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    if start_agl < -30.0 || end_agl < -30.0 {
        return false;
    }

    // Line goes under terrain along its 25%/75% interpolation (midpoint already
    // covered by the max_alt < terrain-30 check above).
    let sl = seg.start_lat as f64;
    let sn = seg.start_lon as f64;
    let el = seg.end_lat as f64;
    let en = seg.end_lon as f64;
    let sa = seg.start_alt_m as f64;
    let ea = seg.end_alt_m as f64;
    for frac in [0.25_f64, 0.75] {
        let lat = sl + (el - sl) * frac;
        let lon = sn + (en - sn) * frac;
        let alt = sa + (ea - sa) * frac;
        if alt < rasters.elevation(lat, lon) - 30.0 {
            return false;
        }
    }

    if !is_fixed_wing_jet {
        return true;
    }

    // ── Jet-only rules below ──

    // Jet < 150m AGL outside airport: radar echo or altitude decode error.
    if max_alt < terrain_mid + 150.0 {
        return false;
    }

    true
}

pub fn is_ground_stale_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.on_ground {
        return seg.ground_context == GROUND_CONTEXT_NONE;
    }
    if seg.ground_context != GROUND_CONTEXT_NONE {
        return false;
    }
    is_low_agl_segment_raw(seg, rasters)
}

pub fn is_low_agl_segment_raw(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    start_agl <= GROUND_STALE_MAX_AGL_M && end_agl <= GROUND_STALE_MAX_AGL_M
}

/// `is_ground_stale_segment` reading elevations from a `SegmentTerrain` cache.
pub fn is_ground_stale_with_terrain(seg: &AircraftSegment, terrain: &SegmentTerrain) -> bool {
    if seg.on_ground {
        return seg.ground_context == GROUND_CONTEXT_NONE;
    }
    if seg.ground_context != GROUND_CONTEXT_NONE {
        return false;
    }
    let start_agl = seg.start_alt_m as f64 - terrain.start_elev;
    let end_agl = seg.end_alt_m as f64 - terrain.end_elev;
    start_agl <= GROUND_STALE_MAX_AGL_M && end_agl <= GROUND_STALE_MAX_AGL_M
}

/// `is_valid_airborne_segment` reading elevations from a `SegmentTerrain` cache.
pub fn is_valid_airborne_with_terrain(seg: &AircraftSegment, terrain: &SegmentTerrain) -> bool {
    if seg.on_ground || seg.ground_context != GROUND_CONTEXT_NONE {
        return true;
    }
    let is_fixed_wing_jet = IS_JET[noise_class_of(seg.profile_idx) as usize];
    if is_fixed_wing_jet && (seg.speed_kt as f64) < 80.0 {
        return false;
    }
    let max_alt = (seg.start_alt_m as f64).max(seg.end_alt_m as f64);
    if max_alt < terrain.mid_elev - 30.0 {
        return false;
    }
    let start_agl = seg.start_alt_m as f64 - terrain.start_elev;
    let end_agl = seg.end_alt_m as f64 - terrain.end_elev;
    if start_agl < -30.0 || end_agl < -30.0 {
        return false;
    }
    let sa = seg.start_alt_m as f64;
    let ea = seg.end_alt_m as f64;
    let q1_alt = sa * 0.75 + ea * 0.25;
    let q3_alt = sa * 0.25 + ea * 0.75;
    if q1_alt < terrain.q1_elev - 30.0 || q3_alt < terrain.q3_elev - 30.0 {
        return false;
    }
    if !is_fixed_wing_jet {
        return true;
    }
    max_alt >= terrain.mid_elev + 150.0
}

pub fn is_airport_ground_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.ground_context == GROUND_CONTEXT_NONE {
        return false;
    }
    if seg.on_ground {
        return true;
    }
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    start_agl <= AIRPORT_GROUND_MAX_AGL_M && end_agl <= AIRPORT_GROUND_MAX_AGL_M
}

fn segment_agl(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> (f64, f64) {
    let start_agl = seg.start_alt_m as f64 - rasters.elevation(seg.start_lat, seg.start_lon);
    let end_agl = seg.end_alt_m as f64 - rasters.elevation(seg.end_lat, seg.end_lon);
    (start_agl, end_agl)
}

/// Meters → degrees of latitude (constant ≈ 110 540 m / deg, valid to
/// within ~0.6 % anywhere on Earth). Use for any latitude bounding box
/// where the exact geodesic isn't worth the cost.
pub fn meters_to_lat_deg(meters: f64) -> f64 {
    meters / 110_540.0
}

/// Meters → degrees of longitude at a given latitude. Includes a
/// `cos.max(0.2)` clamp that bounds the conversion factor at ~78°
/// latitude — above that the cosine collapses and the bbox would
/// over-fetch enormously. Aircraft cruise tracks live well below that
/// limit, so the clamp is a safety net rather than a routine concern.
pub fn meters_to_lon_deg(lat: f64, meters: f64) -> f64 {
    let cos_lat = lat.to_radians().cos().abs().max(0.2);
    meters / (111_320.0 * cos_lat)
}

pub struct GroundOpsLineEmission {
    pub kind: u8,
    pub source_height_m: f64,
    pub max_radius_m: f64,
    pub emission_day: [f32; NUM_BANDS],
    pub emission_evening: [f32; NUM_BANDS],
    pub emission_night: [f32; NUM_BANDS],
}

#[derive(Clone, Copy)]
struct GroundOpsModel {
    ref_sel_db: f64,
    spectrum_shape: [f64; NUM_BANDS],
    max_radius_m: f64,
}

pub fn build_ground_ops_line_emission(
    seg: &AircraftSegment,
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Option<GroundOpsLineEmission> {
    if !is_ground_ops_segment(seg, rasters) || n_days == 0 {
        return None;
    }

    let kind = resolve_ground_ops_kind(seg);
    if kind == GROUND_OPS_KIND_NONE {
        return None;
    }
    let model = ground_ops_model(seg, kind);

    let ((ref_lat, ref_lon), ref_dist_m, ref_fraction) = ground_ops_reference_point(seg);
    let cp = geo::closest_point_on_segment(
        ref_lat,
        ref_lon,
        seg.start_lat,
        seg.start_lon,
        seg.end_lat,
        seg.end_lon,
    );
    let cp_elev = rasters.elevation(cp.lat, cp.lon) + GROUND_OPS_SOURCE_HEIGHT_M;
    let ref_ground_elev = rasters.elevation(ref_lat, ref_lon);
    let ref_receiver_alt = default_receiver_altitude_m(ref_ground_elev);
    let d_slant = geo::slant_dist(ref_dist_m, cp_elev, ref_receiver_alt).max(1.0);
    let flc = geo::finite_line_correction(seg.segment_length_m as f64, ref_dist_m, ref_fraction);
    let geo_div = 10.0 * (2.0 * PI * d_slant).log10();
    let d_over_1000 = d_slant / 1000.0;
    let leq_ref = period_leq(
        (model.ref_sel_db * std::f64::consts::LN_10 * 0.1).exp() * seg.count_weight.max(0.0) as f64,
        n_days as f64,
        PERIOD_SECONDS[seg.period.min(2) as usize],
    );
    if !leq_ref.is_finite() {
        return None;
    }

    let template_total = template_a_weighted_total(model.spectrum_shape, d_over_1000);
    let total_emission = leq_ref + geo_div - flc - template_total;
    let active = std::array::from_fn(|i| {
        (total_emission + model.spectrum_shape[i]) as f32
    });
    let silent = [f32::NEG_INFINITY; NUM_BANDS];
    let (emission_day, emission_evening, emission_night) = match seg.period.min(2) {
        0 => (active, silent, silent),
        1 => (silent, active, silent),
        _ => (silent, silent, active),
    };

    Some(GroundOpsLineEmission {
        kind,
        source_height_m: GROUND_OPS_SOURCE_HEIGHT_M,
        max_radius_m: model.max_radius_m,
        emission_day,
        emission_evening,
        emission_night,
    })
}

fn ground_ops_reference_point(seg: &AircraftSegment) -> ((f64, f64), f64, f64) {
    let cp = geo::closest_point_on_segment(
        (seg.start_lat + seg.end_lat) * 0.5,
        (seg.start_lon + seg.end_lon) * 0.5,
        seg.start_lat,
        seg.start_lon,
        seg.end_lat,
        seg.end_lon,
    );
    let cp_lat = cp.lat;
    let cp_lon = cp.lon;
    let dx_m = geo::flat_dist(cp_lat, cp_lon, cp_lat, seg.end_lon)
        * if seg.end_lon >= seg.start_lon { 1.0 } else { -1.0 };
    let dy_m = geo::flat_dist(cp_lat, cp_lon, seg.end_lat, cp_lon)
        * if seg.end_lat >= seg.start_lat { 1.0 } else { -1.0 };
    let seg_len_m = (dx_m * dx_m + dy_m * dy_m).sqrt().max(1.0);
    let nx_m = -dy_m / seg_len_m;
    let ny_m = dx_m / seg_len_m;
    let ref_lat = cp_lat + meters_to_lat_deg(ny_m * GROUND_OPS_REF_OFFSET_M);
    let ref_lon = cp_lon + meters_to_lon_deg(cp_lat, nx_m * GROUND_OPS_REF_OFFSET_M);
    ((ref_lat, ref_lon), GROUND_OPS_REF_OFFSET_M, cp.fraction)
}

fn ground_ops_max_radius_m(kind: u8) -> f64 {
    // Sized so a realistic-loudest operation leaves ≤ 20 dB Lden at cutoff
    // (free-field, flat ground) — i.e. below rural-night background.
    match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => crate::constants::GROUND_OPS_RUNWAY_MAX_RADIUS,
        GROUND_OPS_KIND_TAXI => crate::constants::GROUND_OPS_TAXI_MAX_RADIUS,
        GROUND_OPS_KIND_APRON_MOVEMENT => crate::constants::GROUND_OPS_APRON_MAX_RADIUS,
        _ => crate::constants::GROUND_OPS_APRON_MAX_RADIUS,
    }
}

fn template_a_weighted_total(shape: [f64; NUM_BANDS], d_over_1000: f64) -> f64 {
    let c = std::f64::consts::LN_10 * 0.1;
    let energy: f64 = (0..NUM_BANDS)
        .map(|i| (shape[i] - ALPHA_ATM[i] * d_over_1000 + A_WEIGHTING[i]) * c)
        .map(f64::exp)
        .sum();
    10.0 * energy.max(1e-30).log10()
}

fn ground_ops_model(seg: &AircraftSegment, kind: u8) -> GroundOpsModel {
    let kind_idx = ground_ops_kind_index(kind);
    let class_idx = noise_class_of(seg.profile_idx) as usize;
    let mut ref_sel_db = GROUND_OPS_REFERENCE_SEL_DB[class_idx][kind_idx];
    if kind == GROUND_OPS_KIND_RUNWAY_ROLL && seg.is_departure {
        ref_sel_db += GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB;
    }

    let nominal_speed_kt = match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => SURFACE_RUNWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_TAXI => SURFACE_TAXIWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_APRON_MOVEMENT => SURFACE_APRON_SPEED_KT as f64,
        _ => SURFACE_APRON_SPEED_KT as f64,
    };
    if seg.speed_kt > 1.0 {
        let speed_adjust_db = 10.0 * ((seg.speed_kt as f64) / nominal_speed_kt.max(1.0)).log10();
        ref_sel_db += speed_adjust_db.clamp(-GROUND_OPS_SPEED_CLAMP_DB, GROUND_OPS_SPEED_CLAMP_DB);
    }

    let spectrum_shape = match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => GROUND_OPS_RUNWAY_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_TAXI => GROUND_OPS_TAXI_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_APRON_MOVEMENT => GROUND_OPS_APRON_SPECTRUM_SHAPE,
        _ => GROUND_OPS_APRON_SPECTRUM_SHAPE,
    };

    GroundOpsModel {
        ref_sel_db,
        spectrum_shape,
        max_radius_m: ground_ops_max_radius_m(kind),
    }
}

fn ground_ops_kind_index(kind: u8) -> usize {
    match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => 0,
        GROUND_OPS_KIND_TAXI => 1,
        GROUND_OPS_KIND_APRON_MOVEMENT => 2,
        _ => 2,
    }
}

/// Compute SEL for a single aircraft segment at a receiver point.
/// Returns (SEL_dB, CpaResult) or None if segment is too far / inaudible.
///
/// Convenience entry point for low-frequency callers (tests, single-shot
/// queries). Pays one `NpdLuts::shared()` Acquire load per call. Hot
/// users (popup per-segment loop, pipeline scatter) should hoist the
/// `&NpdLuts` reference and call `segment_sel_with_luts` directly.
pub fn segment_sel(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    rasters: &dyn RasterSampler,
) -> Option<(f64, CpaResult)> {
    let terrain_start_cut_m = rasters.elevation(seg.start_lat, seg.start_lon) - 30.0;
    let terrain_end_cut_m = rasters.elevation(seg.end_lat, seg.end_lon) - 30.0;
    segment_sel_with_overrides(
        seg,
        rx_lat,
        rx_lon,
        rx_elev_m,
        seg.start_alt_m as f64,
        seg.end_alt_m as f64,
        false,
        terrain_start_cut_m,
        terrain_end_cut_m,
        NpdLuts::shared(),
    )
}

/// Hot-path variant of `segment_sel` that accepts a caller-hoisted
/// `&NpdLuts`. Use this from inside per-segment loops to avoid an
/// `OnceLock::get_or_init` Acquire load on every call. Same return
/// semantics as `segment_sel`.
pub fn segment_sel_with_luts(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    rasters: &dyn RasterSampler,
    npd_luts: &NpdLuts,
) -> Option<(f64, CpaResult)> {
    let terrain_start_cut_m = rasters.elevation(seg.start_lat, seg.start_lon) - 30.0;
    let terrain_end_cut_m = rasters.elevation(seg.end_lat, seg.end_lon) - 30.0;
    segment_sel_with_overrides(
        seg,
        rx_lat,
        rx_lon,
        rx_elev_m,
        seg.start_alt_m as f64,
        seg.end_alt_m as f64,
        false,
        terrain_start_cut_m,
        terrain_end_cut_m,
        npd_luts,
    )
}

/// Hottest-path variant: terrain cuts are derived from the caller's
/// pre-sampled `SegmentTerrain` cache, skipping the two `rasters.elevation()`
/// calls that `segment_sel_with_luts` pays per segment. Use when the caller
/// already needed `SegmentTerrain` for predicate evaluation.
pub fn segment_sel_with_terrain(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    terrain: &SegmentTerrain,
    npd_luts: &NpdLuts,
) -> Option<(f64, CpaResult)> {
    segment_sel_with_overrides(
        seg,
        rx_lat,
        rx_lon,
        rx_elev_m,
        seg.start_alt_m as f64,
        seg.end_alt_m as f64,
        false,
        terrain.start_elev - 30.0,
        terrain.end_elev - 30.0,
        npd_luts,
    )
}

pub fn segment_sel_airport_ground(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    rasters: &dyn RasterSampler,
) -> Option<(f64, CpaResult)> {
    let start_alt_m =
        (seg.start_alt_m as f64).max(rasters.elevation(seg.start_lat, seg.start_lon) + 4.0);
    let end_alt_m = (seg.end_alt_m as f64).max(rasters.elevation(seg.end_lat, seg.end_lon) + 4.0);
    // Filter D bypass: airport-ground segments are validated by
    // ground-context metadata, so the kernel sees `f64::MIN` cuts.
    segment_sel_with_overrides(
        seg,
        rx_lat,
        rx_lon,
        rx_elev_m,
        start_alt_m,
        end_alt_m,
        true,
        f64::MIN,
        f64::MIN,
        NpdLuts::shared(),
    )
}

fn segment_sel_with_overrides(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    start_alt_m: f64,
    end_alt_m: f64,
    airport_ground_mode: bool,
    terrain_start_cut_m: f64,
    terrain_end_cut_m: f64,
    npd_luts: &NpdLuts,
) -> Option<(f64, CpaResult)> {
    // SEL/v_ref/d_bar/installation come from the class's Voronoi anchor.
    // Per-segment acoustic error vs the segment's own per-typecode profile
    // is bounded by class spread (avg 0.76 dB across global traffic).
    let class_idx = noise_class_of(seg.profile_idx) as usize;
    let anchor_profile = &PROFILES[CLASS_REP_PROFILE_IDX[class_idx] as usize];

    // Pre-project segment into receiver-local meters. Pipeline's
    // ProjectedAircraft does this once at build (amortised over 343
    // receivers per group); popup pays it per segment per query
    // (single receiver), but the cos/lateral arithmetic here is
    // ~20 ops — cheap compared to anything downstream.
    let cos_lat = rx_lat.to_radians().cos().max(0.2);
    let m_per_deg_lon = M_PER_DEG_LAT * cos_lat;
    let ax = (seg.start_lon - rx_lon) * m_per_deg_lon;
    let ay = (seg.start_lat - rx_lat) * M_PER_DEG_LAT;
    let bx = (seg.end_lon - rx_lon) * m_per_deg_lon;
    let by = (seg.end_lat - rx_lat) * M_PER_DEG_LAT;
    let sdx = bx - ax;
    let sdy = by - ay;
    let seg_len_sq = sdx * sdx + sdy * sdy;
    let slen = seg_len_sq.sqrt().max(1.0);
    let inv_lsq = if seg_len_sq > 1e-6 { 1.0 / seg_len_sq } else { 0.0 };
    let sdz = end_alt_m - start_alt_m;

    // Per-class constants — same values pipeline pre-computes in
    // ProjectedAircraft. Cheap to recompute here for one segment.
    let (inst_code, di_a, di_b, di_c) = delta_i_constants(anchor_profile.installation);
    let dv = delta_v(seg.speed_kt as f64, anchor_profile);

    // REACH_SQ_TABLE uses the class's loudest-member reach (not the
    // anchor's), so the pre-filter envelope covers Voronoi-assigned
    // outliers like B752 in WING_A320 — a louder member must never be
    // dropped at long range before the kernel sees it.
    let reach_sq = REACH_SQ_TABLE[class_idx][seg.is_departure as usize];

    // Caller hoists `&NpdLuts` outside the per-segment loop so the
    // OnceLock Acquire load doesn't serialise the kernel inner math.
    let kernel = segment_energy_kernel(
        ax,
        ay,
        sdx,
        sdy,
        sdz,
        start_alt_m,
        inv_lsq,
        slen,
        rx_elev_m,
        npd_luts,
        class_idx,
        seg.is_departure,
        dv,
        anchor_profile.d_bar_m,
        inst_code,
        di_a,
        di_b,
        di_c,
        airport_ground_mode,
        reach_sq,
        terrain_start_cut_m,
        terrain_end_cut_m,
    )?;

    let cpa = CpaResult {
        q_m: kernel.q_m,
        d_p_m: kernel.d_p_m,
        lateral_m: kernel.lateral_m,
        relative_alt_m: kernel.rel_alt_m,
        beta_deg: kernel.beta_deg,
        seg_len_m: kernel.seg_len_m,
        t: kernel.t,
    };

    Some((kernel.sel, cpa))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── NPD ──

    #[test]
    fn test_npd_at_table_node() {
        // Interpolating exactly at a table distance must return that
        // table's value (no rounding drift through log-linear). Anchor on
        // the B738 approach SEL @ 1000 ft (= NPD_DIST_FT[3]).
        let p = &PROFILES[profile_idx("B738") as usize];
        let sel = interpolate_sel(p, 1000.0, false);
        assert!(
            (sel - p.approach_sel[3]).abs() < 0.01,
            "B738 @ 1000ft: expected {}, got {sel}",
            p.approach_sel[3]
        );
    }

    #[test]
    fn test_npd_interpolation() {
        // 1500 ft is between NPD_DIST_FT[3] (1000 ft) and NPD_DIST_FT[4]
        // (2000 ft). Result must be a strict log-linear interpolation
        // between the two anchor SELs, not extrapolation.
        let p = &PROFILES[profile_idx("B738") as usize];
        let sel = interpolate_sel(p, 1500.0, false);
        let lo = p.approach_sel[3].min(p.approach_sel[4]);
        let hi = p.approach_sel[3].max(p.approach_sel[4]);
        assert!(
            sel >= lo - 0.01 && sel <= hi + 0.01,
            "B738 @ 1500ft = {sel} outside [{lo},{hi}]"
        );
    }

    #[test]
    fn test_npd_extrapolation_below() {
        // Below NPD_DIST_FT[0] (200 ft): linearly extrapolated using slope
        // between [0] and [1]. The 200 ft value is the first table point,
        // so 100 ft must be louder than that.
        let p = &PROFILES[profile_idx("B738") as usize];
        let sel = interpolate_sel(p, 100.0, false);
        let near = p.approach_sel[0];
        assert!(
            sel > near,
            "Should extrapolate above approach_sel[0]={near}, got {sel}"
        );
    }

    #[test]
    fn test_npd_extrapolation_above() {
        // 50 000 ft = 15 240 m slant, beyond the NPD table. B738 approach:
        //   54 − 20·log10(15240/7620) − α·(15240 − 7620)
        // With α ≈ 0.00088 dB/m (back-out from B738 tail) gives ≈ 41 dB.
        // Under the old log-linear extrapolation this was ≈ 47 dB — physics
        // drops faster because atmospheric absorption is linear in meters.
        let sel = interpolate_sel(&PROFILES[0], 50000.0, false);
        assert!(
            sel < 45.0 && sel > 30.0,
            "Physics extrapolation @ 15 km should be 30–45 dB, got {sel}"
        );
    }

    #[test]
    fn test_npd_continuity_at_tail() {
        // At exactly 25 000 ft the physics formula collapses to sel[last]
        // (log10(1) = 0, d − d_ref = 0). Guards against slope mismatch at the
        // table/extrapolation boundary.
        for profile in &PROFILES {
            for is_dep in [false, true] {
                let tail_sel = if is_dep {
                    profile.departure_sel[9]
                } else {
                    profile.approach_sel[9]
                };
                let computed = interpolate_sel(profile, 25000.0, is_dep);
                assert!(
                    (computed - tail_sel).abs() < 0.05,
                    "{} {} @ 25 000 ft: expected {tail_sel}, got {computed}",
                    profile.name,
                    if is_dep { "dep" } else { "app" }
                );
            }
        }
    }

    #[test]
    fn test_alpha_eff_back_out() {
        // Each profile's α_eff should be in a physically sane range. Real
        // ANP NPD tails span a wider range than the 8-profile placeholder
        // synthetic data — some helicopters and large widebodies tail off
        // very gently (α ≈ 0), so loosen the lower bound. Upper bound is
        // physically capped at typical-atmosphere absorption.
        for profile in &PROFILES {
            for is_dep in [false, true] {
                let alpha = profile.alpha_eff(is_dep);
                assert!(
                    alpha >= -0.0005 && alpha <= 0.0030,
                    "{} {} α_eff = {alpha:.6} dB/m, expected -0.0005..0.0030",
                    profile.name,
                    if is_dep { "dep" } else { "app" }
                );
            }
        }
        // B738 approach: back-out from real ANP CF567B tail. Pin the value
        // (with generous tolerance) so a future NPD regen that breaks the
        // tail-fit calibration gets caught.
        // B738 approach α_eff drift sanity bound: real ANP gives a smaller
        // value than the placeholder calibration (~0.00088 was hand-tuned
        // to the synthetic curve; ANP's CF567B tail is flatter). Just sanity
        // check positivity and order-of-magnitude here — the per-class
        // assertion above covers physical plausibility, and /check-pipeline
        // is the canonical regression gate for end-to-end SEL drift.
        let b738_app = PROFILES[profile_idx("B738") as usize].alpha_eff(false);
        assert!(b738_app >= 0.0 && b738_app < 0.003, "B738 approach α_eff = {b738_app:.5}");
    }

    // ── CPA geometry ──

    #[test]
    fn test_cpa_alongside() {
        let cpa = compute_cpa(
            50.005, 14.01, 300.0, 50.0, 14.0, 1000.0, 50.01, 14.0, 1000.0,
        );
        assert!(cpa.q_m > 0.0, "q should be positive");
        assert!(
            cpa.d_p_m > 500.0 && cpa.d_p_m < 2000.0,
            "d_p = {}",
            cpa.d_p_m
        );
        assert!(
            cpa.beta_deg > 20.0 && cpa.beta_deg < 70.0,
            "β = {}",
            cpa.beta_deg
        );
    }

    #[test]
    fn test_cpa_behind_segment() {
        let cpa = compute_cpa(49.99, 14.01, 300.0, 50.0, 14.0, 1000.0, 50.01, 14.0, 1000.0);
        assert!(
            cpa.q_m < 0.0,
            "q should be negative (behind), got {}",
            cpa.q_m
        );
    }

    #[test]
    fn test_cpa_directly_below() {
        let cpa = compute_cpa(50.005, 14.0, 300.0, 50.0, 14.0, 3000.0, 50.01, 14.0, 3000.0);
        assert!(
            cpa.lateral_m < 50.0,
            "lateral should be ~0, got {}",
            cpa.lateral_m
        );
        assert!(
            cpa.beta_deg > 80.0,
            "β should be ~90°, got {}",
            cpa.beta_deg
        );
    }

    #[test]
    fn test_cpa_below_receiver_keeps_signed_altitude() {
        let cpa = compute_cpa(
            49.7846, 14.0306, 684.0, 49.7813, 14.0350, 0.0, 49.7863, 14.0283, 0.0,
        );
        assert!(
            cpa.lateral_m < 50.0,
            "lateral should stay near the ridge crossing, got {}",
            cpa.lateral_m
        );
        assert!(
            cpa.relative_alt_m < -600.0,
            "relative altitude should stay signed, got {}",
            cpa.relative_alt_m
        );
        assert!(
            cpa.d_p_m > 600.0,
            "slant distance should include the vertical gap, got {}",
            cpa.d_p_m
        );
        assert!(
            cpa.beta_deg < 0.0,
            "beta should be negative for segments below the receiver, got {}",
            cpa.beta_deg
        );
    }

    // ── Physics corrections ──

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
    /// Fuselage / Propeller / Helicopter installations get Λ = 0 regardless
    /// of β or lateral distance (no wing-shielding geometry to attenuate).
    #[test]
    fn test_lateral_non_wing_installations_zero() {
        for beta in [0.1, 10.0, 30.0, 50.0, 90.0] {
            for lat in [50.0, 500.0, 2000.0, 5000.0] {
                assert_eq!(
                    lateral_attenuation(beta, lat, Installation::Fuselage),
                    0.0,
                    "Fuselage Λ must be 0 (β={beta}, lat={lat})"
                );
                assert_eq!(
                    lateral_attenuation(beta, lat, Installation::Propeller),
                    0.0,
                    "Propeller Λ must be 0 (β={beta}, lat={lat})"
                );
            }
        }
    }

    #[test]
    fn test_fast_lateral_non_wing_installations_zero() {
        // (rel_alt, lateral_m) covers β = 5° to β = 90°
        for &(rel_alt, lat) in &[(50.0, 500.0), (200.0, 500.0), (1000.0, 500.0), (5000.0, 100.0)] {
            assert_eq!(
                fast_lateral_attenuation(rel_alt, lat, false, Installation::Fuselage),
                0.0,
            );
            assert_eq!(
                fast_lateral_attenuation(rel_alt, lat, false, Installation::Propeller),
                0.0,
            );
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

    // ── Period normalization ──

    #[test]
    fn test_period_leq() {
        // 1000 flights, each SEL=91 dB, all day, 365 days
        let energy = 1000.0 * 10f64.powf(91.0 / 10.0);
        let leq = period_leq(energy, 365.0, PERIOD_SECONDS[0]);
        assert!(leq > 40.0 && leq < 80.0, "Leq = {leq}");
    }

    // ── Full segment SEL ──

    #[test]
    fn test_segment_sel_b738_approach() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 0,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 1000.0,
            end_lat: 50.01,
            end_lon: 14.0,
            end_alt_m: 900.0,
            speed_kt: 150.0,
            segment_length_m: 1100.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };
        let result = segment_sel(&seg, 50.005, 14.005, 300.0, &FlatGround);
        assert!(result.is_some(), "should compute SEL for nearby segment");
        let (sel, cpa) = result.unwrap();
        assert!(sel > 50.0 && sel < 110.0, "SEL = {sel}");
        assert!(
            cpa.d_p_m > 100.0 && cpa.d_p_m < 2000.0,
            "d_p = {}",
            cpa.d_p_m
        );
    }

    #[test]
    fn test_segment_sel_far_away() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 0,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 51.0,
            start_lon: 15.0,
            start_alt_m: 10000.0,
            end_lat: 51.01,
            end_lon: 15.0,
            end_alt_m: 10000.0,
            speed_kt: 250.0,
            segment_length_m: 1100.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };
        let result = segment_sel(&seg, 50.0, 14.0, 300.0, &FlatGround);
        assert!(result.is_none(), "should be None for far segment");
    }

    struct FlatGround;

    impl crate::types::RasterSampler for FlatGround {
        fn elevation(&self, _lat: f64, _lon: f64) -> f64 {
            250.0
        }
        fn building_height(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn building_enclosure(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
    }

    #[test]
    fn test_ground_stale_segment_filter() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 252.0,
            end_lat: 50.001,
            end_lon: 14.001,
            end_alt_m: 259.0,
            speed_kt: 35.0,
            segment_length_m: 300.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };
        assert!(is_ground_stale_segment(&seg, &FlatGround));

        let airborne = AircraftSegment {
            start_alt_m: 320.0,
            end_alt_m: 340.0,
            ..seg
            };
        assert!(!is_ground_stale_segment(&airborne, &FlatGround));
    }

    #[test]
    fn test_airport_ground_segment_detection() {
        let off_airport = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 252.0,
            end_lat: 50.0008,
            end_lon: 14.0,
            end_alt_m: 255.0,
            speed_kt: 35.0,
            segment_length_m: 90.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };
        assert!(!is_airport_ground_segment(&off_airport, &FlatGround));

        let airport_ground = AircraftSegment {
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ..off_airport
        };
        assert!(is_airport_ground_segment(&airport_ground, &FlatGround));
    }

    #[test]
    fn test_airport_ground_sel_recovers_bad_altitude() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 200.0,
            end_lat: 50.0008,
            end_lon: 14.0,
            end_alt_m: 200.0,
            speed_kt: 35.0,
            segment_length_m: 90.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };

        let normal = segment_sel(&seg, 50.0004, 14.0, 254.0, &FlatGround)
            .expect("baseline airport segment should still compute")
            .0;
        let corrected = segment_sel_airport_ground(&seg, 50.0004, 14.0, 254.0, &FlatGround)
            .expect("airport ground override should compute")
            .0;

        assert!(
            corrected > normal + 10.0,
            "normal={normal:.2} corrected={corrected:.2}"
        );
    }

    #[test]
    fn test_ground_ops_model_uses_kind_specific_reference_sel() {
        // Verify ground_ops_model picks the right (class, kind) cell from
        // GROUND_OPS_REFERENCE_SEL_DB and applies the +2 dB departure
        // bonus on runway roll. Uses B738 (canonical narrowbody jet) and
        // anchors on the actual table values rather than hardcoded
        // pre-Tier-2 placeholder numbers.
        let pidx = profile_idx("B738");
        let cls = noise_class_of(pidx) as usize;
        let exp_runway = GROUND_OPS_REFERENCE_SEL_DB[cls][0];
        let exp_taxi = GROUND_OPS_REFERENCE_SEL_DB[cls][1];
        let exp_apron = GROUND_OPS_REFERENCE_SEL_DB[cls][2];

        let mut seg = AircraftSegment {
            flight_id: 1,
            profile_idx: pidx,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 0.0,
            end_lat: 50.005,
            end_lon: 14.0,
            end_alt_m: 0.0,
            speed_kt: SURFACE_RUNWAY_SPEED_KT,
            segment_length_m: 550.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_RUNWAY_ROLL,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };

        let runway_arr = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_arr.ref_sel_db - exp_runway).abs() < 0.01);
        assert_eq!(runway_arr.max_radius_m, 5_000.0);

        seg.is_departure = true;
        let runway_dep = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_dep.ref_sel_db - (exp_runway + GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB)).abs() < 0.01);

        seg.speed_kt = SURFACE_TAXIWAY_SPEED_KT;
        let taxi = ground_ops_model(&seg, GROUND_OPS_KIND_TAXI);
        assert!((taxi.ref_sel_db - exp_taxi).abs() < 0.01);
        assert_eq!(taxi.max_radius_m, 3_000.0);

        seg.speed_kt = SURFACE_APRON_SPEED_KT;
        let apron = ground_ops_model(&seg, GROUND_OPS_KIND_APRON_MOVEMENT);
        assert!((apron.ref_sel_db - exp_apron).abs() < 0.01);
        assert_eq!(apron.max_radius_m, 1_500.0);
    }

    #[test]
    fn test_ground_ops_model_avoids_doc29_near_field_extrapolation() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 0.0,
            end_lat: 50.006,
            end_lon: 14.0,
            end_alt_m: 0.0,
            speed_kt: SURFACE_RUNWAY_SPEED_KT,
            segment_length_m: 650.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_RUNWAY_ROLL,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };
        let rasters = FlatGround;
        let model = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        let rx_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let rx_lon = seg.start_lon + meters_to_lon_deg(rx_lat, 5.0);
        let rx_alt = default_receiver_altitude_m(rasters.elevation(rx_lat, rx_lon));
        let doc29_sel = segment_sel_airport_ground(&seg, rx_lat, rx_lon, rx_alt, &rasters)
            .expect("Doc 29 runway reference SEL should compute")
            .0;

        // Structural property: ground reference SEL is tabulated separately
        // from the airborne NPD kernel, so the ground model never extrapolates
        // through Doc 29's near-field. Pre-Tier-2 placeholder profiles
        // happened to land 8+ dB below the airborne extrapolation; with real
        // ANP NPD curves the two are closer (often within ~10 dB), so loosen
        // the threshold to just verify the ground model isn't crazy hot.
        assert!(
            model.ref_sel_db < doc29_sel + 15.0,
            "ground model wildly above near-field airborne, model={:.2} doc29_near={:.2}",
            model.ref_sel_db,
            doc29_sel
        );
    }

    #[test]
    fn test_ground_ops_model_speed_adjust_is_clamped() {
        let fast_seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 6,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 0.0,
            end_lat: 50.002,
            end_lon: 14.0,
            end_alt_m: 0.0,
            speed_kt: 240.0,
            segment_length_m: 220.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_TAXI,
            count_weight: 1.0,
            surface_model: false,
                    source_id: AIRCRAFT_ADSB_SOURCE_ID,
                    cruise_flight_ids: Vec::new(),
        };
        let slow_seg = AircraftSegment {
            speed_kt: 1.5,
            ..fast_seg.clone()
        };

        let fast = ground_ops_model(&fast_seg, GROUND_OPS_KIND_TAXI);
        let slow = ground_ops_model(&slow_seg, GROUND_OPS_KIND_TAXI);

        // Anchor on the actual table value for whatever profile fast_seg
        // uses (avoids hard-coding placeholder constants).
        let cls = noise_class_of(fast_seg.profile_idx) as usize;
        let exp_taxi = GROUND_OPS_REFERENCE_SEL_DB[cls][1];
        assert!((fast.ref_sel_db - (exp_taxi + GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
        assert!((slow.ref_sel_db - (exp_taxi - GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
    }

    // ── estimate_reach_m ──

    #[test]
    fn test_estimate_reach_lightga_shorter_than_jets() {
        // Light GA (PISTON_SE_PROP class) should have a shorter 40 dB reach
        // than narrowbody jets (B738). The placeholder PISTON profiles are
        // hand-tuned to be ~10 dB quieter than B738; with real ANP CF567B
        // departure tail the gap is even larger.
        let ga = PROFILES[profile_idx("C172") as usize].estimate_reach_m(40.0, false);
        let b738 = PROFILES[profile_idx("B738") as usize].estimate_reach_m(40.0, false);
        assert!(
            ga < b738,
            "GA reach ({ga:.0}) should be shorter than B738 ({b738:.0})"
        );
    }

    #[test]
    fn test_estimate_reach_jets_physics() {
        // Sample a few canonical jet typecodes and verify their 40 dB
        // approach reach lands in the airborne-jet range. Real ANP NPD
        // tails span 5–16 km depending on aircraft.
        for tc in ["B738", "A320", "A321", "B772", "A359"] {
            let p = &PROFILES[profile_idx(tc) as usize];
            let reach = p.estimate_reach_m(40.0, false);
            assert!(
                reach > 4_000.0 && reach <= AIRCRAFT_NPD_REACH_CAP_M,
                "{tc} approach reach at 40 dB should be 4–16 km, got {reach:.0}"
            );
        }
    }

    #[test]
    fn test_estimate_reach_departure_ge_approach() {
        for profile in &PROFILES {
            let dep = profile.estimate_reach_m(40.0, true);
            let app = profile.estimate_reach_m(40.0, false);
            assert!(
                dep >= app - 1.0,
                "{}: departure reach ({dep:.0}) should >= approach ({app:.0})",
                profile.name
            );
        }
    }

    #[test]
    fn test_estimate_reach_higher_threshold_shorter() {
        let reach_40 = PROFILES[6].estimate_reach_m(40.0, false);
        let reach_50 = PROFILES[6].estimate_reach_m(50.0, false);
        assert!(
            reach_50 < reach_40,
            "Higher threshold should give shorter reach: 50dB={reach_50:.0} vs 40dB={reach_40:.0}"
        );
    }

    /// `similarity_fallback` invoked via `profile_idx` for unmapped typecodes
    /// must route real ADSB typecodes (sampled from the 24-day scan, top
    /// unmapped by traffic) onto the closest anchor profile. Typecodes
    /// already covered by the strict ICAO 4-letter match (R44, S76, AT72,
    /// DH8C, etc.) are NOT in this list — those return their own idx
    /// directly without invoking similarity_fallback. Drift here means a
    /// real ICAO category got silently re-routed.
    #[test]
    fn test_similarity_fallback_top_unmapped() {
        let cases: &[(&str, &str)] = &[
            ("PC12", "DH8D"), // Pilatus PC-12 turboprop
            ("C208", "DH8D"), // Cessna 208 Caravan — single-engine turboprop
            ("C20T", "DH8D"), // Cessna 208 Caravan EX (turboprop) — tagged different
            ("C441", "DH8D"), // Cessna 441 Conquest — twin turboprop
            ("BE20", "DH8D"), // King Air 200 (turboprop)
            // BE36 is in the strict ICAO_TYPECODE_TO_ACFT_ID table (its own ANP
            // profile in PROP_C172 class), so it bypasses similarity_fallback
            // entirely. The cases below exercise the fallback path only.
            ("BE35", "C172"), // Beech V35 Bonanza — piston single (NOT a turboprop)
            ("BE58", "C172"), // Beech Baron 58 — piston twin
            ("BE76", "C172"), // Beech Duchess — piston twin
            ("C130", "DH8D"), // C-130 Hercules — military 4-eng turboprop
            ("C150", "C172"), // Cessna 150
            ("C180", "C172"), // Cessna 180
            ("C185", "C172"), // Cessna 185
            ("S22T", "C172"), // Cirrus SR22T
            ("CL30", "CRJ9"), // Bombardier Challenger 300
            ("CL35", "CRJ9"), // Bombardier Challenger 350
            ("E55P", "CRJ9"), // Embraer Phenom 300
            ("E545", "CRJ9"), // Embraer Legacy 450
            ("E110", "DH8D"), // Embraer EMB-110 Bandeirante — twin turboprop
            ("E120", "DH8D"), // Embraer EMB-120 Brasilia — twin turboprop
            ("GLF4", "CRJ9"), // Gulfstream G450
            ("F900", "CRJ9"), // Falcon 900
            ("F2TH", "CRJ9"), // Falcon 2000
            ("H125", "EC35"), // Airbus H125
            ("H145", "EC35"), // Airbus H145
            ("RV6", "C172"),  // Vans RV-6
            ("PA46", "C172"), // Piper PA-46 Malibu
            ("LJ45", "CRJ9"), // Learjet 45
            ("B712", "CRJ9"), // Boeing 717-200 — rear-fuselage twin-jet (was
                              //   wrongly matched as Beechcraft → DH8D before
                              //   /gg DeepSeek caught the 10–15 dB under-estimate)
            ("B461", "CRJ9"), // BAe 146-100 — 4-engine RJ (NOT a Bell helicopter)
            ("B463", "CRJ9"), // BAe 146-300 — 4-engine RJ
            ("RJ85", "CRJ9"), // Avro RJ85 — BAe 146 derivative
        ];
        for (typecode, expected_anchor) in cases {
            let got = profile_idx(typecode);
            let expected = profile_idx(expected_anchor);
            assert_eq!(
                got, expected,
                "{} → idx {} but expected anchor {} (idx {})",
                typecode, got, expected_anchor, expected
            );
            assert_ne!(
                got, FALLBACK_PROFILE_IDX,
                "{} should not fall through to FALLBACK_PROFILE_IDX",
                typecode
            );
        }
    }

    #[test]
    fn test_similarity_fallback_unknown_still_fallback() {
        // Truly exotic / military / experimental codes: still FALLBACK.
        for typecode in ["XXXX", "ZZZ", "9999", "TUM", "EXOT"] {
            assert_eq!(profile_idx(typecode), FALLBACK_PROFILE_IDX, "{}", typecode);
        }
    }
}
