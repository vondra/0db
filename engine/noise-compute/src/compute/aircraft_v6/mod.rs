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

pub use views::{AirborneRowView, AirportTrafficRowView, BBox, CruiseRowView, SubSegmentSlice};

const NUM_BANDS: usize = 8;

/// Pure-view popup compute. Consumes typed slices borrowed from the v6
/// popup arrows; emits `(NoisePeriods, Vec<Contributor>, AircraftBandData)`
/// matching the legacy entry point's contract.
pub fn compute_aircraft_v6(
    receiver: &Receiver,
    airborne_rows: &[AirborneRowView<'_>],
    cruise_rows: &[CruiseRowView<'_>],
    rasters: &dyn RasterSampler,
    n_days: u16,
    airport_centroids: &[(f64, f64)],
    traces: Option<&mut TraceCollector>,
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

    if timing_on {
        let t_total = t_start.elapsed();
        let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
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
            compute_aircraft_v6(&receiver, &[], &[], &FlatGround, 1, &[], None);
        assert!(!periods.lden_db.is_finite());
        assert!(contribs.is_empty());
    }
}
