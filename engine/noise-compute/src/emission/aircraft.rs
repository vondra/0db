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

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

// ═══════════════════════════════════════════════════════════════════════════
// NPD tables (Doc 29 §4.2)
// ═══════════════════════════════════════════════════════════════════════════

/// NPD SEL threshold for per-profile reach calculation.
/// At this raw NPD SEL, a segment's contribution is negligible (< 0.15 dB on total Lden).
pub const AIRCRAFT_NPD_REACH_THRESHOLD_DB: f64 = 40.0;

/// Hard cap on per-profile slant reach (meters). Prevents CSR grid explosion.
/// Same as current prefilter for jets — no CSR memory regression.
pub const AIRCRAFT_NPD_REACH_CAP_M: f64 = 10_000.0;

/// Standard NPD distances in feet (Doc 29 §4.2, 10 points).
#[allow(dead_code)]
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
        approach_sel: [104.0, 99.0, 95.0, 91.0, 84.0, 77.0, 72.0, 66.0, 60.0, 54.0],
        departure_sel: [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 57.0],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Wing,
    },
    // 1: A320 (Airbus A319/A320/BCS)
    NpdProfile {
        name: "A320",
        approach_sel: [103.0, 98.0, 94.0, 90.0, 83.0, 76.0, 71.0, 65.0, 59.0, 53.0],
        departure_sel: [107.0, 102.0, 98.0, 94.0, 87.0, 80.0, 75.0, 69.0, 63.0, 56.0],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Wing,
    },
    // 2: A321 (A321, B757)
    NpdProfile {
        name: "A321",
        approach_sel: [105.0, 100.0, 96.0, 92.0, 85.0, 78.0, 73.0, 67.0, 61.0, 55.0],
        departure_sel: [
            109.0, 104.0, 100.0, 96.0, 89.0, 82.0, 77.0, 71.0, 65.0, 58.0,
        ],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Wing,
    },
    // 3: Widebody (B777/787/747, A330/340/350/380)
    NpdProfile {
        name: "Widebody",
        approach_sel: [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 58.0],
        departure_sel: [
            113.0, 108.0, 104.0, 100.0, 93.0, 86.0, 81.0, 75.0, 69.0, 62.0,
        ],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Wing,
    },
    // 4: Turboprop (ATR, Dash 8, L410)
    NpdProfile {
        name: "Turboprop",
        approach_sel: [96.0, 91.0, 87.0, 83.0, 76.0, 69.0, 64.0, 58.0, 52.0, 46.0],
        departure_sel: [99.0, 94.0, 90.0, 86.0, 79.0, 72.0, 67.0, 61.0, 55.0, 48.0],
        v_ref_kt: 130.0,
        d_bar_m: 261.0,
        installation: Installation::Propeller,
    },
    // 5: BizJet / Regional Jet (E-Jets, CRJ, Citations)
    NpdProfile {
        name: "BizJet",
        approach_sel: [99.0, 94.0, 90.0, 86.0, 79.0, 72.0, 67.0, 61.0, 55.0, 49.0],
        departure_sel: [103.0, 98.0, 94.0, 90.0, 83.0, 76.0, 71.0, 65.0, 59.0, 52.0],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Fuselage,
    },
    // 6: LightGA + Rotorcraft (C172, PA28, helicopters)
    NpdProfile {
        name: "LightGA",
        approach_sel: [88.0, 83.0, 79.0, 75.0, 68.0, 61.0, 56.0, 50.0, 44.0, 38.0],
        departure_sel: [90.0, 85.0, 81.0, 77.0, 70.0, 63.0, 58.0, 52.0, 46.0, 40.0],
        v_ref_kt: 90.0,
        d_bar_m: 208.0,
        installation: Installation::Propeller,
    },
    // 7: Generic (unmapped typecodes — B738-equivalent)
    NpdProfile {
        name: "Generic",
        approach_sel: [104.0, 99.0, 95.0, 91.0, 84.0, 77.0, 72.0, 66.0, 60.0, 54.0],
        departure_sel: [108.0, 103.0, 99.0, 95.0, 88.0, 81.0, 76.0, 70.0, 64.0, 57.0],
        v_ref_kt: 160.0,
        d_bar_m: 370.0,
        installation: Installation::Wing,
    },
];

impl NpdProfile {
    /// Slant distance (meters) at which raw NPD SEL drops to `threshold_db`.
    /// Uses log-linear extrapolation beyond the last NPD table point (25,000 ft).
    /// Capped at `AIRCRAFT_NPD_REACH_CAP_M` to prevent CSR grid explosion.
    pub fn estimate_reach_m(&self, threshold_db: f64, is_departure: bool) -> f64 {
        let sel = if is_departure {
            &self.departure_sel
        } else {
            &self.approach_sel
        };
        let last = sel.len() - 1;

        // Threshold louder than closest NPD point → minimal reach
        if threshold_db >= sel[0] {
            return NPD_DIST_FT[0] / FT_PER_M;
        }

        // Threshold below last NPD point → extrapolate
        if threshold_db <= sel[last] {
            let slope = (sel[last] - sel[last - 1]) / (LOG_DIST[last] - LOG_DIST[last - 1]);
            if slope >= -1.0 {
                return AIRCRAFT_NPD_REACH_CAP_M;
            }
            let log_d = LOG_DIST[last] + (threshold_db - sel[last]) / slope;
            return (10.0_f64.powf(log_d) / FT_PER_M).min(AIRCRAFT_NPD_REACH_CAP_M);
        }

        // Interpolate within table
        for i in 0..last {
            if threshold_db >= sel[i + 1] {
                let frac = (threshold_db - sel[i]) / (sel[i + 1] - sel[i]);
                let log_d = LOG_DIST[i] + frac * (LOG_DIST[i + 1] - LOG_DIST[i]);
                return (10.0_f64.powf(log_d) / FT_PER_M).min(AIRCRAFT_NPD_REACH_CAP_M);
            }
        }
        AIRCRAFT_NPD_REACH_CAP_M
    }
}

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
    pub q_m: f64,            // signed distance from S1 to perpendicular foot
    pub d_p_m: f64,          // perpendicular slant distance (for NPD lookup)
    pub lateral_m: f64,      // horizontal distance to ground track extension
    pub relative_alt_m: f64, // signed altitude at foot relative to receiver
    pub beta_deg: f64,       // elevation angle from ground plane
    pub seg_len_m: f64,      // segment length
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

    // Unclamped parametric projection on the infinite line.
    let t_unclamped = if seg_len_sq > 1e-6 {
        -(x1 * dx + y1 * dy) / seg_len_sq
    } else {
        0.5
    };

    // Clamp to the observed segment for acoustic geometry: when the foot of
    // perpendicular falls outside [0, 1] the aircraft actually left the track
    // (e.g., touchdown = no flight past t=1). Using endpoint-clamped d_p,
    // lateral, rel_alt, β prevents extrapolation creating fictitious close
    // passes at touchdown-adjacent receivers. Unclamped q is still used for
    // ΔF (the finite-segment dipole correction integrates along the full line).
    let t_geom = t_unclamped.clamp(0.0, 1.0);

    let cx = x1 + t_geom * dx;
    let cy = y1 + t_geom * dy;
    let lateral_m = (cx * cx + cy * cy).sqrt();

    let alt_at_foot = s1_alt_m + t_geom * (s2_alt_m - s1_alt_m);
    let relative_alt_m = alt_at_foot - rx_elev_m;
    let d_p_m = (lateral_m * lateral_m + relative_alt_m * relative_alt_m).sqrt();
    let q_m = t_unclamped * seg_len;

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
    }
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

