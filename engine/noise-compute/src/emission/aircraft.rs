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

// ═══════════════════════════════════════════════════════════════════════════
// NPD tables (Doc 29 §4.2)
// ═══════════════════════════════════════════════════════════════════════════

/// Standard NPD distances in feet (Doc 29 §4.2, 10 points).
#[allow(dead_code)]
const NPD_DIST_FT: [f64; 10] = [200.0, 400.0, 630.0, 1000.0, 2000.0, 4000.0, 6310.0, 10000.0, 16000.0, 25000.0];

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
pub struct NpdProfile {
    pub name: &'static str,
    pub approach_sel: [f64; 10],
    pub departure_sel: [f64; 10],
    pub v_ref_kt: f64,
    pub d_bar_m: f64,
    pub installation: Installation,
}

/// 8 proxy profiles (index matches parquet profile_idx 0-7).
pub static PROFILES: [NpdProfile; 8] = [
    // 0: B738 (Boeing 737 family)
    NpdProfile {
        name: "B738",
        approach_sel:  [104.0, 99.0, 95.0, 91.0, 84.0, 77.0, 72.0, 66.0, 60.0, 54.0],
        departure_sel: [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 57.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Wing,
    },
    // 1: A320 (Airbus A319/A320/BCS)
    NpdProfile {
        name: "A320",
        approach_sel:  [103.0, 98.0, 94.0, 90.0, 83.0, 76.0, 71.0, 65.0, 59.0, 53.0],
        departure_sel: [107.0, 102.0, 98.0, 94.0, 87.0, 80.0, 75.0, 69.0, 63.0, 56.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Wing,
    },
    // 2: A321 (A321, B757)
    NpdProfile {
        name: "A321",
        approach_sel:  [105.0, 100.0, 96.0, 92.0, 85.0, 78.0, 73.0, 67.0, 61.0, 55.0],
        departure_sel: [109.0, 104.0, 100.0, 96.0, 89.0, 82.0, 77.0, 71.0, 65.0, 58.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Wing,
    },
    // 3: Widebody (B777/787/747, A330/340/350/380)
    NpdProfile {
        name: "Widebody",
        approach_sel:  [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 58.0],
        departure_sel: [113.0, 108.0, 104.0, 100.0, 93.0, 86.0, 81.0, 75.0, 69.0, 62.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Wing,
    },
    // 4: Turboprop (ATR, Dash 8, L410)
    NpdProfile {
        name: "Turboprop",
        approach_sel:  [96.0, 91.0, 87.0, 83.0, 76.0, 69.0, 64.0, 58.0, 52.0, 46.0],
        departure_sel: [99.0, 94.0, 90.0, 86.0, 79.0, 72.0, 67.0, 61.0, 55.0, 48.0],
        v_ref_kt: 130.0, d_bar_m: 261.0, installation: Installation::Propeller,
    },
    // 5: BizJet / Regional Jet (E-Jets, CRJ, Citations)
    NpdProfile {
        name: "BizJet",
        approach_sel:  [99.0, 94.0, 90.0, 86.0, 79.0, 72.0, 67.0, 61.0, 55.0, 49.0],
        departure_sel: [103.0, 98.0, 94.0, 90.0, 83.0, 76.0, 71.0, 65.0, 59.0, 52.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Fuselage,
    },
    // 6: LightGA + Rotorcraft (C172, PA28, helicopters)
    NpdProfile {
        name: "LightGA",
        approach_sel:  [88.0, 83.0, 79.0, 75.0, 68.0, 61.0, 56.0, 50.0, 44.0, 38.0],
        departure_sel: [90.0, 85.0, 81.0, 77.0, 70.0, 63.0, 58.0, 52.0, 46.0, 40.0],
        v_ref_kt: 90.0, d_bar_m: 208.0, installation: Installation::Propeller,
    },
    // 7: Generic (unmapped typecodes — B738-equivalent)
    NpdProfile {
        name: "Generic",
        approach_sel:  [104.0, 99.0, 95.0, 91.0, 84.0, 77.0, 72.0, 66.0, 60.0, 54.0],
        departure_sel: [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 57.0],
        v_ref_kt: 160.0, d_bar_m: 370.0, installation: Installation::Wing,
    },
];

/// Interpolate SEL at a given slant distance (Doc 29 §4.2, Eq. 4-4/4-5).
/// Log-linear interpolation in distance.
#[inline]
pub fn interpolate_sel(profile: &NpdProfile, slant_ft: f64, is_departure: bool) -> f64 {
    let log_d = slant_ft.max(100.0).log10();
    interpolate_sel_logd(profile, log_d, is_departure)
}

/// NPD interpolation using pre-computed log10(distance_ft).
/// Avoids redundant log10 call when log_d is already available.
#[inline(always)]
pub fn interpolate_sel_logd(profile: &NpdProfile, log_d: f64, is_departure: bool) -> f64 {
    let sel = if is_departure { &profile.departure_sel } else { &profile.approach_sel };
    let last = sel.len() - 1;

    if log_d <= LOG_DIST[0] {
        let slope = (sel[1] - sel[0]) / (LOG_DIST[1] - LOG_DIST[0]);
        return sel[0] + slope * (log_d - LOG_DIST[0]);
    }
    if log_d >= LOG_DIST[last] {
        let slope = (sel[last] - sel[last - 1]) / (LOG_DIST[last] - LOG_DIST[last - 1]);
        return sel[last] + slope * (log_d - LOG_DIST[last]);
    }

    for i in 0..last {
        if log_d <= LOG_DIST[i + 1] {
            let frac = (log_d - LOG_DIST[i]) / (LOG_DIST[i + 1] - LOG_DIST[i]);
            return sel[i] + frac * (sel[i + 1] - sel[i]);
        }
    }
    sel[last]
}

// ═══════════════════════════════════════════════════════════════════════════
// CPA geometry (Doc 29 §4.4.1)
// ═══════════════════════════════════════════════════════════════════════════

const M_PER_DEG_LAT: f64 = 111_132.92;

/// CPA result for one segment-receiver pair.
pub struct CpaResult {
    pub q_m: f64,           // signed distance from S1 to perpendicular foot
    pub d_p_m: f64,         // perpendicular slant distance (for NPD lookup)
    pub lateral_m: f64,     // horizontal distance to ground track extension
    pub relative_alt_m: f64,// altitude at foot relative to receiver
    pub beta_deg: f64,      // elevation angle from ground plane
    pub seg_len_m: f64,     // segment length
}

/// Compute CPA on INFINITE segment extension (Doc 29 §4.4.1).
/// t is NOT clamped — this is the key correctness fix over all other implementations.
#[inline]
pub fn compute_cpa(
    rx_lat: f64, rx_lon: f64, rx_elev_m: f64,
    s1_lat: f64, s1_lon: f64, s1_alt_m: f64,
    s2_lat: f64, s2_lon: f64, s2_alt_m: f64,
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

    // Parametric projection — NO CLAMP
    let t = if seg_len_sq > 1e-6 {
        -(x1 * dx + y1 * dy) / seg_len_sq
    } else {
        0.5
    };

    let cx = x1 + t * dx;
    let cy = y1 + t * dy;
    let lateral_m = (cx * cx + cy * cy).sqrt();

    let alt_at_foot = s1_alt_m + t * (s2_alt_m - s1_alt_m);
    let relative_alt_m = (alt_at_foot - rx_elev_m).max(0.0);
    let d_p_m = (lateral_m * lateral_m + relative_alt_m * relative_alt_m).sqrt();
    let q_m = t * seg_len;

    let beta_deg = if lateral_m > 0.01 || relative_alt_m > 0.01 {
        relative_alt_m.atan2(lateral_m).to_degrees()
    } else {
        90.0
    };

    CpaResult { q_m, d_p_m, lateral_m, relative_alt_m, beta_deg, seg_len_m: seg_len }
}

// ═══════════════════════════════════════════════════════════════════════════
// Acoustic corrections
// ═══════════════════════════════════════════════════════════════════════════

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
    if seg_len_m < 1.0 || d_bar_m < 1.0 { return 0.0; }

    let alpha1 = -q_m / d_bar_m;
    let alpha2 = -(q_m - seg_len_m) / d_bar_m;

    let g1 = alpha1 / (1.0 + alpha1 * alpha1) + alpha1.atan();
    let g2 = alpha2 / (1.0 + alpha2 * alpha2) + alpha2.atan();
    let f = (g2 - g1) / PI;

    10.0 * f.max(1e-15).log10()
}

/// Lateral attenuation Λ(β, l) = Γ(l) × Λ(β) (Doc 29 §4.5.4, Eq. 4-18/4-19).
#[inline]
pub fn lateral_attenuation(beta_deg: f64, lateral_m: f64) -> f64 {
    if beta_deg < 0.0 { return 10.857; }

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
    if total_energy <= 0.0 || n_days <= 0.0 { return f64::NEG_INFINITY; }
    10.0 * (total_energy / (n_days * period_seconds)).log10()
}

// ═══════════════════════════════════════════════════════════════════════════
// Single-segment SEL computation
// ═══════════════════════════════════════════════════════════════════════════

use crate::types::AircraftSegment;

/// Compute SEL for a single aircraft segment at a receiver point.
/// Returns (SEL_dB, CpaResult) or None if segment is too far / inaudible.
pub fn segment_sel(
    seg: &AircraftSegment,
    rx_lat: f64, rx_lon: f64, rx_elev_m: f64,
) -> Option<(f64, CpaResult)> {
    let profile = &PROFILES[seg.profile_idx.min(7) as usize];

    let cpa = compute_cpa(
        rx_lat, rx_lon, rx_elev_m,
        seg.start_lat, seg.start_lon, seg.start_alt_m as f64,
        seg.end_lat, seg.end_lon, seg.end_alt_m as f64,
    );

    // Skip beyond 12km (unified popup + pipeline cutoff)
    if cpa.d_p_m > 12000.0 { return None; }

    // NPD lookup
    let sel_npd = interpolate_sel(profile, cpa.d_p_m * FT_PER_M, seg.is_departure);

    // Corrections
    let dv = delta_v(seg.speed_kt as f64, profile);
    let df = delta_f(cpa.q_m, cpa.seg_len_m, profile.d_bar_m);

    // Lateral attenuation applied to all profiles including profile 6 (LightGA+Rotorcraft).
    // WHY: Profile 6 is a mixed bucket (C172, PA28 + helicopters). Old code skipped lateral
    // attenuation for ALL profile 6, overestimating fixed-wing GA noise by up to 10.9 dB.
    // Helicopters technically don't have lateral attenuation, but they're ~10% of profile 6.
    let lambda = lateral_attenuation(cpa.beta_deg, cpa.lateral_m);

    let di = delta_i(cpa.beta_deg, profile.installation);

    // Master equation (Eq. 4-8b)
    let sel = sel_npd + dv + di - lambda + df;

    if sel < 20.0 { return None; }
    Some((sel, cpa))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── NPD ──

    #[test]
    fn test_npd_at_table_node() {
        let sel = interpolate_sel(&PROFILES[0], 1000.0, false);
        assert!((sel - 91.0).abs() < 0.01, "Expected 91.0, got {sel}");
    }

    #[test]
    fn test_npd_interpolation() {
        let sel = interpolate_sel(&PROFILES[0], 1500.0, false);
        assert!((sel - 86.9).abs() < 0.1, "Expected ~86.9, got {sel}");
    }

    #[test]
    fn test_npd_extrapolation_below() {
        let sel = interpolate_sel(&PROFILES[0], 100.0, false);
        assert!(sel > 104.0, "Should extrapolate above 104, got {sel}");
    }

    #[test]
    fn test_npd_extrapolation_above() {
        let sel = interpolate_sel(&PROFILES[0], 50000.0, false);
        assert!(sel < 54.0, "Should extrapolate below 54, got {sel}");
    }

    // ── CPA geometry ──

    #[test]
    fn test_cpa_alongside() {
        let cpa = compute_cpa(
            50.005, 14.01, 300.0,
            50.0, 14.0, 1000.0,
            50.01, 14.0, 1000.0,
        );
        assert!(cpa.q_m > 0.0, "q should be positive");
        assert!(cpa.d_p_m > 500.0 && cpa.d_p_m < 2000.0, "d_p = {}", cpa.d_p_m);
        assert!(cpa.beta_deg > 20.0 && cpa.beta_deg < 70.0, "β = {}", cpa.beta_deg);
    }

    #[test]
    fn test_cpa_behind_segment() {
        let cpa = compute_cpa(
            49.99, 14.01, 300.0,
            50.0, 14.0, 1000.0,
            50.01, 14.0, 1000.0,
        );
        assert!(cpa.q_m < 0.0, "q should be negative (behind), got {}", cpa.q_m);
    }

    #[test]
    fn test_cpa_directly_below() {
        let cpa = compute_cpa(
            50.005, 14.0, 300.0,
            50.0, 14.0, 3000.0,
            50.01, 14.0, 3000.0,
        );
        assert!(cpa.lateral_m < 50.0, "lateral should be ~0, got {}", cpa.lateral_m);
        assert!(cpa.beta_deg > 80.0, "β should be ~90°, got {}", cpa.beta_deg);
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
        let att = lateral_attenuation(90.0, 0.0);
        assert!(att.abs() < 0.01, "Expected 0, got {att}");
    }

    #[test]
    fn test_lateral_far_side() {
        let att = lateral_attenuation(0.1, 2000.0);
        assert!((att - 10.86).abs() < 0.2, "Expected ~10.86, got {att}");
    }

    #[test]
    fn test_lateral_negative_beta() {
        let att = lateral_attenuation(-5.0, 100.0);
        assert!((att - 10.857).abs() < 0.01);
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
            flight_id: 1, profile_idx: 0, is_departure: false,
            period: 0, date_id: 0,
            start_lat: 50.0, start_lon: 14.0, start_alt_m: 1000.0,
            end_lat: 50.01, end_lon: 14.0, end_alt_m: 900.0,
            speed_kt: 150.0, segment_length_m: 1100.0,
        };
        let result = segment_sel(&seg, 50.005, 14.005, 300.0);
        assert!(result.is_some(), "should compute SEL for nearby segment");
        let (sel, cpa) = result.unwrap();
        assert!(sel > 50.0 && sel < 110.0, "SEL = {sel}");
        assert!(cpa.d_p_m > 100.0 && cpa.d_p_m < 2000.0, "d_p = {}", cpa.d_p_m);
    }

    #[test]
    fn test_segment_sel_far_away() {
        let seg = AircraftSegment {
            flight_id: 1, profile_idx: 0, is_departure: false,
            period: 0, date_id: 0,
            start_lat: 51.0, start_lon: 15.0, start_alt_m: 10000.0,
            end_lat: 51.01, end_lon: 15.0, end_alt_m: 10000.0,
            speed_kt: 250.0, segment_length_m: 1100.0,
        };
        let result = segment_sel(&seg, 50.0, 14.0, 300.0);
        assert!(result.is_none(), "should be None for far segment");
    }
}
