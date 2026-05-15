//! Stage 2C — ground operations.
//!
//! Writes `airport_traffic.arrow` per R4: sparse per-microsegment
//! per-period traffic counters with daily-total linear Z-weighted band
//! energy (v2 `airport_traffic_v2` contract). Consults OSM
//! `airport_areas.arrow` for nearest-aerodrome identity and reads
//! `airport_lines.arrow` per R4 for the aeroway microsegment graph.
//!
//! The legacy `ground.arrow` per-rotation paths writer was retired in
//! Phase 6 (commit `<this commit>`); see `airport_traffic_writer.rs`
//! for the current data shape.

use std::path::Path;

use anyhow::Result;
use noise_compute::types::AirportArea;

use crate::flight::FlightSegment;

pub mod airport_traffic;
pub mod airport_traffic_writer;

/// Run Stage 2C over a global segment slice + global aerodrome
/// identity set. `airport_areas` aggregates every R4's
/// `airport_areas.arrow` (filtered to `aeroway = aerodrome`) so the
/// nearest-aerodrome lookup sees whole airports even when an airport
/// is split across R4 boundaries.
///
/// Returns the R4-count from the `airport_traffic.arrow` writer.
pub fn run_stage_2c(
    segments: &[FlightSegment],
    airport_areas: &[AirportArea],
    h3r4_dir: &Path,
    n_days: u16,
) -> Result<usize> {
    let traffic_n =
        airport_traffic_writer::run_airport_traffic(segments, airport_areas, h3r4_dir, n_days)?;
    eprintln!("[stage2c] airport_traffic.arrow R4s={traffic_n}");
    Ok(traffic_n)
}
