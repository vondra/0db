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
}
