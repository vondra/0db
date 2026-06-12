//! CNOSSOS-EU Annex IV railway emission — calibrated simplification.
//!
//! Per-band: rolling + traction. Speed-dependent rolling.
//! L_roll(f) = A_rolling(f) + 30 × log₁₀(v / v_ref)
//! L_traction(f) = A_traction(f)  [constant]
//! L_total(f) = 10×log₁₀(10^(L_roll/10) + 10^(L_traction/10))
//!
//! Line source density (CNOSSOS Annex IV, NoiseModelling-compatible):
//!   L_W'/m = L_total + 10·log₁₀(Q / (T_h × 1000 × v))
//! where Q = trains in period, T_h = period hours, v = km/h.
//!
//! Prior revision used `10·log₁₀(Q_per_day)` and treated SRM II `a_r`
//! coefficients as sound-power levels. The coefficients peaked at 4 kHz —
//! a band with 22 dB/km atmospheric absorption — so rail emission was
//! systematically destroyed at range (the atmosphere ate the signal before
//! the receiver could). Coefficients below are entire-train A-weighted
//! L_W values peaked at 500-1000 Hz (physical rail spectrum per ISO 3095
//! / CNOSSOS), scaled so a typical mainline corridor matches EU END
//! reference levels in the 0-5 km range.

use crate::types::NUM_BANDS;

const B_ROLLING: f64 = 30.0;

struct RailVehicleCoeffs {
    a_rolling: [f64; NUM_BANDS],
    a_traction: [f64; NUM_BANDS],
    v_ref: f64,
    v_max: f64,
}

const FREIGHT: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [110.0, 118.0, 126.0, 130.0, 131.0, 128.0, 120.0, 110.0],
    a_traction: [115.0, 113.0, 110.0, 105.0, 100.0, 95.0, 90.0, 85.0],
    v_ref: 80.0,
    v_max: 120.0,
};

const PASSENGER: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [105.0, 112.0, 118.0, 122.0, 125.0, 122.0, 115.0, 105.0],
    a_traction: [100.0, 98.0, 95.0, 92.0, 88.0, 84.0, 78.0, 70.0],
    v_ref: 100.0,
    // 300 km/h high-speed: rolling scales via 30·log10(v/v_ref) — not a
    // dedicated aerodynamic model, but avoids the old silent clamp at 200.
    v_max: 300.0,
};

const TRAM: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [98.0, 105.0, 110.0, 114.0, 117.0, 114.0, 107.0, 97.0],
    a_traction: [105.0, 103.0, 100.0, 97.0, 93.0, 89.0, 83.0, 75.0],
    v_ref: 50.0,
    v_max: 70.0,
};

const LIGHT_RAIL: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [100.0, 107.0, 112.0, 116.0, 119.0, 116.0, 109.0, 99.0],
    a_traction: [108.0, 106.0, 103.0, 100.0, 96.0, 92.0, 86.0, 78.0],
    v_ref: 80.0,
    v_max: 120.0,
};

/// Rail vehicle type (matches rail_type field in Arrow IPC).
#[derive(Debug, Clone, Copy)]
pub enum RailType {
    Rail,        // 0 — mixed passenger/freight
    Tram,        // 1
    LightRail,   // 2
    NarrowGauge, // 3
    Funicular,   // 4
}

impl RailType {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Tram,
            2 => Self::LightRail,
            3 => Self::NarrowGauge,
            4 => Self::Funicular,
            _ => Self::Rail,
        }
    }
}

/// Compute emission bands for one vehicle type at given speed [dB/vehicle].
fn vehicle_emission(coeffs: &RailVehicleCoeffs, speed_kmh: f64) -> [f64; NUM_BANDS] {
    let v = speed_kmh.clamp(20.0, coeffs.v_max);
    let speed_corr = B_ROLLING * (v / coeffs.v_ref).log10();

    let mut bands = [0.0f64; NUM_BANDS];
    let c = std::f64::consts::LN_10 * 0.1;
    for i in 0..NUM_BANDS {
        let l_roll = coeffs.a_rolling[i] + speed_corr;
        let l_tract = coeffs.a_traction[i];
        bands[i] = 10.0 * ((l_roll * c).exp() + (l_tract * c).exp()).log10();
    }
    bands
}

