//! Per-segment per-movement **Z-weighted band SEL@25m** kernel for
//! the `airport_traffic.arrow` writer + popup consumer.
//!
//! Returns the Z-weighted (un-A-weighted) band SEL at 25 m perpendicular
//! distance, in **linear units** (10^(dB/10)), for ONE MOVEMENT through
//! ONE OSM microsegment. The Stage 2C writer accumulates these per
//! event into `band_energy_lin` so each stored row holds the **raw Σ
//! over n_days** for that microsegment + period (v6 convention —
//! matches airborne/cruise/airport_summary "raw in extract, consumer
//! divides"). The popup multiplies by per-band propagation
//! attenuation, adds `A_WEIGHTING[i]`, and divides by
//! `n_days × period_s` (via `period_leq`) to get the period Leq.
//! Storing A-weighted at source would double-count the A-weight across
//! frequency-dependent propagation.
//!
//! ## Receiver contract
//!
//! ```text
//! received_z_lin[i] = sum_over_rows(
//!     row.band_energy_lin[i] × prop_rel_band[i]            // raw Σ over n_days
//! )
//! received_a_lin[i] = received_z_lin[i] × 10^(A_WEIGHTING[i] / 10)
//! leq_period_db = 10 · log10(sum_i(received_a_lin[i]) / (n_days × period_seconds))
//! ```
//!
//! Day/eve/night penalties (+5, +10 dB for Lden) applied per-row by
//! `row.period`. `prop_rel_band[i]` is RELATIVE attenuation from the
//! 25 m reference (per-band geo divergence + atm absorption + ground +
//! barrier), NOT absolute path loss — using absolute would double-count
//! the 25 m reference loss.
//!
//! ## Aircraft vs GSE math
//!
//! - **Aircraft**: per-event `GROUND_OPS_REFERENCE_SEL_DB[class][kind]`
//!   spread across microsegments via `× seg_length / NOMINAL_EVENT_LENGTH_M`
//!   (fixed 1 km nominal). Speed adjust ±3 dB clamp + 2 dB departure
//!   bonus.
//! - **GSE**: kinematic moving-point integration of per-band Lw along
//!   the segment at perpendicular distance 25 m. One closed-form
//!   integral replaces stationary-Lp + duration + finite-line correction
//!   (3 terms) per Occam. The integral asymptotes via `atan → π/2`, so
//!   relative to a stationary-Lp+duration approximation it gives LESS
//!   energy at long segments (-5.6 dB at L=250 m, -11.2 dB at L=1 km).

use crate::propagation::geo::finite_line_correction;
use crate::types::NUM_BANDS;

use super::aircraft::{
    GROUND_OPS_APRON_SPECTRUM_SHAPE, GROUND_OPS_KIND_APRON_MOVEMENT,
    GROUND_OPS_KIND_RUNWAY_ROLL, GROUND_OPS_KIND_TAXI, GROUND_OPS_NOMINAL_EVENT_LENGTH_M,
    GROUND_OPS_REF_OFFSET_M, GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB,
    GROUND_OPS_RUNWAY_SPECTRUM_SHAPE, GROUND_OPS_SPEED_CLAMP_DB, GROUND_OPS_TAXI_SPECTRUM_SHAPE,
    SURFACE_APRON_SPEED_KT, SURFACE_RUNWAY_SPEED_KT, SURFACE_TAXIWAY_SPEED_KT,
};
use super::gse::GSE_LW_BANDS_DB;
use super::profiles_generated::GROUND_OPS_REFERENCE_SEL_DB;

const KT_TO_M_S: f64 = 0.514_444_44;

