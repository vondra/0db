//! GSE (ground support equipment) emission profiles.
//!
//! Three noise classes — LIGHT, MEDIUM, HEAVY — for airport ground
//! vehicles (follow-me cars, pushback tractors, fuel trucks, fire
//! trucks, runway sweepers, maintenance vans). These vehicles ride
//! Mode-S transponders inside reserved ICAO ranges and surface in
//! ADS-B feeds with `t=GND` or empty typecode; without a dedicated
//! model the legacy pipeline routed them through `WING_FALLBACK`
//! 737-800 NPDs, which over-estimates them by ~25-30 dB.
//!
//! ## Calibration source: CNOSSOS-EU road model (Annex II)
//!
//! Per-band Lw is derived from CNOSSOS CAT1 / CAT2 / CAT3 coefficients
//! evaluated at 20 km/h, CNOSSOS' lowest validated speed (below 20 km/h
//! the formula extrapolates). Class → CNOSSOS category mapping reflects
//! mass + engine size:
//!
//! | Class  | Analog     | CNOSSOS cat | Representative vehicle      |
//! |--------|------------|-------------|-----------------------------|
//! | LIGHT  | passenger  | CAT1        | follow-me, small van, meteo |
//! | MEDIUM | light HGV  | CAT2        | pushback tractor, fuel cart |
//! | HEAVY  | heavy HGV  | CAT3        | fire truck, sweeper, ARFF   |
//!
//! CNOSSOS road noise at low speed is conservative for GSE: it captures
//! tyre-road and engine but misses hydraulic-pump / PTO / aircraft-push
//! load. AEDT 3.x GSE database measures these directly and reports
//! 5-10 dB higher levels per equipment code. Treat these values as a
//! v1 floor; future calibration commits may swap in AEDT measurements
//! per equipment type. Aircraft NPD (NUM_CLASSES = 12 in
//! `profiles_generated`) is untouched — GSE lives in its own table.
//!
//! ## Reference
//!
//! Bands are 8 octaves centred at 63 / 125 / 250 / 500 / 1k / 2k / 4k / 8k Hz.
//! Lw is sound power level at the source (not at a specific distance);
//! distance attenuation, atmospheric absorption, and A-weighting are
//! applied in the propagation stage, identical to `road.rs`.

use crate::types::NUM_BANDS;

pub const NUM_GSE_CLASSES: usize = 3;
pub const GSE_CLASS_LIGHT: u8 = 0;
pub const GSE_CLASS_MEDIUM: u8 = 1;
pub const GSE_CLASS_HEAVY: u8 = 2;

pub static GSE_CLASS_NAMES: [&str; NUM_GSE_CLASSES] = ["LIGHT", "MEDIUM", "HEAVY"];

/// Per-class octave-band sound-power level Lw (dB) at low operating
/// speed (CNOSSOS validated floor, 20 km/h). Aircraft equivalents
/// for context: a single A320 taxi event ≈ 92 dB SEL at 25 m, which
/// corresponds to ~107 dB Lw — HEAVY GSE sustained is ~4 dB below
/// a single taxi pass.
pub static GSE_LW_BANDS_DB: [[f64; NUM_BANDS]; NUM_GSE_CLASSES] = [
    // LIGHT  — CNOSSOS CAT1 @ 20 km/h (~89 dB(A) Lw total)
    [98.9, 87.6, 85.4, 83.4, 84.1, 83.5, 78.9, 71.4],
    // MEDIUM — CNOSSOS CAT2 @ 20 km/h (~100 dB(A) Lw total)
    [106.9, 96.9, 96.0, 95.0, 96.7, 93.3, 86.6, 80.4],
    // HEAVY  — CNOSSOS CAT3 @ 20 km/h (~103 dB(A) Lw total)
    [108.8, 102.1, 100.2, 99.9, 99.4, 95.1, 90.4, 84.1],
];

/// Mode-S ICAO 24-bit address ranges reserved for ground vehicles.
///
/// LKPR / CZ leases `0x49F000..=0x49F1FF` to airport ground transponders
/// (PLET pushback, POZAR ARFF, FOLLOW-ME, meteorology, bird control).
/// Other countries assign distinct ranges; extend the table when ADS-B
/// coverage gains new airports with documented ranges.
pub static GND_VEHICLE_ICAO_RANGES: &[(u32, u32)] = &[
    (0x49F000, 0x49F1FF), // CZ — LKPR/LKKB ground fleet
];