/// Compute railway line source emission per meter [dB/m] as Leq over `period_hours`.
///
/// CNOSSOS Annex IV density: `L_W/m = L_W_per_train + 10·log₁₀(Q / (T × 1000 × v))`
/// where Q = trains in the period, T = period hours (12 day / 4 evening / 8 night),
/// v = km/h. Callers pass the per-period train subset and the period length.
pub fn railway_emission(
    rail_type: RailType,
    speed_kmh: f64,
    trains_passenger: f64,
    trains_freight: f64,
    period_hours: f64,
) -> [f64; NUM_BANDS] {
    let v = speed_kmh.max(20.0);
    let flow_denom = (period_hours.max(0.1) * 1000.0 * v).max(1.0);
    let mut total_energy = [0.0f64; NUM_BANDS];

    if trains_passenger > 0.0 {
        let coeffs = match rail_type {
            RailType::Tram => &TRAM,
            RailType::LightRail | RailType::NarrowGauge => &LIGHT_RAIL,
            _ => &PASSENGER,
        };
        let per_train = vehicle_emission(coeffs, v);
        let q_corr = 10.0 * (trains_passenger / flow_denom).log10();
        for i in 0..NUM_BANDS {
            total_energy[i] += ((per_train[i] + q_corr) * std::f64::consts::LN_10 * 0.1).exp();
        }
    }

    if trains_freight > 0.0 {
        let per_train = vehicle_emission(&FREIGHT, v.min(FREIGHT.v_max));
        let q_corr = 10.0 * (trains_freight / flow_denom).log10();
        for i in 0..NUM_BANDS {
            total_energy[i] += ((per_train[i] + q_corr) * std::f64::consts::LN_10 * 0.1).exp();
        }
    }

    let mut result = [f64::NEG_INFINITY; NUM_BANDS];
    for i in 0..NUM_BANDS {
        result[i] = if total_energy[i] > 0.0 {
            10.0 * total_energy[i].log10()
        } else {
            f64::NEG_INFINITY
        };
    }
    result
}

/// Default train counts when enrichment data is not available.
/// Returns (passenger_per_day, freight_per_day).
pub fn default_traffic(rail_type: RailType, usage: u8) -> (f64, f64) {
    match rail_type {
        RailType::Tram => (120.0, 0.0),       // urban tram: ~120 services/day
        RailType::LightRail => (80.0, 0.0),   // light rail: ~80/day
        RailType::NarrowGauge => (10.0, 0.0), // narrow gauge: tourist/local
        RailType::Funicular => (40.0, 0.0),   // funicular: frequent but short
        RailType::Rail => match usage {
            0 => (80.0, 20.0), // main line: 80 passenger + 20 freight
            1 => (30.0, 5.0),  // branch: 30 passenger + 5 freight
            2 => (0.0, 15.0),  // industrial siding: freight only
            _ => (40.0, 10.0), // unknown: moderate
        },
    }
}

/// Default speed when maxspeed tag is missing.
pub fn default_speed(rail_type: RailType) -> f64 {
    match rail_type {
        RailType::Tram => 40.0,
        RailType::LightRail => 60.0,
        RailType::NarrowGauge => 40.0,
        RailType::Funicular => 20.0,
        RailType::Rail => 80.0,
    }
}

/// Free-field Lden [dB(A)] of one rail row at horizontal distance `d` metres.
///
/// **Reference propagation** (the per-row reach solver's spine — identical to
/// the derivation that reproduced the 2026-05-24 Codex empirical at the 7 km
/// boundary, `.claude/plans/heatmap-orchestrator-audit/layer-line.md` §A):
/// ISO 9613-2 cylindrical line spreading `10·log10(2π·d)` + atmospheric
/// absorption `α_atm·d/1000`, **best-case ground** (`G = 0`, hard reflective
/// ground — the loudest the receiver can ever hear, so reach never under-shoots
/// a soft-ground site), **no** terrain / screening / vegetation / finite-line
/// (a blanket reach can't know the per-receiver geometry; the kernel still
/// applies all of those per pixel inside the reach). Per-period emission uses
/// the same 0.65/0.20/0.15 day/evening/night traffic split and 12/4/8 h period
/// lengths as `compute_railways`, fed through [`railway_emission`], then folded
/// to Lden with the END +5/+10 dB penalties via [`crate::periods::compute_lden`].
///
/// `q_pax` / `q_frt` are the *effective* whole-day counts (post service /
/// parallel-divisor scaling — i.e. `NormalizedRail::scaled_*_per_day`), so a
/// divided or service track shrinks its own reach.
fn free_field_lden_at(rail_type: RailType, speed_kmh: f64, q_pax: f64, q_frt: f64, d: f64) -> f64 {
    use crate::constants::{ALPHA_ATM, GROUND_CF};
    use crate::propagation::iso9613::a_weighted_total;

    let d = d.max(1.0);
    let geo = 10.0 * (2.0 * std::f64::consts::PI * d).log10();
    let d_over_1000 = d / 1000.0;
    // q_pct, period_hours per END day/evening/night.
    let received = |q_pct: f64, period_hours: f64| -> f64 {
        let em = railway_emission(rail_type, speed_kmh, q_pax * q_pct, q_frt * q_pct, period_hours);
        let mut bands = [0.0f64; NUM_BANDS];
        for i in 0..NUM_BANDS {
            // G = 0: A_ground = GROUND_CF[i] · 0 = 0, kept explicit for parity
            // with `propagate_bands` so the boundary matches the kernel's
            // free-field limit exactly.
            bands[i] = em[i] - geo - ALPHA_ATM[i] * d_over_1000 - GROUND_CF[i] * 0.0;
        }
        a_weighted_total(&bands)
    };
    let ld = received(0.65, 12.0);
    let le = received(0.20, 4.0);
    let ln = received(0.15, 8.0);
    crate::periods::compute_lden(ld, le, ln)
}