/// Per-segment per-movement Z-weighted band SEL@25m, linear units.
///
/// Returns `[0; 8]` for degenerate input (segment_length ≤ 0,
/// leg_avg_speed ≤ 0). Panics on unknown `veh_kind` or `ops_kind`.
pub fn compute_band_energy_lin(
    veh_kind: u8,
    class_idx: u8,
    ops_kind: u8,
    is_departure: u8,
    leg_avg_speed_kt: f32,
    segment_length_m: f32,
) -> [f32; NUM_BANDS] {
    if !(segment_length_m > 0.0 && leg_avg_speed_kt > 0.0) {
        return [0.0; NUM_BANDS];
    }
    let bands_db = compute_band_sel_25m_z_db(
        veh_kind,
        class_idx,
        ops_kind,
        is_departure,
        leg_avg_speed_kt,
        segment_length_m,
    );
    let mut bands = [0.0f32; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = 10f64.powf(bands_db[i] / 10.0) as f32;
    }
    bands
}

/// dB variant of [`compute_band_energy_lin`]. `pub(crate)` because the
/// on-disk writer contract is the linear form.
pub(crate) fn compute_band_sel_25m_z_db(
    veh_kind: u8,
    class_idx: u8,
    ops_kind: u8,
    is_departure: u8,
    leg_avg_speed_kt: f32,
    segment_length_m: f32,
) -> [f64; NUM_BANDS] {
    // Validate ops_kind for both branches — the aircraft branch checks
    // via `ops_kind_idx` but the GSE branch doesn't read ops_kind at
    // all, so an invalid value would silently pass through without
    // this guard.
    let _ = ops_kind_idx(ops_kind);
    match veh_kind {
        0 => aircraft_band_sel_z_db(class_idx, ops_kind, is_departure, leg_avg_speed_kt, segment_length_m),
        1 => gse_band_sel_z_db(class_idx, leg_avg_speed_kt, segment_length_m),
        other => panic!(
            "airport_traffic: veh_kind must be 0 (aircraft) or 1 (GSE), got {other}"
        ),
    }
}

/// Aircraft: anchor SEL × (seg_length / nominal_event_length) spread
/// by Z-weighted spectrum shape. Speed adjust + departure bonus +
/// finite-line correction at 25 m preserved.
fn aircraft_band_sel_z_db(
    class_idx: u8,
    ops_kind: u8,
    is_departure: u8,
    speed_kt: f32,
    segment_length_m: f32,
) -> [f64; NUM_BANDS] {
    let kind_idx = ops_kind_idx(ops_kind);
    assert!(
        (class_idx as usize) < GROUND_OPS_REFERENCE_SEL_DB.len(),
        "class_idx {class_idx} out of range for {} aircraft classes",
        GROUND_OPS_REFERENCE_SEL_DB.len()
    );
    let mut total_sel = GROUND_OPS_REFERENCE_SEL_DB[class_idx as usize][kind_idx];
    if ops_kind == GROUND_OPS_KIND_RUNWAY_ROLL && is_departure == 1 {
        total_sel += GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB;
    }
    let nominal = match ops_kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => SURFACE_RUNWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_TAXI => SURFACE_TAXIWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_APRON_MOVEMENT => SURFACE_APRON_SPEED_KT as f64,
        _ => unreachable!(),
    };
    if speed_kt > 1.0 {
        let adj = 10.0 * ((speed_kt as f64) / nominal.max(1.0)).log10();
        total_sel += adj.clamp(-GROUND_OPS_SPEED_CLAMP_DB, GROUND_OPS_SPEED_CLAMP_DB);
    }
    // Per-microsegment splitting: spread the per-event anchor SEL
    // across microsegments by length ratio. Equivalent to assuming
    // a 1 km nominal event traversed uniformly.
    total_sel += 10.0 * ((segment_length_m as f64) / GROUND_OPS_NOMINAL_EVENT_LENGTH_M).log10();
    // Finite-line correction at the 25 m reference perpendicular,
    // segment center. FLC ≤ 0. fraction=0.5 by construction: the
    // notional receiver sits at the perpendicular foot of the segment
    // midpoint, not at an arbitrary along-segment position.
    total_sel += finite_line_correction(segment_length_m as f64, GROUND_OPS_REF_OFFSET_M, 0.5);

    let shape = match ops_kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => GROUND_OPS_RUNWAY_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_TAXI => GROUND_OPS_TAXI_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_APRON_MOVEMENT => GROUND_OPS_APRON_SPECTRUM_SHAPE,
        _ => unreachable!(),
    };
    // Normalize raw Z-weighted shape so per-band sum equals total_sel.
    let shape_z_sum_db = 10.0
        * shape
            .iter()
            .map(|s| 10f64.powf(s / 10.0))
            .sum::<f64>()
            .log10();
    let c = total_sel - shape_z_sum_db;
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = c + shape[i];
    }
    bands
}