/// Lateral attenuation Λ(β, l) = Γ(l) × Λ(β) (Doc 29 §4.5.4, Eq. 4-18/4-19).
#[inline]
pub fn lateral_attenuation(beta_deg: f64, lateral_m: f64) -> f64 {
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

// ═══════════════════════════════════════════════════════════════════════════
// Single-segment SEL computation
// ═══════════════════════════════════════════════════════════════════════════

use crate::constants::{ALPHA_ATM, A_WEIGHTING};
use crate::propagation::geo;
use crate::types::{
    AircraftSegment, AirportArea, AirportLine, RasterSampler, NUM_BANDS,
    default_receiver_altitude_m,
};

/// Runtime fallback for stale prepared ADS-B data that still contains taxi or
/// runway-roll segments. The authoritative fix is extractor-side `on_ground`
/// filtering, but until the full dataset is rebuilt we also reject segments
/// whose both endpoints stay close to local terrain.
pub const GROUND_STALE_MAX_AGL_M: f64 = 15.0;
pub const AIRPORT_GROUND_MAX_AGL_M: f64 = 60.0;
pub const GROUND_CONTEXT_NONE: u8 = 0;
pub const GROUND_CONTEXT_AIRPORT_LINE: u8 = 1;
pub const GROUND_CONTEXT_AIRPORT_AREA: u8 = 2;
pub const GROUND_CONTEXT_INFERRED: u8 = 3;
pub const GROUND_OPS_KIND_NONE: u8 = 0;
pub const GROUND_OPS_KIND_RUNWAY_ROLL: u8 = 1;
pub const GROUND_OPS_KIND_TAXI: u8 = 2;
pub const GROUND_OPS_KIND_APRON_MOVEMENT: u8 = 3;
pub const GROUND_OPS_SOURCE_HEIGHT_M: f64 = 4.0;

const AEROWAY_RUNWAY: u8 = 0;
const AEROWAY_TAXIWAY: u8 = 1;
const AEROWAY_APRON: u8 = 2;
const AEROWAY_HELIPAD: u8 = 3;
const AEROWAY_HELIPORT: u8 = 4;
const AEROWAY_AERODROME: u8 = 5;
const AEROWAY_STOPWAY: u8 = 6;
const AIRPORT_MATCH_CELL_DEG: f64 = 250.0 / 111_320.0;
const SURFACE_TRAFFIC_RADIUS_M: f64 = 2_500.0;
const SURFACE_TRAFFIC_MAX_AGL_M: f64 = 600.0;
const SURFACE_MIN_OBSERVED_FLIGHTS: usize = 12;
const SURFACE_SYNTH_MIN_WEIGHT: f64 = 0.05;
const SURFACE_RUNWAY_SHARE: f64 = 0.70;
const SURFACE_TAXIWAY_SHARE: f64 = 0.20;
const SURFACE_APRON_SHARE: f64 = 0.10;
const SURFACE_RUNWAY_SPEED_KT: f32 = 70.0;
const SURFACE_TAXIWAY_SPEED_KT: f32 = 18.0;
const SURFACE_APRON_SPEED_KT: f32 = 12.0;
const SURFACE_HELIPAD_SPEED_KT: f32 = 6.0;
const SURFACE_AREA_POINT_SPACING_M: f64 = 90.0;
const SURFACE_AREA_POINT_MAX: usize = 8;
const SURFACE_POINT_SEGMENT_M: f64 = 24.0;
pub const SURFACE_FLIGHT_ID_BASE: u64 = 0xff00_0000_0000_0000;
const GROUND_OPS_REF_OFFSET_M: f64 = 25.0;
const GROUND_OPS_SPEED_CLAMP_DB: f64 = 3.0;
const GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB: f64 = 2.0;
const GROUND_OPS_RUNWAY_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [17.0, 14.0, 11.0, 8.0, 5.0, 2.0, -1.0, -5.0];
const GROUND_OPS_TAXI_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [14.0, 11.0, 8.0, 5.0, 2.0, 0.0, -3.0, -7.0];
const GROUND_OPS_APRON_SPECTRUM_SHAPE: [f64; NUM_BANDS] =
    [12.0, 9.0, 6.0, 3.0, 1.0, -1.0, -4.0, -8.0];
const GROUND_OPS_REFERENCE_SEL_DB: [[f64; 3]; 8] = [
    [104.0, 92.0, 86.0], // B738
    [103.0, 91.0, 85.0], // A320
    [105.0, 93.0, 87.0], // A321
    [108.0, 96.0, 90.0], // Widebody
    [97.0, 86.0, 80.0],  // Turboprop
    [99.0, 88.0, 82.0],  // BizJet
    [92.0, 82.0, 76.0],  // LightGA + Rotorcraft
    [102.0, 90.0, 84.0], // Generic
];
const INFERRED_GROUND_CELL_M: f64 = 250.0;
const INFERRED_GROUND_SUPPORT_RADIUS_M: f64 = 600.0;
const INFERRED_GROUND_NEIGHBOR_CELLS: i32 = 3;
const INFERRED_GROUND_MIN_EXTENT_M: f64 = 180.0;
const INFERRED_GROUND_MIN_DAYS_FLOOR: usize = 2;
const INFERRED_GROUND_MIN_DAY_RATIO: f64 = 0.01;
const INFERRED_GROUND_MIN_FLIGHTS_FLOOR: usize = 6;
const INFERRED_GROUND_MIN_SEGMENTS_FLOOR: usize = 8;
const INFERRED_GROUND_MIN_SEGMENT_M: f32 = 80.0;
const INFERRED_GROUND_MAX_SEGMENT_M: f32 = 6_000.0;
const INFERRED_GROUND_MIN_SPEED_KT: f32 = 3.0;
const INFERRED_GROUND_MAX_SPEED_KT: f32 = 80.0;

pub struct AirportMatcher<'a> {
    airport_lines: &'a [AirportLine],
    airport_areas: &'a [AirportArea],
    line_index: HashMap<(i32, i32), Vec<usize>>,
    area_index: HashMap<(i32, i32), Vec<usize>>,
}

impl<'a> AirportMatcher<'a> {
    pub fn new(airport_lines: &'a [AirportLine], airport_areas: &'a [AirportArea]) -> Self {
        let mut line_index = HashMap::new();
        for (idx, line) in airport_lines.iter().enumerate() {
            let pad_m = airport_line_match_radius_m(line);
            let center_lat = (line.start_lat + line.end_lat) * 0.5;
            let lon_pad_deg = meters_to_lon_deg(center_lat, pad_m);
            let lat_pad_deg = meters_to_lat_deg(pad_m);
            let min_lat = line.start_lat.min(line.end_lat) - lat_pad_deg;
            let max_lat = line.start_lat.max(line.end_lat) + lat_pad_deg;
            let min_lon = line.start_lon.min(line.end_lon) - lon_pad_deg;
            let max_lon = line.start_lon.max(line.end_lon) + lon_pad_deg;
            insert_bbox_cells(&mut line_index, min_lat, max_lat, min_lon, max_lon, idx);
        }

        let mut area_index = HashMap::new();
        for (idx, area) in airport_areas.iter().enumerate() {
            let pad_m = airport_area_prune_radius_m(area);
            let lon_pad_deg = meters_to_lon_deg(area.centroid_lat, pad_m);
            let lat_pad_deg = meters_to_lat_deg(pad_m);
            insert_bbox_cells(
                &mut area_index,
                area.centroid_lat - lat_pad_deg,
                area.centroid_lat + lat_pad_deg,
                area.centroid_lon - lon_pad_deg,
                area.centroid_lon + lon_pad_deg,
                idx,
            );
        }

        Self {
            airport_lines,
            airport_areas,
            line_index,
            area_index,
        }
    }

