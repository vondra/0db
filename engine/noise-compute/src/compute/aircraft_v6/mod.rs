//! `compute_aircraft_v6` — popup entry point that consumes the popup
//! aircraft arrows directly via typed column views (no Arrow / IPC
//! dependency in noise-compute).
//!
//! Architecture: airborne and cruise rows each scatter directly onto
//! their own per-row kernels:
//! * airborne: per-sub-segment Doc 29 SEL → `FlightAccum` per real fid
//! * cruise:   per-bucket Doc 29 SEL × density → `FlightAccum` per
//!             synth fid + `CruiseFlightStats` per real fid for band
//!             counter dedup
//!
//! Ground operations live in the parallel `airport_traffic` compute
//! path invoked by source-reader after this function returns.

use std::collections::HashMap;

use crate::compute::aircraft_v6::state::{FlightAccum, TopFlightCandidate};
use crate::types::{
    AircraftBandData, AircraftMetadata, Contributor, LayerKind, NoisePeriods,
    PropagationBaseline, RasterSampler, Receiver, ScreeningBreakdown, SourceMetadata,
    TerrainBreakdown, TraceCollector, VegetationBreakdown,
};

pub mod airborne;
pub mod airport_traffic;
pub mod cruise;
pub mod dates;
pub mod state;
pub mod views;

pub use views::{
    AirborneRowView, AirportTrafficRowView, BBox, CruiseRowView, CruiseTopCandidateView,
    SubSegmentSlice, NUM_GSE_CLASSES,
};

const NUM_BANDS: usize = 8;

