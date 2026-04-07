//! CNOSSOS-EU Annex IV railway emission (RMR model).
//!
//! Per-band: rolling + traction. Speed-dependent rolling.
//! L_roll(f) = A_rolling(f) + 30 × log₁₀(v / v_ref)
//! L_traction(f) = A_traction(f)  [constant]
//! L_total(f) = 10×log₁₀(10^(L_roll/10) + 10^(L_traction/10))
//!
//! Line source: L_W'/m = L_total + 10×log₁₀(Q)
//! Note: uses direct train-count scaling, not density-per-meter Q/(1000×v).
//! This is an intentional simplification for atlas-scale computation.

use crate::types::NUM_BANDS;

const B_ROLLING: f64 = 30.0;

struct RailVehicleCoeffs {
    a_rolling: [f64; NUM_BANDS],
    a_traction: [f64; NUM_BANDS],
    v_ref: f64,
    v_max: f64,
}

const FREIGHT: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [10.2, 23.3, 38.2, 40.3, 57.9, 66.4, 68.5, 58.3],
    a_traction: [30.0, 28.0, 25.0, 22.0, 20.0, 15.0, 10.0, 5.0],
    v_ref: 80.0, v_max: 120.0,
};

const PASSENGER: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [18.8, 30.3, 41.8, 41.6, 54.4, 57.3, 61.5, 56.7],
    a_traction: [35.0, 32.0, 30.0, 28.0, 25.0, 20.0, 15.0, 8.0],
    v_ref: 100.0, v_max: 200.0,
};

const TRAM: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [16.9, 27.1, 40.2, 41.4, 52.6, 53.2, 55.3, 51.0],
    a_traction: [30.0, 28.0, 26.0, 24.0, 22.0, 18.0, 12.0, 5.0],
    v_ref: 50.0, v_max: 70.0,
};

const LIGHT_RAIL: RailVehicleCoeffs = RailVehicleCoeffs {
    a_rolling: [16.9, 27.1, 40.2, 41.4, 52.6, 53.2, 55.3, 51.0],
    a_traction: [38.0, 35.0, 33.0, 30.0, 27.0, 22.0, 16.0, 8.0],
    v_ref: 80.0, v_max: 120.0,
};

/// Rail vehicle type (matches rail_type field in Arrow IPC).
#[derive(Debug, Clone, Copy)]
pub enum RailType {
    Rail,       // 0 — mixed passenger/freight
    Tram,       // 1
    LightRail,  // 2
    NarrowGauge,// 3
    Funicular,  // 4
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

/// Compute railway line source emission per meter [dB/m].
///
/// Combines passenger and freight contributions.
/// Q = trains per day (not per hour). Scaling: `10×log₁₀(Q)` added to per-train emission.
/// (Unlike roads where density = Q/(1000×v), railways use total train count directly.)
pub fn railway_emission(
    rail_type: RailType,
    speed_kmh: f64,
    trains_passenger_per_day: f64,
    trains_freight_per_day: f64,
) -> [f64; NUM_BANDS] {
    let v = speed_kmh.max(20.0);
    let mut total_energy = [0.0f64; NUM_BANDS];

    // Passenger contribution: per-train Lw/m + 10×log₁₀(Q)
    if trains_passenger_per_day > 0.0 {
        let coeffs = match rail_type {
            RailType::Tram => &TRAM,
            RailType::LightRail | RailType::NarrowGauge => &LIGHT_RAIL,
            _ => &PASSENGER,
        };
        let per_train = vehicle_emission(coeffs, v);
        let q_corr = 10.0 * trains_passenger_per_day.log10();
        for i in 0..NUM_BANDS {
            total_energy[i] += ((per_train[i] + q_corr) * std::f64::consts::LN_10 * 0.1).exp();
        }
    }

    // Freight contribution
    if trains_freight_per_day > 0.0 {
        let per_train = vehicle_emission(&FREIGHT, v.min(FREIGHT.v_max));
        let q_corr = 10.0 * trains_freight_per_day.log10();
        for i in 0..NUM_BANDS {
            total_energy[i] += ((per_train[i] + q_corr) * std::f64::consts::LN_10 * 0.1).exp();
        }
    }

    let mut result = [f64::NEG_INFINITY; NUM_BANDS];
    for i in 0..NUM_BANDS {
        result[i] = if total_energy[i] > 0.0 { 10.0 * total_energy[i].log10() } else { f64::NEG_INFINITY };
    }
    result
}

/// Default train counts when enrichment data is not available.
/// Returns (passenger_per_day, freight_per_day).
pub fn default_traffic(rail_type: RailType, usage: u8) -> (f64, f64) {
    match rail_type {
        RailType::Tram => (120.0, 0.0),        // urban tram: ~120 services/day
        RailType::LightRail => (80.0, 0.0),     // light rail: ~80/day
        RailType::NarrowGauge => (10.0, 0.0),   // narrow gauge: tourist/local
        RailType::Funicular => (40.0, 0.0),      // funicular: frequent but short
        RailType::Rail => match usage {
            0 => (80.0, 20.0),   // main line: 80 passenger + 20 freight
            1 => (30.0, 5.0),    // branch: 30 passenger + 5 freight
            2 => (0.0, 15.0),    // industrial siding: freight only
            _ => (40.0, 10.0),   // unknown: moderate
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

    #[test]
    fn test_passenger_100kmh() {
        // 50 passenger trains/day at 100 km/h
        let bands = railway_emission(RailType::Rail, 100.0, 50.0, 0.0);
        let aw = a_weighted_total(&bands);
        // Expected: moderate level (~55-75 dB/m for suburban rail with 50 trains)
        assert!(aw > 50.0 && aw < 85.0, "passenger 100km/h 50 trains: {:.1}", aw);
    }

    #[test]
    fn test_freight_louder() {
        // Freight should be louder than passenger at same Q and speed
        let pax = railway_emission(RailType::Rail, 80.0, 20.0, 0.0);
        let frt = railway_emission(RailType::Rail, 80.0, 0.0, 20.0);
        let pax_aw = a_weighted_total(&pax);
        let frt_aw = a_weighted_total(&frt);
        assert!(frt_aw > pax_aw, "freight ({:.1}) should be louder than passenger ({:.1})", frt_aw, pax_aw);
    }

    #[test]
    fn test_tram_lower_speed() {
        // 100 trams/day at 40 km/h
        let bands = railway_emission(RailType::Tram, 40.0, 100.0, 0.0);
        let aw = a_weighted_total(&bands);
        assert!(aw > 50.0 && aw < 85.0, "tram 40km/h 100 trams: {:.1}", aw);
    }
}