    pub fn segment_ground_context(&self, seg: &AircraftSegment) -> u8 {
        let sample_points = [
            (seg.start_lat, seg.start_lon),
            (
                (seg.start_lat + seg.end_lat) * 0.5,
                (seg.start_lon + seg.end_lon) * 0.5,
            ),
            (seg.end_lat, seg.end_lon),
        ];

        if sample_points
            .iter()
            .any(|&(lat, lon)| self.point_matches_airport_area(lat, lon))
        {
            return GROUND_CONTEXT_AIRPORT_AREA;
        }
        if sample_points
            .iter()
            .any(|&(lat, lon)| self.point_matches_airport_line(lat, lon))
        {
            return GROUND_CONTEXT_AIRPORT_LINE;
        }
        GROUND_CONTEXT_NONE
    }

    pub fn segment_ground_ops_kind(&self, seg: &AircraftSegment) -> u8 {
        let sample_points = [
            (seg.start_lat, seg.start_lon),
            (
                (seg.start_lat + seg.end_lat) * 0.5,
                (seg.start_lon + seg.end_lon) * 0.5,
            ),
            (seg.end_lat, seg.end_lon),
        ];

        let mut best_kind = GROUND_OPS_KIND_NONE;
        for &(lat, lon) in &sample_points {
            best_kind = pick_stronger_ground_ops_kind(best_kind, self.point_ground_ops_kind(lat, lon));
        }
        if best_kind != GROUND_OPS_KIND_NONE {
            return best_kind;
        }
        if seg.ground_context != GROUND_CONTEXT_NONE || seg.on_ground || seg.surface_model {
            return ground_ops_kind_fallback(seg);
        }
        GROUND_OPS_KIND_NONE
    }

    fn point_matches_airport_line(&self, lat: f64, lon: f64) -> bool {
        self.line_index
            .get(&airport_match_cell(lat, lon))
            .into_iter()
            .flat_map(|indices| indices.iter().copied())
            .any(|idx| {
                let line = &self.airport_lines[idx];
                let cp = geo::closest_point_on_segment(
                    lat,
                    lon,
                    line.start_lat,
                    line.start_lon,
                    line.end_lat,
                    line.end_lon,
                );
                cp.dist_m <= airport_line_match_radius_m(line)
            })
    }

    fn point_matches_airport_area(&self, lat: f64, lon: f64) -> bool {
        self.area_index
            .get(&airport_match_cell(lat, lon))
            .into_iter()
            .flat_map(|indices| indices.iter().copied())
            .any(|idx| airport_area_contains_point(&self.airport_areas[idx], lat, lon))
    }

    fn point_ground_ops_kind(&self, lat: f64, lon: f64) -> u8 {
        let mut best_kind = GROUND_OPS_KIND_NONE;
        if let Some(indices) = self.area_index.get(&airport_match_cell(lat, lon)) {
            for &idx in indices {
                if airport_area_contains_point(&self.airport_areas[idx], lat, lon) {
                    best_kind = pick_stronger_ground_ops_kind(
                        best_kind,
                        ground_ops_kind_from_aeroway_type(self.airport_areas[idx].aeroway_type),
                    );
                }
            }
        }
        if let Some(indices) = self.line_index.get(&airport_match_cell(lat, lon)) {
            for &idx in indices {
                let line = &self.airport_lines[idx];
                let cp = geo::closest_point_on_segment(
                    lat,
                    lon,
                    line.start_lat,
                    line.start_lon,
                    line.end_lat,
                    line.end_lon,
                );
                if cp.dist_m <= airport_line_match_radius_m(line) {
                    best_kind = pick_stronger_ground_ops_kind(
                        best_kind,
                        ground_ops_kind_from_aeroway_type(line.aeroway_type),
                    );
                }
            }
        }
        best_kind
    }
}

pub fn segment_ground_context(
    seg: &AircraftSegment,
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
) -> u8 {
    AirportMatcher::new(airport_lines, airport_areas).segment_ground_context(seg)
}

pub fn segment_ground_ops_kind(
    seg: &AircraftSegment,
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
) -> u8 {
    AirportMatcher::new(airport_lines, airport_areas).segment_ground_ops_kind(seg)
}

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

fn pick_stronger_ground_ops_kind(current: u8, candidate: u8) -> u8 {
    if ground_ops_kind_priority(candidate) > ground_ops_kind_priority(current) {
        candidate
    } else {
        current
    }
}

fn ground_ops_kind_priority(kind: u8) -> u8 {
    match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => 3,
        GROUND_OPS_KIND_TAXI => 2,
        GROUND_OPS_KIND_APRON_MOVEMENT => 1,
        _ => 0,
    }
}

fn ground_ops_kind_from_aeroway_type(aeroway_type: u8) -> u8 {
    match aeroway_type {
        AEROWAY_RUNWAY | AEROWAY_STOPWAY => GROUND_OPS_KIND_RUNWAY_ROLL,
        AEROWAY_TAXIWAY => GROUND_OPS_KIND_TAXI,
        AEROWAY_APRON | AEROWAY_HELIPAD | AEROWAY_HELIPORT => GROUND_OPS_KIND_APRON_MOVEMENT,
        _ => GROUND_OPS_KIND_NONE,
    }
}

fn ground_ops_kind_fallback(seg: &AircraftSegment) -> u8 {
    if seg.speed_kt >= 40.0 || seg.segment_length_m >= 500.0 {
        GROUND_OPS_KIND_RUNWAY_ROLL
    } else if seg.speed_kt >= 8.0 {
        GROUND_OPS_KIND_TAXI
    } else {
        GROUND_OPS_KIND_APRON_MOVEMENT
    }
}

