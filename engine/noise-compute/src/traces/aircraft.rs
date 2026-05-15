//! Per-row trace builders for the airborne + cruise aircraft
//! sub-types (`SegmentTrace` `aircraft_subtype` 2 = airborne
//! sub-segment, 3 = cruise R8 hex). Ground-path traces were retired in
//! Phase 6 along with `ground.arrow`; airport_traffic contributors
//! do not push traces.

use crate::emission::aircraft::{typecode_to_string, PERIOD_SECONDS};
use crate::types::{
    CruiseBucketBreakdown, CruiseHexTopFlight, EmissionTrace, LayerKind, PerPeriod,
    PropagationVariants, SegmentTrace, NUM_BANDS,
};

use super::{
    empty_path_profile, empty_screening_trace, empty_terrain_trace, empty_vegetation_trace,
    ground_trace, point_source_aloft_baseline, variants_to_lden,
};

/// Path-effect / band slots stay zero because aircraft propagation
/// (Doc 29 SEL chain) doesn't expose them at the per-event level — see
/// SPEC.md §5.4. Frontend gates Section 4/5/6 detail rows for
/// `aircraft_subtype` 2 / 3 to avoid showing the resulting `−∞ dB`.
fn aircraft_period_variants(period_energies: [f64; 3], n_days: f64) -> [PropagationVariants; 3] {
    std::array::from_fn(|i| {
        let normed = if n_days > 0.0 {
            period_energies[i] / (n_days * PERIOD_SECONDS[i])
        } else {
            0.0
        };
        PropagationVariants {
            full_energy: normed,
            ..Default::default()
        }
    })
}

/// Inputs for an airborne sub-segment trace.
pub struct BuildAircraftAirborneSubSegmentTrace<'a> {
    pub callsign: &'a str,
    pub aircraft_type: &'a [u8; 4],
    pub class_name: &'static str,
    pub flight_id: u64,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub cpa_distance_m: f64,
    pub altitude_m_at_cpa: f64,
    pub d_slant_m: f64,
    /// Linear-domain event energy per period `[day, evening, night]`
    /// (active period holds `10^(SEL/10)`, others zero).
    pub period_energies: [f64; 3],
    pub n_days: f64,
}

pub fn build_aircraft_airborne_subsegment_trace(
    inputs: BuildAircraftAirborneSubSegmentTrace<'_>,
) -> SegmentTrace {
    let typecode_str = typecode_to_string(inputs.aircraft_type);
    let variants = aircraft_period_variants(inputs.period_energies, inputs.n_days);
    let (icao_hex, start_unix) = crate::flight_id::icao_hex_and_start_unix(inputs.flight_id);
    SegmentTrace {
        kind: LayerKind::Aircraft,
        osm_id: None,
        segment_idx: 0,
        name: if inputs.callsign.is_empty() {
            typecode_str.clone()
        } else {
            format!("{} ({typecode_str})", inputs.callsign)
        },
        subtype: "airborne".to_string(),
        is_dominant_of_group: false,
        start_lat: inputs.start_lat,
        start_lon: inputs.start_lon,
        end_lat: inputs.end_lat,
        end_lon: inputs.end_lon,
        cp_lat: 0.5 * (inputs.start_lat + inputs.end_lat),
        cp_lon: 0.5 * (inputs.start_lon + inputs.end_lon),
        length_m: 0.0,
        dist_m: inputs.cpa_distance_m,
        d_slant_m: inputs.d_slant_m,
        bridge: false,
        tunnel: false,
        emission: EmissionTrace::AircraftAirborne {
            class: inputs.class_name,
            callsign: inputs.callsign.to_string(),
            aircraft_type: typecode_str,
            cpa_distance_m: inputs.cpa_distance_m,
            altitude_m_at_cpa: inputs.altitude_m_at_cpa,
            icao_hex,
            start_unix,
        },
        lw_bands: PerPeriod {
            day: [0.0; NUM_BANDS],
            evening: [0.0; NUM_BANDS],
            night: [0.0; NUM_BANDS],
        },
        lw_db_a: PerPeriod {
            day: 0.0,
            evening: 0.0,
            night: 0.0,
        },
        baseline: point_source_aloft_baseline(inputs.d_slant_m, inputs.altitude_m_at_cpa),
        path_profile: empty_path_profile(),
        terrain: empty_terrain_trace(),
        screening: empty_screening_trace(),
        vegetation: empty_vegetation_trace(),
        ground: ground_trace(0.0),
        received_bands: PerPeriod::silent_bands(),
        received_lden: variants_to_lden(&variants),
        aircraft_subtype: 2,
        polyline: None,
        hex_polygon: None,
        cruise_buckets: None,
        cruise_top_flights: None,
        length_m_per_kind: None,
    }
}