/// Pure-view popup compute. Consumes typed slices borrowed from the v6
/// popup arrows; emits `(NoisePeriods, Vec<Contributor>, AircraftBandData)`
/// matching the legacy entry point's contract.
#[allow(clippy::too_many_arguments)]
pub fn compute_aircraft_v6(
    receiver: &Receiver,
    airborne_rows: &[AirborneRowView<'_>],
    cruise_rows: &[CruiseRowView<'_>],
    rasters: &dyn RasterSampler,
    n_days: u16,
    airport_centroids: &[(f64, f64)],
    traces: Option<&mut TraceCollector>,
    mut timings: Option<&mut crate::types::LayerTimings>,
) -> (NoisePeriods, Vec<Contributor>, AircraftBandData) {
    let n_days_f = (n_days as f64).max(1.0);

    // Per-layer timing probes. The print is env-gated (POPUP_TIMING=1);
    // the 4 Instant::now()/elapsed() calls run unconditionally but cost
    // <1 µs total per popup. Inline timing > perf/flamegraph for this
    // app: one log line per popup, no perf.data on disk.
    let timing_on = std::env::var("POPUP_TIMING").as_deref() == Ok("1");
    let t_start = std::time::Instant::now();

    let mut traces = traces;
    let flights = airborne::scatter(
        receiver,
        airborne_rows,
        rasters,
        n_days_f,
        airport_centroids,
        traces.as_deref_mut(),
    );
    let t_airborne_scatter = t_start.elapsed();
    let mut cruise_flight_stats = HashMap::new();
    // Cruise gets its own FlightAccum table — the cruise synth fids
    // (`flight_id::pack_synth(idx)` with idx = row index) share the
    // SYNTHETIC_BIT tagging used by airborne TIS-B / anonymous flights
    // at extract time. /gg (Codex) flagged that an airborne synth fid
    // can collide with a cruise idx, and the merged accumulator (now
    // tagged `is_cruise = true`) silently swallows the airborne energy
    // inside `build_detail`'s `if acc.is_cruise { continue }` branch.
    // Keeping the maps disjoint makes the namespaces structurally
    // independent. Cruise contributions to airborne periods come from
    // accumulating their `period_energy` into `airborne_energy`; cruise
    // band counters come from `cruise_flight_stats` (real fid dedup).
    let mut cruise_flights: HashMap<u64, FlightAccum> = HashMap::new();
    let mut top_flight_candidates: HashMap<u64, TopFlightCandidate> = HashMap::new();
    cruise::scatter(
        receiver,
        cruise_rows,
        rasters,
        n_days_f,
        &mut cruise_flights,
        &mut cruise_flight_stats,
        &mut top_flight_candidates,
        traces.as_deref_mut(),
    );
    let t_cruise_scatter = t_start.elapsed() - t_airborne_scatter;

    let cruise_band = cruise::band_stats(&cruise_flight_stats);
    let (airborne_periods, airborne_detail) = airborne::build_detail(
        &flights,
        &cruise_flights,
        cruise_flight_stats.len(),
        &top_flight_candidates,
        &cruise_band,
        n_days_f,
    );
    let t_airborne_detail = t_start.elapsed() - t_airborne_scatter - t_cruise_scatter;

    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    if timing_on {
        let t_total = t_start.elapsed();
        eprintln!(
            "ac-v6 total={:.0}ms airb_scatter={:.0}ms cr_scatter={:.0}ms airb_detail={:.0}ms (n_airb={} n_cr={})",
            ms(t_total),
            ms(t_airborne_scatter),
            ms(t_cruise_scatter),
            ms(t_airborne_detail),
            airborne_rows.len(),
            cruise_rows.len(),
        );
    }
    if let Some(t) = timings.as_deref_mut() {
        // `airb_detail` is a few ms of post-processing — fold into the
        // airborne bucket so the popup breakdown stays 3 aircraft buckets.
        t.aircraft_airborne_ms = ms(t_airborne_scatter) + ms(t_airborne_detail);
        t.aircraft_cruise_ms = ms(t_cruise_scatter);
    }

    let mut contributors: Vec<Contributor> = Vec::new();
    if airborne_periods.lden_db.is_finite() {
        contributors.push(Contributor {
            osm_id: None,
            geometry: None,
            baseline: PropagationBaseline::default(),
            terrain: TerrainBreakdown::default(),
            screening: ScreeningBreakdown::default(),
            vegetation: VegetationBreakdown::default(),
            terrain_impact_db: 0.0,
            screening_impact_db: 0.0,
            vegetation_impact_db: 0.0,
            atmospheric_impact_db: 0.0,
            ground_impact_db: 0.0,
            source_type: LayerKind::Aircraft,
            name: "Aircraft - airborne".to_string(),
            subtype: "airborne".to_string(),
            distance_m: 0.0,
            periods: airborne_periods.clone(),
            periods_free: airborne_periods.clone(),
            emission_db: airborne_periods.lden_db,
            received_bands: [0.0; NUM_BANDS],
            metadata: Some(SourceMetadata::Aircraft(AircraftMetadata {
                variant: "airborne".to_string(),
                airport_name: None,
                airport_key: None,
                airborne: Some(airborne_detail.clone()),
                ground_ops: None,
            })),
        });
    }

    let band_data = AircraftBandData {
        airborne: airborne_detail,
        ground_ops: Default::default(),
    };

    (airborne_periods, contributors, band_data)
}

/// Per-phase aircraft periods, separated for heatmap validation.
///
/// The popup entrypoint [`compute_aircraft_v6`] folds airborne + cruise
/// energy into one `airborne_periods` (matches the single "Aircraft Lden"
/// shown in the popup contributor). The heatmap pipeline computes
/// cruise / airborne / ground ops separately and needs to validate each
/// phase against popup-equivalent numbers — that requires the unfolded
/// values this struct exposes.
///
/// `ground_ops` is None here because ground ops lives in the parallel
/// `airport_traffic::run` path invoked by source-reader, not in
/// `compute_aircraft_v6`. The heatmap validator calls that path directly
/// when it needs ground-only periods.
#[derive(Debug, Clone)]
pub struct AircraftPeriodsBreakdown {
    pub airborne: NoisePeriods,
    pub cruise: NoisePeriods,
}

/// Test-only / validation-only variant of [`compute_aircraft_v6`] that
/// returns airborne and cruise period totals separately instead of
/// folding cruise into airborne.
///
/// Use this from heatmap-v2 validation harnesses to compare per-source
/// heatmap output against the popup-equivalent per-source Lden. The
/// popup contract ([`compute_aircraft_v6`]) is unchanged — production
/// callers must continue to use that entry point.
pub fn compute_aircraft_v6_separable(
    receiver: &Receiver,
    airborne_rows: &[AirborneRowView<'_>],
    cruise_rows: &[CruiseRowView<'_>],
    rasters: &dyn RasterSampler,
    n_days: u16,
    airport_centroids: &[(f64, f64)],
) -> AircraftPeriodsBreakdown {
    use crate::emission::aircraft;
    use crate::periods;

    let n_days_f = (n_days as f64).max(1.0);

    let flights = airborne::scatter(
        receiver,
        airborne_rows,
        rasters,
        n_days_f,
        airport_centroids,
        None,
    );

    let mut cruise_flight_stats: HashMap<u64, state::CruiseFlightStats> = HashMap::new();
    let mut cruise_flights: HashMap<u64, FlightAccum> = HashMap::new();
    let mut top_flight_candidates: HashMap<u64, TopFlightCandidate> = HashMap::new();
    cruise::scatter(
        receiver,
        cruise_rows,
        rasters,
        n_days_f,
        &mut cruise_flights,
        &mut cruise_flight_stats,
        &mut top_flight_candidates,
        None,
    );

    let collapse = |accums: &HashMap<u64, FlightAccum>| -> NoisePeriods {
        let mut e = [0.0f64; 3];
        for acc in accums.values() {
            for p in 0..3 {
                e[p] += acc.period_energy[p];
            }
        }
        if e.iter().sum::<f64>() > 0.0 {
            let ld = aircraft::period_leq(e[0], n_days_f, aircraft::PERIOD_SECONDS[0]);
            let le = aircraft::period_leq(e[1], n_days_f, aircraft::PERIOD_SECONDS[1]);
            let ln = aircraft::period_leq(e[2], n_days_f, aircraft::PERIOD_SECONDS[2]);
            periods::periods(ld, le, ln)
        } else {
            NoisePeriods::silence()
        }
    };

    AircraftPeriodsBreakdown {
        airborne: collapse(&flights),
        cruise: collapse(&cruise_flights),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FlatGround;
    impl RasterSampler for FlatGround {
        fn elevation(&self, _: f64, _: f64) -> f64 {
            0.0
        }
        fn building_height(&self, _: f64, _: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _: f64, _: f64) -> f64 {
            1.0
        }
        fn building_enclosure(&self, _: f64, _: f64) -> f64 {
            0.0
        }
    }

    #[test]
    fn silence_when_no_data() {
        let receiver = Receiver::new(50.10, 14.262, 0.0);
        let (periods, contribs, _band) =
            compute_aircraft_v6(&receiver, &[], &[], &FlatGround, 1, &[], None, None);
        assert!(!periods.lden_db.is_finite());
        assert!(contribs.is_empty());
    }

    #[test]
    fn separable_silence_when_no_data() {
        let receiver = Receiver::new(50.10, 14.262, 0.0);
        let breakdown =
            compute_aircraft_v6_separable(&receiver, &[], &[], &FlatGround, 1, &[]);
        assert!(!breakdown.airborne.lden_db.is_finite());
        assert!(!breakdown.cruise.lden_db.is_finite());
    }
}