pub fn infer_repeated_ground_context(segments: &mut [AircraftSegment], n_days: u16) -> usize {
    #[derive(Clone, Copy)]
    struct Candidate {
        seg_idx: usize,
        flight_id: u64,
        date_id: i16,
        mid_lat: f64,
        mid_lon: f64,
    }

    let mut candidates = Vec::new();
    let mut cell_index: HashMap<(i32, i32), Vec<usize>> = HashMap::new();

    for (seg_idx, seg) in segments.iter().enumerate() {
        if !is_inferred_ground_candidate(seg) {
            continue;
        }
        let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
        let candidate_idx = candidates.len();
        candidates.push(Candidate {
            seg_idx,
            flight_id: seg.flight_id,
            date_id: seg.date_id,
            mid_lat,
            mid_lon,
        });
        cell_index
            .entry(inferred_ground_cell(mid_lat, mid_lon))
            .or_default()
            .push(candidate_idx);
    }

    if candidates.len() < INFERRED_GROUND_MIN_SEGMENTS_FLOOR {
        return 0;
    }

    let min_days = ((n_days as f64) * INFERRED_GROUND_MIN_DAY_RATIO)
        .ceil()
        .max(INFERRED_GROUND_MIN_DAYS_FLOOR as f64) as usize;
    let min_flights = (min_days * 2).max(INFERRED_GROUND_MIN_FLIGHTS_FLOOR);
    let min_segments = (min_days * 2).max(INFERRED_GROUND_MIN_SEGMENTS_FLOOR);
    let mut marked = Vec::new();

    eprintln!(
        "  [Aircraft] infer_repeated_ground_context: starting with {} candidates",
        candidates.len()
    );
    let mut last_log = std::time::Instant::now();

    for (i, cand) in candidates.iter().enumerate() {
        if last_log.elapsed().as_secs() >= 5 {
            eprintln!("  [Aircraft] infer progress: {}/{}", i, candidates.len());
            last_log = std::time::Instant::now();
        }
        let (cy, cx) = inferred_ground_cell(cand.mid_lat, cand.mid_lon);
        let mut support_segments = 0usize;
        let mut support_days: HashSet<i16> = HashSet::new();
        let mut support_flights: HashSet<u64> = HashSet::new();
        let mut lat_min = cand.mid_lat;
        let mut lat_max = cand.mid_lat;
        let mut lon_min = cand.mid_lon;
        let mut lon_max = cand.mid_lon;

        for y in cy - INFERRED_GROUND_NEIGHBOR_CELLS..=cy + INFERRED_GROUND_NEIGHBOR_CELLS {
            for x in cx - INFERRED_GROUND_NEIGHBOR_CELLS..=cx + INFERRED_GROUND_NEIGHBOR_CELLS {
                let Some(neighbors) = cell_index.get(&(y, x)) else {
                    continue;
                };
                for &other_idx in neighbors {
                    let other = candidates[other_idx];
                    if geo::flat_dist(cand.mid_lat, cand.mid_lon, other.mid_lat, other.mid_lon)
                        > INFERRED_GROUND_SUPPORT_RADIUS_M
                    {
                        continue;
                    }
                    support_segments += 1;
                    support_days.insert(other.date_id);
                    support_flights.insert(other.flight_id);
                    lat_min = lat_min.min(other.mid_lat);
                    lat_max = lat_max.max(other.mid_lat);
                    lon_min = lon_min.min(other.mid_lon);
                    lon_max = lon_max.max(other.mid_lon);
                }
            }
        }

        let extent_m = geo::flat_dist(lat_min, lon_min, lat_max, lon_max);
        if support_segments < min_segments
            || support_days.len() < min_days
            || support_flights.len() < min_flights
            || extent_m < INFERRED_GROUND_MIN_EXTENT_M
        {
            continue;
        }
        marked.push(cand.seg_idx);
    }

    marked.sort_unstable();
    marked.dedup();
    for seg_idx in &marked {
        segments[*seg_idx].ground_context = GROUND_CONTEXT_INFERRED;
    }
    marked.len()
}

#[derive(Debug, Default, Clone, Copy)]
pub struct GroundPreparationStats {
    pub airport_context_marked: usize,
    pub inferred_context_marked: usize,
    pub resolved_ops_kind: usize,
}

pub fn prepare_ground_context(
    segments: &mut [AircraftSegment],
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
    rasters: &dyn RasterSampler,
    n_days: u16,
    enable_inference: bool,
) -> GroundPreparationStats {
    let matcher = AirportMatcher::new(airport_lines, airport_areas);
    let mut stats = GroundPreparationStats::default();

    for seg in segments.iter_mut() {
        if seg.surface_model || seg.ground_context != GROUND_CONTEXT_NONE {
            continue;
        }
        if !is_airport_context_candidate_raw(seg, rasters) {
            continue;
        }
        let context = matcher.segment_ground_context(seg);
        if context == GROUND_CONTEXT_NONE {
            continue;
        }
        seg.ground_context = context;
        if seg.ground_ops_kind == GROUND_OPS_KIND_NONE {
            seg.ground_ops_kind = matcher.segment_ground_ops_kind(seg);
        }
        stats.airport_context_marked += 1;
    }

    // `infer_repeated_ground_context` is an O(N log N) multi-day clustering pass
    // that discovers unmapped grass strips / informal heliports from repeated
    // stopped low-AGL traces. It takes minutes on airport-area hexes (336k+
    // candidates) and MUST be skipped on the popup path (single-point query)
    // to keep interactive latency sub-second. Pipeline tiles still run it so
    // the inferred strips show up on the atlas.
    if enable_inference {
        stats.inferred_context_marked = infer_repeated_ground_context(segments, n_days);
    }

    for seg in segments.iter_mut() {
        if seg.ground_ops_kind == GROUND_OPS_KIND_NONE && seg.ground_context != GROUND_CONTEXT_NONE
        {
            let kind = resolve_ground_ops_kind(seg);
            if kind != GROUND_OPS_KIND_NONE {
                seg.ground_ops_kind = kind;
                stats.resolved_ops_kind += 1;
            }
        }
    }

    stats
}

fn is_inferred_ground_candidate(seg: &AircraftSegment) -> bool {
    seg.on_ground
        && !seg.surface_model
        && seg.ground_context == GROUND_CONTEXT_NONE
        && seg.segment_length_m >= INFERRED_GROUND_MIN_SEGMENT_M
        && seg.segment_length_m <= INFERRED_GROUND_MAX_SEGMENT_M
        && seg.speed_kt >= INFERRED_GROUND_MIN_SPEED_KT
        && seg.speed_kt <= INFERRED_GROUND_MAX_SPEED_KT
        && seg.count_weight > 0.0
}