pub fn icao_is_ground_vehicle(icao24: u32) -> bool {
    GND_VEHICLE_ICAO_RANGES
        .iter()
        .any(|(lo, hi)| icao24 >= *lo && icao24 <= *hi)
}

/// Callsign prefix → GSE class lookup.
///
/// Prefixes are LKPR/LKKB-specific (Czech operator). Unknown callsigns
/// fall through to `GSE_CLASS_MEDIUM` — a conservative midpoint when
/// the vehicle role is ambiguous (most fleets are dominated by tractors
/// + tugs, which are MEDIUM-class).
static GSE_CALLSIGN_MAP: &[(&str, u8)] = &[
    ("POZAR", GSE_CLASS_HEAVY),    // ARFF / fire truck
    ("PLET", GSE_CLASS_MEDIUM),    // pushback tractor (PLET 1/2/3)
    ("FOLLOW", GSE_CLASS_LIGHT),   // follow-me car
    ("UDRZBA", GSE_CLASS_MEDIUM),  // maintenance
    ("METEO", GSE_CLASS_LIGHT),    // meteorology
    ("PTACNIK", GSE_CLASS_LIGHT),  // bird control
    ("EMIL", GSE_CLASS_LIGHT),     // ramp coordination
];

pub fn classify_gse_callsign(callsign: &str) -> u8 {
    let cs = callsign.trim().to_ascii_uppercase();
    for (prefix, class) in GSE_CALLSIGN_MAP {
        if cs.starts_with(prefix) {
            return *class;
        }
    }
    GSE_CLASS_MEDIUM
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::propagation::iso9613::a_weighted_total;

    #[test]
    fn classify_pozar_heavy() {
        assert_eq!(classify_gse_callsign("POZAR4"), GSE_CLASS_HEAVY);
        assert_eq!(classify_gse_callsign("pozar9"), GSE_CLASS_HEAVY);
        assert_eq!(classify_gse_callsign("  POZAR21  "), GSE_CLASS_HEAVY);
    }

    #[test]
    fn classify_plet_medium() {
        assert_eq!(classify_gse_callsign("PLET1"), GSE_CLASS_MEDIUM);
        assert_eq!(classify_gse_callsign("PLET 2"), GSE_CLASS_MEDIUM);
    }

    #[test]
    fn classify_follow_light() {
        assert_eq!(classify_gse_callsign("FOLLOW3"), GSE_CLASS_LIGHT);
        assert_eq!(classify_gse_callsign("FOLLOWME"), GSE_CLASS_LIGHT);
    }

    #[test]
    fn classify_unknown_defaults_medium() {
        assert_eq!(classify_gse_callsign("UNKNOWN42"), GSE_CLASS_MEDIUM);
        assert_eq!(classify_gse_callsign(""), GSE_CLASS_MEDIUM);
        assert_eq!(classify_gse_callsign("   "), GSE_CLASS_MEDIUM);
    }

    #[test]
    fn icao_cz_range_recognised() {
        assert!(icao_is_ground_vehicle(0x49F000));
        assert!(icao_is_ground_vehicle(0x49F100));
        assert!(icao_is_ground_vehicle(0x49F1FF));
    }

    #[test]
    fn icao_outside_range_rejected() {
        assert!(!icao_is_ground_vehicle(0x49EFFF), "just below lo edge");
        assert!(!icao_is_ground_vehicle(0x49F200), "just above hi edge");
        assert!(!icao_is_ground_vehicle(0x498F84));
        assert!(!icao_is_ground_vehicle(0x000000));
        assert!(!icao_is_ground_vehicle(0xFFFFFF));
    }

    #[test]
    fn classes_strictly_ordered_loudness() {
        let light = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_LIGHT as usize]);
        let medium = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_MEDIUM as usize]);
        let heavy = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_HEAVY as usize]);
        assert!(light < medium, "LIGHT={light} not < MEDIUM={medium}");
        assert!(medium < heavy, "MEDIUM={medium} not < HEAVY={heavy}");
    }

    #[test]
    fn cnossos_totals_in_expected_band() {
        let light = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_LIGHT as usize]);
        let medium = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_MEDIUM as usize]);
        let heavy = a_weighted_total(&GSE_LW_BANDS_DB[GSE_CLASS_HEAVY as usize]);
        assert!((85.0..95.0).contains(&light), "LIGHT={light} outside 85-95 dB(A)");
        assert!((95.0..105.0).contains(&medium), "MEDIUM={medium} outside 95-105 dB(A)");
        assert!((100.0..110.0).contains(&heavy), "HEAVY={heavy} outside 100-110 dB(A)");
    }
}