/// Inputs for a cruise R8 hex aggregate trace.
pub struct BuildAircraftCruiseR8Trace {
    pub r8_hex: u64,
    pub n_unique_flights: u32,
    pub rep_alt_m: f32,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub d_slant_m: f64,
    /// Linear-domain event-energy sum per period `[day, evening, night]`
    /// across every cruise row contributing to this R8 cell.
    pub period_energies: [f64; 3],
    pub n_days: f64,
    pub cruise_buckets: Vec<CruiseBucketBreakdown>,
    pub cruise_top_flights: Vec<CruiseHexTopFlight>,
}

pub fn build_aircraft_cruise_r8_trace(inputs: BuildAircraftCruiseR8Trace) -> SegmentTrace {
    let r8_str = format!("{:015x}", inputs.r8_hex);
    // Trailing `f`s are res-15 child padding; the first 10 hex chars carry the res-8 address.
    let display_name = format!("Cruise over {}", &r8_str[..10]);
    let hex_polygon = h3_cell_boundary(inputs.r8_hex);
    let variants = aircraft_period_variants(inputs.period_energies, inputs.n_days);

    SegmentTrace {
        kind: LayerKind::Aircraft,
        osm_id: None,
        segment_idx: 0,
        name: display_name,
        subtype: "cruise".to_string(),
        is_dominant_of_group: false,
        start_lat: inputs.centroid_lat,
        start_lon: inputs.centroid_lon,
        end_lat: inputs.centroid_lat,
        end_lon: inputs.centroid_lon,
        cp_lat: inputs.centroid_lat,
        cp_lon: inputs.centroid_lon,
        length_m: 0.0,
        dist_m: 0.0,
        d_slant_m: inputs.d_slant_m,
        bridge: false,
        tunnel: false,
        emission: EmissionTrace::AircraftCruise {
            r8_hex: r8_str,
            n_unique_flights: inputs.n_unique_flights,
            rep_alt_m: inputs.rep_alt_m,
        },
        lw_bands: PerPeriod {
            day: [0.0; NUM_BANDS],
            evening: [0.0; NUM_BANDS],
            night: [0.0; NUM_BANDS],
        },
        lw_db_a: PerPeriod {
            day: 0.0,
            evening: 0.0,
            night: 0.0,
        },
        baseline: point_source_aloft_baseline(inputs.d_slant_m, inputs.rep_alt_m as f64),
        path_profile: empty_path_profile(),
        terrain: empty_terrain_trace(),
        screening: empty_screening_trace(),
        vegetation: empty_vegetation_trace(),
        ground: ground_trace(0.0),
        received_bands: PerPeriod::silent_bands(),
        received_lden: variants_to_lden(&variants),
        aircraft_subtype: 3,
        polyline: None,
        hex_polygon: Some(hex_polygon),
        cruise_buckets: Some(inputs.cruise_buckets),
        cruise_top_flights: Some(inputs.cruise_top_flights),
        length_m_per_kind: None,
    }
}