fn inferred_ground_cell(lat: f64, lon: f64) -> (i32, i32) {
    let cell_deg = INFERRED_GROUND_CELL_M / 111_320.0;
    (
        (lat / cell_deg).floor() as i32,
        (lon / cell_deg).floor() as i32,
    )
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

    // Jet-like profiles (B738, A320, A321, Widebody, BizJet, Generic).
    // Turboprop (4) and LightGA+Rotorcraft (6) may legitimately fly slow and low.
    let is_fixed_wing_jet = matches!(seg.profile_idx, 0 | 1 | 2 | 3 | 5 | 7);

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

    // After the 10 km extraction cap these long-segment guards fire only on
    // legacy pre-cap data. Kept as defence-in-depth; remove once all Arrow files
    // have been re-extracted.
    let length_m = seg.segment_length_m as f64;
    if length_m > 30_000.0 {
        let alt_at = |t: f64| sa + (ea - sa) * t;
        if alt_at(-0.5) < 0.0 || alt_at(1.5) < 0.0 {
            return false;
        }
        if start_agl < 2000.0 && end_agl < 2000.0 {
            return false;
        }
        if length_m > 100_000.0
            && start_agl.min(end_agl) < 1000.0
            && start_agl.max(end_agl) > 3000.0
        {
            return false;
        }
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

pub fn is_airport_context_candidate_raw(
    seg: &AircraftSegment,
    rasters: &dyn RasterSampler,
) -> bool {
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

fn airport_line_match_radius_m(line: &AirportLine) -> f64 {
    let width_half_m = if line.width_m > 0.0 {
        line.width_m as f64 * 0.5
    } else {
        default_airport_line_width_m(line.aeroway_type) * 0.5
    };
    width_half_m
        + match line.aeroway_type {
            AEROWAY_RUNWAY | AEROWAY_STOPWAY => 45.0,
            AEROWAY_TAXIWAY => 25.0,
            _ => 20.0,
        }
}

fn default_airport_line_width_m(aeroway_type: u8) -> f64 {
    match aeroway_type {
        AEROWAY_RUNWAY | AEROWAY_STOPWAY => 45.0,
        AEROWAY_TAXIWAY => 18.0,
        _ => 20.0,
    }
}

fn airport_area_contains_point(area: &AirportArea, lat: f64, lon: f64) -> bool {
    let centroid_dist_m = geo::flat_dist(lat, lon, area.centroid_lat, area.centroid_lon);
    if centroid_dist_m > airport_area_prune_radius_m(area) {
        return false;
    }
    if !area.polygon_wkb.is_empty() {
        return crate::wkb::wkb_contains_point(&area.polygon_wkb, lat, lon);
    }
    centroid_dist_m <= airport_area_fallback_radius_m(area)
}

fn airport_area_prune_radius_m(area: &AirportArea) -> f64 {
    airport_area_fallback_radius_m(area) * 3.0 + 150.0
}

fn airport_area_fallback_radius_m(area: &AirportArea) -> f64 {
    let area_radius = if area.area_m2 > 0.0 {
        (area.area_m2 as f64 / std::f64::consts::PI).sqrt()
    } else {
        0.0
    };
    let min_radius = match area.aeroway_type {
        AEROWAY_RUNWAY | AEROWAY_STOPWAY => 120.0,
        AEROWAY_TAXIWAY => 60.0,
        AEROWAY_APRON => 120.0,
        AEROWAY_HELIPAD => 25.0,
        AEROWAY_HELIPORT => 50.0,
        AEROWAY_AERODROME => 300.0,
        _ => 60.0,
    };
    area_radius.max(min_radius)
}

fn airport_match_cell(lat: f64, lon: f64) -> (i32, i32) {
    (
        (lat / AIRPORT_MATCH_CELL_DEG).floor() as i32,
        (lon / AIRPORT_MATCH_CELL_DEG).floor() as i32,
    )
}

fn meters_to_lat_deg(meters: f64) -> f64 {
    meters / 110_540.0
}

fn meters_to_lon_deg(lat: f64, meters: f64) -> f64 {
    let cos_lat = lat.to_radians().cos().abs().max(0.2);
    meters / (111_320.0 * cos_lat)
}

fn insert_bbox_cells(
    index: &mut HashMap<(i32, i32), Vec<usize>>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    item_idx: usize,
) {
    let y0 = (min_lat / AIRPORT_MATCH_CELL_DEG).floor() as i32;
    let y1 = (max_lat / AIRPORT_MATCH_CELL_DEG).floor() as i32;
    let x0 = (min_lon / AIRPORT_MATCH_CELL_DEG).floor() as i32;
    let x1 = (max_lon / AIRPORT_MATCH_CELL_DEG).floor() as i32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            index.entry((y, x)).or_default().push(item_idx);
        }
    }
}

#[derive(Clone, Copy)]
struct SurfaceEmitter {
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
    segment_length_m: f64,
    speed_kt: f32,
    ground_context: u8,
    ground_ops_kind: u8,
    weight: f64,
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

#[derive(Clone, Copy)]
struct SurfaceFlightObs {
    flight_id: u64,
    profile_idx: u8,
    period: u8,
    is_departure: bool,
    score: f64,
    has_ground_coverage: bool,
}

struct SurfaceGroup<'a> {
    name: String,
    airport_key: String,
    centroid_lat: f64,
    centroid_lon: f64,
    match_radius_m: f64,
    lines: Vec<&'a AirportLine>,
    areas: Vec<&'a AirportArea>,
}

#[derive(Debug, Clone)]
pub struct AirportGroundGroup {
    pub name: String,
    pub airport_key: String,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub match_radius_m: f64,
}

pub fn airport_ground_groups(
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
) -> Vec<AirportGroundGroup> {
    build_surface_groups(airport_lines, airport_areas)
        .into_iter()
        .map(|g| AirportGroundGroup {
            name: g.name,
            airport_key: g.airport_key,
            centroid_lat: g.centroid_lat,
            centroid_lon: g.centroid_lon,
            match_radius_m: g.match_radius_m,
        })
        .collect()
}

pub fn assign_segment_to_airport_group(
    seg: &AircraftSegment,
    groups: &[AirportGroundGroup],
    rasters: &dyn RasterSampler,
) -> Option<usize> {
    if groups.is_empty() {
        return None;
    }
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    let max_agl = start_agl.max(end_agl);
    if !seg.on_ground && !seg.surface_model && max_agl > SURFACE_TRAFFIC_MAX_AGL_M {
        return None;
    }
    let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
    let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
    let mut best_idx = None;
    let mut best_score = f64::MAX;
    for (idx, group) in groups.iter().enumerate() {
        let dist_m = geo::flat_dist(mid_lat, mid_lon, group.centroid_lat, group.centroid_lon);
        if dist_m > group.match_radius_m {
            continue;
        }
        let score = dist_m + max_agl.max(0.0) * 0.35;
        if score < best_score {
            best_score = score;
            best_idx = Some(idx);
        }
    }
    best_idx
}

pub fn synthesize_airport_surface_segments(
    aircraft: &[AircraftSegment],
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
    rasters: &dyn RasterSampler,
    _n_days: u16,
) -> Vec<AircraftSegment> {
    if aircraft.is_empty() || (airport_lines.is_empty() && airport_areas.is_empty()) {
        return Vec::new();
    }

    let groups = build_surface_groups(airport_lines, airport_areas);
    if groups.is_empty() {
        return Vec::new();
    }

    let mut group_obs: Vec<HashMap<u64, SurfaceFlightObs>> =
        (0..groups.len()).map(|_| HashMap::new()).collect();

    for seg in aircraft {
        if seg.surface_model {
            continue;
        }
        let (start_agl, end_agl) = segment_agl(seg, rasters);
        let max_agl = start_agl.max(end_agl);
        if !seg.on_ground && max_agl > SURFACE_TRAFFIC_MAX_AGL_M {
            continue;
        }

        let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
        let mut best_idx = None;
        let mut best_score = f64::MAX;

        for (idx, group) in groups.iter().enumerate() {
            let dist_m = geo::flat_dist(mid_lat, mid_lon, group.centroid_lat, group.centroid_lon);
            if dist_m > group.match_radius_m {
                continue;
            }
            let score = dist_m + max_agl.max(0.0) * 0.35;
            if score < best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }

        let Some(group_idx) = best_idx else {
            continue;
        };
        let covered = seg.on_ground || is_airport_ground_segment(seg, rasters);
        let entry = group_obs[group_idx]
            .entry(seg.flight_id)
            .or_insert(SurfaceFlightObs {
                flight_id: seg.flight_id,
                profile_idx: seg.profile_idx,
                period: seg.period.min(2),
                is_departure: seg.is_departure,
                score: best_score,
                has_ground_coverage: covered,
            });
        if best_score < entry.score {
            *entry = SurfaceFlightObs {
                flight_id: seg.flight_id,
                profile_idx: seg.profile_idx,
                period: seg.period.min(2),
                is_departure: seg.is_departure,
                score: best_score,
                has_ground_coverage: entry.has_ground_coverage || covered,
            };
        } else if covered {
            entry.has_ground_coverage = true;
        }
    }

    let mut next_flight_id = SURFACE_FLIGHT_ID_BASE;
    let mut out = Vec::new();

    for (group, obs_map) in groups.iter().zip(group_obs.iter()) {
        let observed = obs_map.len();
        if observed < SURFACE_MIN_OBSERVED_FLIGHTS {
            continue;
        }

        let covered = obs_map
            .values()
            .filter(|obs| obs.has_ground_coverage)
            .count();
        let missing_scale = (1.0 - covered as f64 / observed as f64).clamp(0.0, 1.0);
        if missing_scale <= 0.05 {
            continue;
        }

        let emitters = build_surface_emitters(group);
        if emitters.is_empty() {
            continue;
        }

        let mut buckets: HashMap<(u8, u8, bool), usize> = HashMap::new();
        let mut seen = HashSet::with_capacity(obs_map.len());
        for obs in obs_map.values() {
            if !seen.insert(obs.flight_id) {
                continue;
            }
            *buckets
                .entry((obs.period.min(2), obs.profile_idx.min(7), obs.is_departure))
                .or_default() += 1;
        }

        for ((period, profile_idx, is_departure), count) in buckets {
            let bucket_weight = count as f64 * missing_scale;
            if bucket_weight <= 0.0 {
                continue;
            }
            for emitter in &emitters {
                let count_weight = bucket_weight * emitter.weight;
                if count_weight < SURFACE_SYNTH_MIN_WEIGHT {
                    continue;
                }
                out.push(AircraftSegment {
                    flight_id: next_flight_id,
                    profile_idx,
                    is_departure,
                    on_ground: true,
                    period,
                    date_id: 0,
                    start_lat: emitter.start_lat,
                    start_lon: emitter.start_lon,
                    start_alt_m: 0.0,
                    end_lat: emitter.end_lat,
                    end_lon: emitter.end_lon,
                    end_alt_m: 0.0,
                    speed_kt: emitter.speed_kt,
                    segment_length_m: emitter.segment_length_m as f32,
                    count_weight: count_weight as f32,
                    surface_model: true,
                    ground_context: emitter.ground_context,
                    ground_ops_kind: emitter.ground_ops_kind,
                });
                next_flight_id = next_flight_id.wrapping_add(1);
            }
        }
    }

    out
}

fn build_surface_groups<'a>(
    airport_lines: &'a [AirportLine],
    airport_areas: &'a [AirportArea],
) -> Vec<SurfaceGroup<'a>> {
    #[derive(Default)]
    struct GroupAccum<'a> {
        name: String,
        airport_key: String,
        centroid_lat_sum: f64,
        centroid_lon_sum: f64,
        weight_sum: f64,
        lines: Vec<&'a AirportLine>,
        areas: Vec<&'a AirportArea>,
    }

    let mut groups: HashMap<String, GroupAccum<'a>> = HashMap::new();

    for line in airport_lines {
        let mid_lat = (line.start_lat + line.end_lat) * 0.5;
        let mid_lon = (line.start_lon + line.end_lon) * 0.5;
        let weight = line_length_weight(line);
        let key = if !line.airport_key.is_empty() {
            format!("id:{}", line.airport_key)
        } else {
            format!(
                "cluster:{:.3}:{:.3}",
                (mid_lat / 0.02).round(),
                (mid_lon / 0.03).round()
            )
        };
        let entry = groups.entry(key).or_default();
        if entry.name.is_empty() && !line.name.is_empty() {
            entry.name = line.name.clone();
        }
        if entry.airport_key.is_empty() && !line.airport_key.is_empty() {
            entry.airport_key = line.airport_key.clone();
        }
        entry.centroid_lat_sum += mid_lat * weight;
        entry.centroid_lon_sum += mid_lon * weight;
        entry.weight_sum += weight;
        entry.lines.push(line);
    }

    for area in airport_areas {
        let weight = area_weight_measure(area);
        let key = if !area.airport_key.is_empty() {
            format!("id:{}", area.airport_key)
        } else {
            format!(
                "cluster:{:.3}:{:.3}",
                (area.centroid_lat / 0.02).round(),
                (area.centroid_lon / 0.03).round()
            )
        };
        let entry = groups.entry(key).or_default();
        if entry.name.is_empty() && !area.name.is_empty() {
            entry.name = area.name.clone();
        }
        if entry.airport_key.is_empty() && !area.airport_key.is_empty() {
            entry.airport_key = area.airport_key.clone();
        }
        entry.centroid_lat_sum += area.centroid_lat * weight;
        entry.centroid_lon_sum += area.centroid_lon * weight;
        entry.weight_sum += weight;
        entry.areas.push(area);
    }

    let mut out = Vec::with_capacity(groups.len());
    for (_key, group) in groups {
        if group.weight_sum <= 0.0 {
            continue;
        }
        let centroid_lat = group.centroid_lat_sum / group.weight_sum;
        let centroid_lon = group.centroid_lon_sum / group.weight_sum;
        let mut extent_m = 0.0f64;
        for line in &group.lines {
            let mid_lat = (line.start_lat + line.end_lat) * 0.5;
            let mid_lon = (line.start_lon + line.end_lon) * 0.5;
            extent_m = extent_m.max(geo::flat_dist(mid_lat, mid_lon, centroid_lat, centroid_lon));
        }
        for area in &group.areas {
            extent_m = extent_m.max(geo::flat_dist(
                area.centroid_lat,
                area.centroid_lon,
                centroid_lat,
                centroid_lon,
            ));
        }
        out.push(SurfaceGroup {
            name: group.name,
            airport_key: group.airport_key,
            centroid_lat,
            centroid_lon,
            match_radius_m: SURFACE_TRAFFIC_RADIUS_M + extent_m,
            lines: group.lines,
            areas: group.areas,
        });
    }

    out.sort_by(|a, b| a.airport_key.cmp(&b.airport_key).then(a.name.cmp(&b.name)));
    out
}