/// GSE: kinematic moving-point integration along the segment at
/// perpendicular distance 25 m. One closed-form integral handles the
/// time-at-segment, the source receding from the perpendicular foot,
/// and the finite-line geometry — no separate FLC or duration term.
///
/// `SEL_band_z = Lw_band_z + 10·log10(atan(L/(2r)) / (2π·v·r))`
///
/// where r = 25 m. For L → 0, atan(0) → 0, SEL → −∞ → caller
/// short-circuits to zeros via the degenerate guard.
fn gse_band_sel_z_db(
    class_idx: u8,
    leg_avg_speed_kt: f32,
    segment_length_m: f32,
) -> [f64; NUM_BANDS] {
    let speed_m_s = leg_avg_speed_kt as f64 * KT_TO_M_S;
    let r = GROUND_OPS_REF_OFFSET_M;
    let l = segment_length_m as f64;
    // Kinematic integral: E = Lw_lin · atan(L/(2r)) / (2π·v·r)
    let angle = (l / (2.0 * r)).atan();
    let geo_offset_db = 10.0 * (angle / (2.0 * std::f64::consts::PI * speed_m_s * r)).log10();
    assert!(
        (class_idx as usize) < GSE_LW_BANDS_DB.len(),
        "gse_class {class_idx} out of range for {} GSE classes",
        GSE_LW_BANDS_DB.len()
    );
    let lw_bands = &GSE_LW_BANDS_DB[class_idx as usize];
    let mut bands = [0.0f64; NUM_BANDS];
    for i in 0..NUM_BANDS {
        bands[i] = lw_bands[i] + geo_offset_db;
    }
    bands
}

