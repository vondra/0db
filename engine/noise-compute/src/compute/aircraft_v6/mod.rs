//! `compute_aircraft_v6` — popup entry point that consumes the v6
//! popup arrows directly via typed column views (no Arrow / IPC
//! dependency in noise-compute).
//!
//! Architecture: airborne, cruise and ground rows each scatter directly
//! onto their own per-row kernels:
//! * airborne: per-sub-segment Doc 29 SEL → `FlightAccum` per real fid
//! * cruise:   per-bucket Doc 29 SEL × density → `FlightAccum` per
//!             synth fid + `CruiseFlightStats` per real fid for band
//!             counter dedup
//! * ground:   per-row stored `em_*_bands` → `propagate_variants_full`
//!             without re-bucketing or re-computing reference SEL
//!             (the `dB_sum_v6_1` contract)
//!
//! No `AircraftSegment` `Vec` is allocated and no fallthrough to the
//! legacy `compute_aircraft` function — that function is gone after
//! C2/C4. The v6 path is the only popup contract.

use std::collections::HashMap;

use crate::compute::aircraft_v6::state::FlightAccum;
use crate::periods;
use crate::types::{
    AircraftBandData, AircraftMetadata, Barrier, Contributor, LayerKind, NoisePeriods,
    PropagationBaseline, RasterSampler, Receiver, ScreeningBreakdown, SourceMetadata,
    TerrainBreakdown, TraceCollector, VegetationBreakdown,
};

pub mod airborne;
pub mod cruise;
pub mod ground;
pub mod state;
pub mod views;

pub use views::{AirborneRowView, BBox, CruiseRowView, GroundRowView, SubSegmentSlice};

const NUM_BANDS: usize = 8;

/// Pure-view popup compute. Consumes typed slices borrowed from the v6
/// popup arrows; emits `(NoisePeriods, Vec<Contributor>, AircraftBandData)`
/// matching the legacy entry point's contract.
pub fn compute_aircraft_v6(
    receiver: &Receiver,
    airborne_rows: &[AirborneRowView<'_>],
    cruise_rows: &[CruiseRowView<'_>],
    ground_rows: &[GroundRowView<'_>],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    n_days: u16,
    traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>, AircraftBandData) {
    let n_days_f = (n_days as f64).max(1.0);

    let flights = airborne::scatter(receiver, airborne_rows, rasters);
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
    cruise::scatter(
        receiver,
        cruise_rows,
        rasters,
        &mut cruise_flights,
        &mut cruise_flight_stats,
    );

    let mut cruise_band = cruise::band_stats(&cruise_flight_stats);
    let (airborne_periods, airborne_detail) = airborne::build_detail(
        &flights,
        &cruise_flights,
        &mut cruise_band,
        n_days_f,
        traces,
    );

    let g_res = ground::run(receiver, ground_rows, barriers, rasters);
    let (ground_periods, ground_contribs, ground_detail) =
        ground::build_outputs(receiver, barriers, rasters, &g_res, n_days_f);

    let combined_periods = combine_periods(&airborne_periods, &ground_periods);

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
    contributors.extend(ground_contribs);

    let band_data = AircraftBandData {
        airborne: airborne_detail,
        ground_ops: ground_detail,
    };

    (combined_periods, contributors, band_data)
}

/// Energy-sum the airborne periods (already daily-averaged via Doc 29
/// normalization in `airborne::build_detail`) with the v6 ground periods.
fn combine_periods(airborne: &NoisePeriods, ground: &NoisePeriods) -> NoisePeriods {
    let to_lin = |db: f64| -> f64 {
        if db.is_finite() {
            (db * std::f64::consts::LN_10 * 0.1).exp()
        } else {
            0.0
        }
    };
    let to_db = |lin: f64| -> f64 {
        if lin > 0.0 {
            10.0 * lin.log10()
        } else {
            f64::NEG_INFINITY
        }
    };
    let total_day = to_lin(airborne.ld_db) + to_lin(ground.ld_db);
    let total_eve = to_lin(airborne.le_db) + to_lin(ground.le_db);
    let total_night = to_lin(airborne.ln_db) + to_lin(ground.ln_db);
    if total_day + total_eve + total_night <= 0.0 {
        return NoisePeriods::silence();
    }
    periods::periods(to_db(total_day), to_db(total_eve), to_db(total_night))
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
            compute_aircraft_v6(&receiver, &[], &[], &[], &[], &FlatGround, 1, None);
        assert!(!periods.lden_db.is_finite());
        assert!(contribs.is_empty());
    }
}