fn build_surface_emitters(group: &SurfaceGroup<'_>) -> Vec<SurfaceEmitter> {
    let runway_lines: Vec<&AirportLine> = group
        .lines
        .iter()
        .copied()
        .filter(|line| matches!(line.aeroway_type, AEROWAY_RUNWAY | AEROWAY_STOPWAY))
        .collect();
    let taxi_lines: Vec<&AirportLine> = group
        .lines
        .iter()
        .copied()
        .filter(|line| line.aeroway_type == AEROWAY_TAXIWAY)
        .collect();
    let apron_areas: Vec<&AirportArea> = group
        .areas
        .iter()
        .copied()
        .filter(|area| {
            matches!(
                area.aeroway_type,
                AEROWAY_APRON | AEROWAY_HELIPAD | AEROWAY_HELIPORT
            )
        })
        .collect();

    let mut categories = Vec::new();
    if !runway_lines.is_empty() {
        categories.push((
            SURFACE_RUNWAY_SHARE,
            build_line_emitters(&runway_lines, SURFACE_RUNWAY_SPEED_KT),
        ));
    }
    if !taxi_lines.is_empty() {
        categories.push((
            SURFACE_TAXIWAY_SHARE,
            build_line_emitters(&taxi_lines, SURFACE_TAXIWAY_SPEED_KT),
        ));
    }
    if !apron_areas.is_empty() {
        categories.push((SURFACE_APRON_SHARE, build_area_emitters(&apron_areas)));
    }
    if categories.is_empty() {
        return Vec::new();
    }

    let total_share: f64 = categories.iter().map(|(share, _)| *share).sum();
    let mut out = Vec::new();
    for (share, mut emitters) in categories {
        let category_share = share / total_share.max(1e-6);
        let weight_sum: f64 = emitters.iter().map(|e| e.weight.max(0.0)).sum();
        if weight_sum <= 0.0 {
            continue;
        }
        for emitter in &mut emitters {
            emitter.weight = category_share * emitter.weight / weight_sum;
        }
        out.extend(emitters);
    }
    out
}