/// Boundary lat/lon of an H3 res-8 cell. Last vertex equals the
/// first to close the GeoJSON ring (W6).
fn h3_cell_boundary(r8_hex: u64) -> Vec<(f64, f64)> {
    use h3o::CellIndex;
    let Ok(cell) = CellIndex::try_from(r8_hex) else {
        return Vec::new();
    };
    let boundary = cell.boundary();
    let mut ring = Vec::with_capacity(boundary.len() + 1);
    ring.extend(boundary.iter().map(|ll| (ll.lat(), ll.lng())));
    if let Some(first) = ring.first().copied() {
        ring.push(first);
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emission::aircraft::period_leq;

    fn build_airborne(period_energies: [f64; 3], n_days: f64) -> SegmentTrace {
        build_aircraft_airborne_subsegment_trace(BuildAircraftAirborneSubSegmentTrace {
            callsign: "TEST",
            aircraft_type: b"A320",
            class_name: "Jet medium",
            // Synth fid so `icao_hex_and_start_unix` returns (empty, None),
            // exercising the same trace-emission branch real synth IDs take.
            flight_id: crate::flight_id::pack_synth(1),
            start_lat: 50.0,
            start_lon: 14.0,
            end_lat: 50.001,
            end_lon: 14.001,
            cpa_distance_m: 500.0,
            altitude_m_at_cpa: 800.0,
            d_slant_m: 943.4,
            period_energies,
            n_days,
        })
    }

    /// Popup invariant: segments add up to the source aggregate. The
    /// END Lden mix is open-coded against EU 2002/49/EC — delegating to
    /// `variants_to_lden` would be circular (production path uses it).
    #[test]
    fn airborne_segments_energy_sum_to_source_aggregate() {
        let n_days = 7.0;
        let segs = [
            build_airborne([1.0e9, 0.0, 0.0], n_days),
            build_airborne([0.0, 5.0e8, 2.0e8], n_days),
        ];

        let segment_energy_sum: f64 = segs
            .iter()
            .map(|s| 10f64.powf(s.received_lden.full / 10.0))
            .sum();

        let total = [1.0e9, 5.0e8, 2.0e8];
        let ld = period_leq(total[0], n_days, PERIOD_SECONDS[0]);
        let le = period_leq(total[1], n_days, PERIOD_SECONDS[1]);
        let ln = period_leq(total[2], n_days, PERIOD_SECONDS[2]);
        let source_lden = 10.0
            * ((12.0 * 10f64.powf(ld / 10.0)
                + 4.0 * 10f64.powf((le + 5.0) / 10.0)
                + 8.0 * 10f64.powf((ln + 10.0) / 10.0))
                / 24.0)
                .log10();
        let source_energy = 10f64.powf(source_lden / 10.0);

        assert!(
            (segment_energy_sum - source_energy).abs() / source_energy < 1e-9,
            "segment Σ {:.6e} vs source {:.6e} (Lden segs={:.4} dB, source={:.4} dB)",
            segment_energy_sum,
            source_energy,
            10.0 * segment_energy_sum.log10(),
            source_lden
        );
    }

    #[test]
    fn single_day_event_matches_period_leq() {
        let s = build_airborne([1.0e9, 0.0, 0.0], 7.0);
        let ld = period_leq(1.0e9, 7.0, PERIOD_SECONDS[0]);
        let expected = 10.0 * (12.0 / 24.0 * 10f64.powf(ld / 10.0)).log10();
        assert!(
            (s.received_lden.full - expected).abs() < 1e-9,
            "received_lden.full={} expected={}",
            s.received_lden.full,
            expected
        );
    }

    /// `n_days = 0` must not produce NaN — popup would render junk.
    /// `−∞ dB` floor is the expected outcome (matches road / rail empty
    /// inputs via `lden_from_periods`).
    #[test]
    fn n_days_zero_returns_neg_inf_not_nan() {
        let s = build_airborne([1.0e9, 0.0, 0.0], 0.0);
        assert!(
            !s.received_lden.full.is_nan(),
            "received_lden.full={}",
            s.received_lden.full
        );
    }
}