/// Per-row rail audibility reach [m]: the distance at which this segment's own
/// free-field Lden falls to [`crate::constants::RAILWAY_REACH_TARGET_LDEN_DB`]
/// (~25 dB), clamped to `[RAILWAY_REACH_CLAMP_MIN, RAILWAY_REACH_CLAMP_MAX]`.
/// Replaces the retired blanket `RAILWAY_MAX_RADIUS`; the heatmap loader and the
/// popup distance gate BOTH call this, so their cutoff is identical by
/// construction (no magic-number drift). Runs once per row at load — cost is
/// irrelevant.
///
/// Solved by bisection over **log-distance** (`free_field_lden_at` is
/// monotonically decreasing in `d`, dominated by the `10·log10(2π·d)` term, so
/// the root is unique). 40 log-steps over `[100 m, 50 km]` converge to < 1 m —
/// far tighter than the 30 m raster cadence the reach feeds. If the row is so
/// loud it never crosses 25 dB inside 50 km, or so quiet it is already below at
/// 100 m, the clamp catches it.
///
/// `q_pax` / `q_frt` = effective whole-day counts (post service / divisor
/// scaling). See [`free_field_lden_at`] for the propagation reference.
pub fn rail_reach_m(rail_type: RailType, speed_kmh: f64, q_pax: f64, q_frt: f64) -> f64 {
    use crate::constants::{
        RAILWAY_REACH_CLAMP_MAX, RAILWAY_REACH_CLAMP_MIN, RAILWAY_REACH_TARGET_LDEN_DB,
    };
    let target = RAILWAY_REACH_TARGET_LDEN_DB;
    let mut lo = 100.0_f64; // below floor; bisection bracket, clamp finalises
    let mut hi = 50_000.0_f64; // above ceiling; widest bracket we ever need
    // 40 log-halvings: (ln(50000)-ln(100))/2^40 → sub-millimetre, ample margin.
    for _ in 0..40 {
        let mid = ((lo.ln() + hi.ln()) * 0.5).exp();
        if free_field_lden_at(rail_type, speed_kmh, q_pax, q_frt, mid) > target {
            lo = mid; // still loud → push the crossing outward
        } else {
            hi = mid;
        }
    }
    let reach = ((lo.ln() + hi.ln()) * 0.5).exp();
    reach.clamp(RAILWAY_REACH_CLAMP_MIN, RAILWAY_REACH_CLAMP_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::propagation::iso9613::a_weighted_total;

    // 24h is used as "day-equivalent total" so old tests remain comparable.
    const DAY_H: f64 = 24.0;

    #[test]
    fn test_passenger_100kmh() {
        // 50 passenger trains/day at 100 km/h — Leq over 24 h
        let bands = railway_emission(RailType::Rail, 100.0, 50.0, 0.0, DAY_H);
        let aw = a_weighted_total(&bands);
        // Expected: 50-85 dB(A)/m for suburban rail.
        assert!(
            aw > 50.0 && aw < 85.0,
            "passenger 100km/h 50 trains: {:.1}",
            aw
        );
    }

    #[test]
    fn test_freight_louder() {
        // Freight should be louder than passenger at same Q and speed
        let pax = railway_emission(RailType::Rail, 80.0, 20.0, 0.0, DAY_H);
        let frt = railway_emission(RailType::Rail, 80.0, 0.0, 20.0, DAY_H);
        let pax_aw = a_weighted_total(&pax);
        let frt_aw = a_weighted_total(&frt);
        assert!(
            frt_aw > pax_aw,
            "freight ({:.1}) should be louder than passenger ({:.1})",
            frt_aw,
            pax_aw
        );
    }

    #[test]
    fn test_tram_lower_speed() {
        // 100 trams/day at 40 km/h
        let bands = railway_emission(RailType::Tram, 40.0, 100.0, 0.0, DAY_H);
        let aw = a_weighted_total(&bands);
        assert!(aw > 50.0 && aw < 85.0, "tram 40km/h 100 trams: {:.1}", aw);
    }

    #[test]
    fn test_leq_day_vs_night_same_count() {
        // Same trains passed per period — shorter period means higher hourly flow,
        // so Leq over 4 h (evening) is louder than Leq over 12 h (day).
        let day = a_weighted_total(&railway_emission(
            RailType::Rail, 100.0, 100.0, 10.0, 12.0,
        ));
        let eve = a_weighted_total(&railway_emission(
            RailType::Rail, 100.0, 100.0, 10.0, 4.0,
        ));
        let diff = eve - day;
        // +10·log10(12/4) ≈ 4.77 dB expected
        assert!((diff - 4.77).abs() < 0.1, "expected +4.77 dB, got {:.2}", diff);
    }

    /// The reach solver must put the free-field Lden of each representative row
    /// exactly at the 25 dB target *at the distance it returns* — the defining
    /// property. Verified by re-evaluating `free_field_lden_at` at the solved
    /// reach (skipped when the clamp fired, since then the crossing is outside
    /// `[min,max]` and the returned value is the clamp, not the root).
    #[test]
    fn reach_lands_on_25_db_target() {
        for (rt, sp, qp, qf) in [
            (RailType::Rail, 80.0, 80.0, 20.0),
            (RailType::Rail, 300.0, 80.0, 0.0),
            (RailType::Tram, 40.0, 120.0, 0.0),
        ] {
            let r = rail_reach_m(rt, sp, qp, qf);
            // All three crossings fall strictly inside the clamp band.
            assert!(r > 2_000.0 && r < 10_000.0, "{:?} reach {r} hit a clamp", rt);
            let lden = free_field_lden_at(rt, sp, qp, qf, r);
            assert!((lden - 25.0).abs() < 0.05, "{:?} Lden@reach = {lden:.3}, want 25", rt);
        }
    }

    /// REGRESSION ANCHOR: the default mainline (80 pax + 20 freight @ 80 km/h,
    /// the `default_traffic(Rail, usage=0)` row) must reach ≈7 km — reproducing
    /// the retired blanket `RAILWAY_MAX_RADIUS = 7000` so the dominant ~96 % of
    /// rail rows are value-neutral. layer-line.md §A: 25.3 dB @ 7 km.
    #[test]
    fn default_mainline_reach_reproduces_7km() {
        let r = rail_reach_m(RailType::Rail, 80.0, 80.0, 20.0);
        assert!((r - 7_000.0).abs() < 300.0, "default mainline reach {r:.0} m, want ≈7000");
    }

    /// HONESTY FIX: a 300 km/h high-speed corridor is 30.8 dB @ 7 km
    /// (layer-line.md §A) — 5.8 dB louder than the boundary, currently truncated
    /// early. Its calibrated reach must extend to ≈9-9.5 km.
    #[test]
    fn highspeed_reach_extends_to_9km() {
        let r = rail_reach_m(RailType::Rail, 300.0, 80.0, 0.0);
        assert!((9_000.0..=9_700.0).contains(&r), "HS reach {r:.0} m, want ≈9-9.5 km");
    }

    /// PERF WIN: tram (120 services/day @ 40 km/h) is only 16.8 dB @ 7 km —
    /// far below the boundary, so it shrinks. Calibrated reach ≈3.5-4.5 km
    /// (continuous form; layer-line.md's 3.5 km bucket was the rounded
    /// light-rail figure — the busier 120-train tram default lands a touch
    /// higher). Lighter rail classes shrink further still.
    #[test]
    fn tram_reach_shrinks_below_mainline() {
        let tram = rail_reach_m(RailType::Tram, 40.0, 120.0, 0.0);
        assert!((3_500.0..=4_500.0).contains(&tram), "tram reach {tram:.0} m, want ≈3.5-4.5 km");
        let light = rail_reach_m(RailType::LightRail, 60.0, 80.0, 0.0);
        assert!(light < tram, "light-rail {light:.0} should be < tram {tram:.0}");
        assert!(light < 7_000.0, "light-rail {light:.0} must be well under the old 7 km");
    }

    /// Clamp floor: a near-silent stub (one passenger train/day @ 80 km/h
    /// solves to ~900 m) must still clamp UP to the 2 km floor so its near
    /// field stays drawn. Clamp ceiling: a very loud, fast, freight-heavy
    /// corridor solves past 10 km and must clamp DOWN to the halo budget.
    #[test]
    fn reach_clamps_at_floor_and_ceiling() {
        let stub = rail_reach_m(RailType::Rail, 80.0, 1.0, 0.0);
        assert_eq!(stub, 2_000.0, "degenerate-quiet row must clamp to the 2 km floor");
        let loud = rail_reach_m(RailType::Rail, 250.0, 200.0, 80.0);
        assert_eq!(loud, 10_000.0, "loud HS-freight corridor must clamp to the 10 km ceiling");
    }
}