fn build_line_emitters(lines: &[&AirportLine], speed_kt: f32) -> Vec<SurfaceEmitter> {
    lines
        .iter()
        .map(|line| {
            let segment_length_m =
                geo::flat_dist(line.start_lat, line.start_lon, line.end_lat, line.end_lon)
                    .max(10.0);
            SurfaceEmitter {
                start_lat: line.start_lat,
                start_lon: line.start_lon,
                end_lat: line.end_lat,
                end_lon: line.end_lon,
                segment_length_m,
                speed_kt,
                ground_context: GROUND_CONTEXT_AIRPORT_LINE,
                ground_ops_kind: ground_ops_kind_from_aeroway_type(line.aeroway_type),
                weight: line_length_weight(line),
            }
        })
        .collect()
}

fn build_area_emitters(areas: &[&AirportArea]) -> Vec<SurfaceEmitter> {
    let mut emitters = Vec::new();
    for area in areas {
        let speed_kt = if matches!(area.aeroway_type, AEROWAY_HELIPAD | AEROWAY_HELIPORT) {
            SURFACE_HELIPAD_SPEED_KT
        } else {
            SURFACE_APRON_SPEED_KT
        };
        let points = surface_area_points(area);
        if points.is_empty() {
            continue;
        }
        let point_weight = area_weight_measure(area) / points.len() as f64;
        for (lat, lon) in points {
            let lon_off = meters_to_lon_deg(lat, SURFACE_POINT_SEGMENT_M * 0.5);
            let segment_length_m = geo::flat_dist(lat, lon - lon_off, lat, lon + lon_off).max(10.0);
            emitters.push(SurfaceEmitter {
                start_lat: lat,
                start_lon: lon - lon_off,
                end_lat: lat,
                end_lon: lon + lon_off,
                segment_length_m,
                speed_kt,
                ground_context: GROUND_CONTEXT_AIRPORT_AREA,
                ground_ops_kind: ground_ops_kind_from_aeroway_type(area.aeroway_type),
                weight: point_weight,
            });
        }
    }
    emitters
}

fn surface_area_points(area: &AirportArea) -> Vec<(f64, f64)> {
    if !area.polygon_wkb.is_empty() {
        let mut points =
            crate::wkb::wkb_grid_points(&area.polygon_wkb, SURFACE_AREA_POINT_SPACING_M);
        if points.len() > SURFACE_AREA_POINT_MAX {
            let step = points.len() as f64 / SURFACE_AREA_POINT_MAX as f64;
            let mut sampled = Vec::with_capacity(SURFACE_AREA_POINT_MAX);
            let mut cursor = 0.0f64;
            while sampled.len() < SURFACE_AREA_POINT_MAX {
                let idx = cursor.floor() as usize;
                if let Some(pt) = points.get(idx) {
                    sampled.push(*pt);
                }
                cursor += step;
            }
            points = sampled;
        }
        if !points.is_empty() {
            return points;
        }
    }
    vec![(area.centroid_lat, area.centroid_lon)]
}

fn line_length_weight(line: &AirportLine) -> f64 {
    geo::flat_dist(line.start_lat, line.start_lon, line.end_lat, line.end_lon).max(30.0)
}