fn ops_kind_idx(ops_kind: u8) -> usize {
    match ops_kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => 0,
        GROUND_OPS_KIND_TAXI => 1,
        GROUND_OPS_KIND_APRON_MOVEMENT => 2,
        other => panic!(
            "airport_traffic: ops_kind must be RUNWAY_ROLL/TAXI/APRON_MOVEMENT (1/2/3), got {other}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::A_WEIGHTING;
    use crate::emission::gse::{GSE_CLASS_HEAVY, GSE_CLASS_LIGHT, GSE_CLASS_MEDIUM};

    fn sum_z_band_levels_db(bands: &[f64; NUM_BANDS]) -> f64 {
        let lin: f64 = bands.iter().map(|b| 10f64.powf(b / 10.0)).sum();
        10.0 * lin.log10()
    }

    fn sum_a_weighted_band_levels_db(bands: &[f64; NUM_BANDS]) -> f64 {
        let lin: f64 = bands
            .iter()
            .zip(A_WEIGHTING.iter())
            .map(|(b, aw)| 10f64.powf((b + aw) / 10.0))
            .sum();
        10.0 * lin.log10()
    }

    #[test]
    fn aircraft_full_nominal_event_recovers_anchor_sel() {
        // A 1 km taxi event at nominal 18 kt: per-microsegment SEL
        // sums (in Z-band linear space) to the anchor SEL for that class.
        let bands =
            compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, GROUND_OPS_NOMINAL_EVENT_LENGTH_M as f32);
        let z_total = sum_z_band_levels_db(&bands);
        let anchor = GROUND_OPS_REFERENCE_SEL_DB[2][1];
        let flc = finite_line_correction(GROUND_OPS_NOMINAL_EVENT_LENGTH_M, GROUND_OPS_REF_OFFSET_M, 0.5);
        let expected = anchor + flc;
        assert!(
            (z_total - expected).abs() < 0.1,
            "z-total {z_total} ≠ anchor+flc {expected}"
        );
    }

    #[test]
    fn aircraft_short_segment_under_full_event() {
        // Same B738 taxi for a 50 m microsegment (1/20 of nominal event).
        // Per-seg SEL = anchor + 10·log10(0.05) ≈ anchor - 13 dB.
        let bands = compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 50.0);
        let z_total = sum_z_band_levels_db(&bands);
        let anchor = GROUND_OPS_REFERENCE_SEL_DB[2][1];
        let expected = anchor + 10.0 * 0.05f64.log10()
            + finite_line_correction(50.0, GROUND_OPS_REF_OFFSET_M, 0.5);
        assert!(
            (z_total - expected).abs() < 0.5,
            "50m seg z-total {z_total} ≠ {expected}"
        );
    }

    #[test]
    fn aircraft_runway_departure_gets_2_db_bonus() {
        let arr =
            compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_RUNWAY_ROLL, 0, 70.0, 250.0);
        let dep =
            compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_RUNWAY_ROLL, 1, 70.0, 250.0);
        let delta = sum_z_band_levels_db(&dep) - sum_z_band_levels_db(&arr);
        assert!(
            (delta - 2.0).abs() < 0.1,
            "departure bonus expected +2 dB, got {delta}"
        );
    }

    #[test]
    fn aircraft_speed_clamp_caps_adjustment_at_3_db() {
        let nominal = compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
        let speedy = compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 100.0, 250.0);
        let delta = sum_z_band_levels_db(&speedy) - sum_z_band_levels_db(&nominal);
        assert!(
            (delta - 3.0).abs() < 0.1,
            "speed clamp should give +3 dB, got {delta}"
        );
    }

    #[test]
    fn gse_kinematic_integral_short_segment() {
        // L = 50 m, v = 5 m/s, r = 25 → atan(1) = π/4 = 0.785,
        // 2π·v·r = 785. geo_offset = 10·log10(0.785/785) = -30 dB.
        let bands =
            compute_band_sel_25m_z_db(1, GSE_CLASS_HEAVY, GROUND_OPS_KIND_TAXI, 0, 9.72, 50.0);
        let z_total = sum_z_band_levels_db(&bands);
        let lw_total = sum_z_band_levels_db(&GSE_LW_BANDS_DB[GSE_CLASS_HEAVY as usize]);
        let delta = z_total - lw_total;
        assert!(
            (delta + 30.0).abs() < 1.0,
            "expected geo offset ≈ -30 dB, got Δ={delta}"
        );
    }

    #[test]
    fn gse_class_ordering_light_lt_medium_lt_heavy() {
        let total = |cls: u8| {
            sum_z_band_levels_db(&compute_band_sel_25m_z_db(
                1,
                cls,
                GROUND_OPS_KIND_TAXI,
                0,
                9.72,
                250.0,
            ))
        };
        let light = total(GSE_CLASS_LIGHT);
        let medium = total(GSE_CLASS_MEDIUM);
        let heavy = total(GSE_CLASS_HEAVY);
        assert!(light < medium, "LIGHT={light} not < MEDIUM={medium}");
        assert!(medium < heavy, "MEDIUM={medium} not < HEAVY={heavy}");
    }

    #[test]
    fn gse_longer_segment_higher_sel() {
        // Kinematic integral grows with L (more source-time near
        // perpendicular foot) → per-movement SEL should increase.
        let short = sum_z_band_levels_db(&compute_band_sel_25m_z_db(
            1, GSE_CLASS_MEDIUM, GROUND_OPS_KIND_TAXI, 0, 9.72, 50.0,
        ));
        let long = sum_z_band_levels_db(&compute_band_sel_25m_z_db(
            1, GSE_CLASS_MEDIUM, GROUND_OPS_KIND_TAXI, 0, 9.72, 250.0,
        ));
        assert!(
            long > short,
            "longer GSE seg should give more energy; short={short} long={long}"
        );
    }

    #[test]
    fn gse_no_aircraft_speed_clamp_faster_means_quieter() {
        // Kinematic: SEL ∝ 1/v → faster vehicle gives less per-pass
        // SEL (shorter time near receiver). No 3-dB clamp.
        let slow = sum_z_band_levels_db(&compute_band_sel_25m_z_db(
            1, GSE_CLASS_MEDIUM, GROUND_OPS_KIND_TAXI, 0, 5.0, 250.0,
        ));
        let fast = sum_z_band_levels_db(&compute_band_sel_25m_z_db(
            1, GSE_CLASS_MEDIUM, GROUND_OPS_KIND_TAXI, 0, 50.0, 250.0,
        ));
        let delta_db_expected = 10.0 * (5.0_f64 / 50.0).log10(); // -10 dB
        let actual = fast - slow;
        assert!(
            (actual - delta_db_expected).abs() < 0.5,
            "expected 10·log10(v_slow/v_fast)=−10 dB delta, got {actual}"
        );
    }

    #[test]
    fn linear_form_matches_db_conversion() {
        let bands_db = compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
        let bands_lin = compute_band_energy_lin(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
        for i in 0..NUM_BANDS {
            let expected = 10f64.powf(bands_db[i] / 10.0) as f32;
            assert!(
                (bands_lin[i] - expected).abs() / expected.max(1e-6) < 1e-5,
                "band {i}: lin={} vs expected={}",
                bands_lin[i],
                expected
            );
        }
    }

    #[test]
    fn degenerate_zero_length_returns_all_zeros() {
        let bands = compute_band_energy_lin(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 0.0);
        assert_eq!(bands, [0.0; NUM_BANDS]);
        let bands = compute_band_energy_lin(1, GSE_CLASS_MEDIUM, GROUND_OPS_KIND_TAXI, 0, 18.0, 0.0);
        assert_eq!(bands, [0.0; NUM_BANDS]);
    }

    #[test]
    fn degenerate_zero_speed_returns_all_zeros() {
        let bands = compute_band_energy_lin(0, 2, GROUND_OPS_KIND_TAXI, 0, 0.0, 250.0);
        assert_eq!(bands, [0.0; NUM_BANDS]);
    }

    #[test]
    fn a_weighted_total_lower_than_z_total_for_aircraft() {
        // Sanity: A-weighting subtracts ~25 dB from 63 Hz and adds ~1 dB
        // to 2 kHz. For aircraft taxi spectrum (peak at 63 Hz),
        // A-weighted total is lower than Z-weighted by several dB.
        let bands = compute_band_sel_25m_z_db(0, 2, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
        let z = sum_z_band_levels_db(&bands);
        let a = sum_a_weighted_band_levels_db(&bands);
        assert!(a < z, "A-weighted total ({a}) must be < Z-weighted total ({z})");
    }

    #[test]
    #[should_panic(expected = "veh_kind must be 0")]
    fn unknown_veh_kind_panics() {
        let _ = compute_band_sel_25m_z_db(2, 0, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
    }

    #[test]
    #[should_panic(expected = "ops_kind must be RUNWAY_ROLL/TAXI/APRON_MOVEMENT")]
    fn unknown_ops_kind_panics() {
        let _ = compute_band_sel_25m_z_db(0, 2, 0, 0, 18.0, 250.0);
    }

    #[test]
    #[should_panic(expected = "class_idx 99 out of range")]
    fn aircraft_class_idx_out_of_range_panics() {
        let _ =
            compute_band_sel_25m_z_db(0, 99, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
    }

    #[test]
    #[should_panic(expected = "gse_class 99 out of range")]
    fn gse_class_idx_out_of_range_panics() {
        let _ = compute_band_sel_25m_z_db(1, 99, GROUND_OPS_KIND_TAXI, 0, 18.0, 250.0);
    }

    #[test]
    #[should_panic(expected = "ops_kind must be RUNWAY_ROLL/TAXI/APRON_MOVEMENT")]
    fn unknown_ops_kind_panics_for_gse_branch_too() {
        // Validation lives at the entry of compute_band_sel_25m_z_db
        // so the GSE branch (which doesn't read ops_kind) also rejects
        // invalid values rather than silently emitting energy.
        let _ = compute_band_sel_25m_z_db(1, GSE_CLASS_MEDIUM, 0, 0, 10.0, 250.0);
    }
}