fn area_weight_measure(area: &AirportArea) -> f64 {
    if area.area_m2 > 0.0 {
        area.area_m2 as f64
    } else {
        5_000.0
    }
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
    let pidx = seg.profile_idx.min(7) as usize;
    let mut ref_sel_db = GROUND_OPS_REFERENCE_SEL_DB[pidx][kind_idx];
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
pub fn segment_sel(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
) -> Option<(f64, CpaResult)> {
    segment_sel_with_overrides(
        seg,
        rx_lat,
        rx_lon,
        rx_elev_m,
        seg.start_alt_m as f64,
        seg.end_alt_m as f64,
        false,
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
    segment_sel_with_overrides(seg, rx_lat, rx_lon, rx_elev_m, start_alt_m, end_alt_m, true)
}

fn segment_sel_with_overrides(
    seg: &AircraftSegment,
    rx_lat: f64,
    rx_lon: f64,
    rx_elev_m: f64,
    start_alt_m: f64,
    end_alt_m: f64,
    airport_ground_mode: bool,
) -> Option<(f64, CpaResult)> {
    let profile = &PROFILES[seg.profile_idx.min(7) as usize];

    let cpa = compute_cpa(
        rx_lat,
        rx_lon,
        rx_elev_m,
        seg.start_lat,
        seg.start_lon,
        start_alt_m,
        seg.end_lat,
        seg.end_lon,
        end_alt_m,
    );

    // Skip beyond per-profile NPD reach. Replaces the old fixed 14 km cutoff
    // with profile-aware distance: LightGA ~6 km, jets capped at 10 km.
    if cpa.d_p_m > profile.estimate_reach_m(AIRCRAFT_NPD_REACH_THRESHOLD_DB, seg.is_departure) {
        return None;
    }

    // NPD lookup
    let sel_npd = interpolate_sel(profile, cpa.d_p_m * FT_PER_M, seg.is_departure);

    // Corrections
    let dv = delta_v(seg.speed_kt as f64, profile);
    let df = delta_f(cpa.q_m, cpa.seg_len_m, profile.d_bar_m);

    // Lateral attenuation applied to all profiles including profile 6 (LightGA+Rotorcraft).
    // WHY: Profile 6 is a mixed bucket (C172, PA28 + helicopters). Old code skipped lateral
    // attenuation for ALL profile 6, overestimating fixed-wing GA noise by up to 10.9 dB.
    // Helicopters technically don't have lateral attenuation, but they're ~10% of profile 6.
    let lambda = if airport_ground_mode {
        0.0
    } else {
        lateral_attenuation(cpa.beta_deg, cpa.lateral_m)
    };

    let di = delta_i(cpa.beta_deg, profile.installation);

    // Master equation (Eq. 4-8b)
    let sel = sel_npd + dv + di - lambda + df;

    if sel < 20.0 {
        return None;
    }
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
        };
        let result = segment_sel(&seg, 50.005, 14.005, 300.0);
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
        };
        let result = segment_sel(&seg, 50.0, 14.0, 300.0);
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
        fn vegetation_depth(&self, _lat1: f64, _lon1: f64, _lat2: f64, _lon2: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn ground_g_path(&self, _lat1: f64, _lon1: f64, _lat2: f64, _lon2: f64) -> f64 {
            0.0
        }
        fn terrain_profile(
            &self,
            _lat1: f64,
            _lon1: f64,
            _lat2: f64,
            _lon2: f64,
            _steps: usize,
        ) -> Vec<f64> {
            vec![]
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
    fn test_airport_runway_context_keeps_ground_segment() {
        let mut seg = AircraftSegment {
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
        };
        let airport_lines = vec![AirportLine {
            osm_id: 1,
            aeroway_type: AEROWAY_RUNWAY,
            start_lat: 49.999,
            start_lon: 14.0,
            end_lat: 50.002,
            end_lon: 14.0,
            width_m: 45.0,
            name: String::new(),
            airport_key: String::new(),
        }];
        seg.ground_context = segment_ground_context(&seg, &airport_lines, &[]);
        assert_eq!(seg.ground_context, GROUND_CONTEXT_AIRPORT_LINE);
        assert!(!is_ground_stale_segment(&seg, &FlatGround));
    }

    #[test]
    fn test_airport_area_context_keeps_ground_segment() {
        let mut seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0001,
            start_lon: 14.0001,
            start_alt_m: 252.0,
            end_lat: 50.0002,
            end_lon: 14.0002,
            end_alt_m: 253.0,
            speed_kt: 20.0,
            segment_length_m: 20.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
        };
        let airport_areas = vec![AirportArea {
            osm_id: 2,
            aeroway_type: AEROWAY_HELIPAD,
            centroid_lat: 50.00015,
            centroid_lon: 14.00015,
            polygon_wkb: String::new(),
            area_m2: 400.0,
            name: String::new(),
            airport_key: String::new(),
        }];
        seg.ground_context = segment_ground_context(&seg, &[], &airport_areas);
        assert_eq!(seg.ground_context, GROUND_CONTEXT_AIRPORT_AREA);
        assert!(!is_ground_stale_segment(&seg, &FlatGround));
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
        };
        assert!(!is_airport_ground_segment(&off_airport, &FlatGround));

        let airport_ground = AircraftSegment {
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ..off_airport
        };
        assert!(is_airport_ground_segment(&airport_ground, &FlatGround));
        assert!(is_airport_context_candidate_raw(
            &airport_ground,
            &FlatGround
        ));
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
        };

        let normal = segment_sel(&seg, 50.0004, 14.0, 254.0)
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
        let mut seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 6,
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
        };

        let runway_arr = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_arr.ref_sel_db - 92.0).abs() < 0.01);
        assert_eq!(runway_arr.max_radius_m, 5_000.0);

        seg.is_departure = true;
        let runway_dep = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_dep.ref_sel_db - 94.0).abs() < 0.01);

        seg.speed_kt = SURFACE_TAXIWAY_SPEED_KT;
        let taxi = ground_ops_model(&seg, GROUND_OPS_KIND_TAXI);
        assert!((taxi.ref_sel_db - 82.0).abs() < 0.01);
        assert_eq!(taxi.max_radius_m, 3_000.0);

        seg.speed_kt = SURFACE_APRON_SPEED_KT;
        let apron = ground_ops_model(&seg, GROUND_OPS_KIND_APRON_MOVEMENT);
        assert!((apron.ref_sel_db - 76.0).abs() < 0.01);
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
        };
        let rasters = FlatGround;
        let model = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        let rx_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let rx_lon = seg.start_lon + meters_to_lon_deg(rx_lat, 5.0);
        let rx_alt = default_receiver_altitude_m(rasters.elevation(rx_lat, rx_lon));
        let doc29_sel = segment_sel_airport_ground(&seg, rx_lat, rx_lon, rx_alt, &rasters)
            .expect("Doc 29 runway reference SEL should compute")
            .0;

        assert!(
            model.ref_sel_db + 8.0 < doc29_sel,
            "ground model should stay well below near-field airborne extrapolation, model={:.2} doc29_near={:.2}",
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
        };
        let slow_seg = AircraftSegment {
            speed_kt: 1.5,
            ..fast_seg
        };

        let fast = ground_ops_model(&fast_seg, GROUND_OPS_KIND_TAXI);
        let slow = ground_ops_model(&slow_seg, GROUND_OPS_KIND_TAXI);

        assert!((fast.ref_sel_db - (82.0 + GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
        assert!((slow.ref_sel_db - (82.0 - GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
    }

    fn test_seg(
        flight_id: u64,
        date_id: i16,
        start_lat: f64,
        start_lon: f64,
        end_lat: f64,
        end_lon: f64,
    ) -> AircraftSegment {
        AircraftSegment {
            flight_id,
            profile_idx: 7,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id,
            start_lat,
            start_lon,
            start_alt_m: 0.0,
            end_lat,
            end_lon,
            end_alt_m: 0.0,
            speed_kt: 24.0,
            segment_length_m: 260.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
        }
    }

    #[test]
    fn test_infer_repeated_ground_context_marks_multi_day_cluster() {
        let mut segments = vec![
            test_seg(1, 10, 50.0000, 14.0000, 50.0015, 14.0000),
            test_seg(2, 11, 50.0001, 14.0004, 50.0016, 14.0004),
            test_seg(3, 12, 50.0002, 14.0008, 50.0017, 14.0008),
            test_seg(4, 13, 50.0003, 14.0012, 50.0018, 14.0012),
            test_seg(5, 10, 50.0004, 14.0016, 50.0019, 14.0016),
            test_seg(6, 11, 50.0005, 14.0020, 50.0020, 14.0020),
            test_seg(7, 12, 50.0006, 14.0024, 50.0021, 14.0024),
            test_seg(8, 13, 50.0007, 14.0028, 50.0022, 14.0028),
        ];

        let inferred = infer_repeated_ground_context(&mut segments, 365);
        assert_eq!(inferred, segments.len());
        assert!(segments
            .iter()
            .all(|seg| seg.ground_context == GROUND_CONTEXT_INFERRED));
        assert!(segments.iter().all(|seg| !is_ground_stale_segment(seg, &FlatGround)));
    }

    #[test]
    fn test_infer_repeated_ground_context_rejects_single_day_strip() {
        let mut segments = vec![
            test_seg(1, 10, 50.0000, 14.0000, 50.0015, 14.0000),
            test_seg(2, 10, 50.0002, 14.0003, 50.0017, 14.0003),
            test_seg(3, 10, 50.0004, 14.0006, 50.0019, 14.0006),
            test_seg(4, 10, 50.0006, 14.0009, 50.0021, 14.0009),
            test_seg(5, 10, 50.0008, 14.0012, 50.0023, 14.0012),
            test_seg(6, 10, 50.0010, 14.0015, 50.0025, 14.0015),
            test_seg(7, 10, 50.0012, 14.0018, 50.0027, 14.0018),
            test_seg(8, 10, 50.0014, 14.0021, 50.0029, 14.0021),
        ];

        let inferred = infer_repeated_ground_context(&mut segments, 365);
        assert_eq!(inferred, 0);
        assert!(segments
            .iter()
            .all(|seg| seg.ground_context == GROUND_CONTEXT_NONE));
    }

    // ── estimate_reach_m ──

    #[test]
    fn test_estimate_reach_lightga_shorter_than_jets() {
        let lightga = PROFILES[6].estimate_reach_m(40.0, false);
        let b738 = PROFILES[0].estimate_reach_m(40.0, false);
        assert!(
            lightga < b738,
            "LightGA reach ({lightga:.0}) should be shorter than B738 ({b738:.0})"
        );
        assert!(lightga > 5_000.0 && lightga < 8_000.0,
            "LightGA approach reach at 40dB should be ~6km, got {lightga:.0}");
    }

    #[test]
    fn test_estimate_reach_jets_hit_cap() {
        for i in 0..5 {
            let reach = PROFILES[i].estimate_reach_m(40.0, false);
            assert!(
                (reach - AIRCRAFT_NPD_REACH_CAP_M).abs() < 1.0,
                "Profile {} approach should hit cap, got {reach:.0}",
                PROFILES[i].name
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
}
