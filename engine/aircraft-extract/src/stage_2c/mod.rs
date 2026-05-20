//! Stage 2C — ground operations.
//!
//! Writes `airport_traffic.arrow` per R4: sparse per-microsegment
//! per-period traffic counters with daily-total linear Z-weighted band
//! energy. Every microsegment a rotation's leg crossed receives both
//! proportional band energy and the rotation's `flight_id` (touch
//! semantics). Consults OSM `airport_areas.arrow` for nearest-
//! aerodrome identity and reads `airport_lines.arrow` per R4 for the
//! aeroway microsegment graph. See `airport_traffic_writer.rs`.

use std::path::Path;

use anyhow::Result;
use noise_compute::types::AirportArea;

use crate::scope::ScopeBbox;

pub mod airport_traffic;
pub mod airport_traffic_writer;

/// Run Stage 2C against the per-R4 ground shards under
/// `segments_by_r4_dir/<R4>/ground.arrow`. `airport_areas` is the
/// global aerodrome identity set (aerodromes straddle R4 boundaries
/// so per-line resolution must see the whole set). When `scope` is
/// set, R4 cells outside its bbox+buffer are skipped — see
/// [`run_stage_2a`](crate::stage_2a::run_stage_2a) for rationale.
pub fn run_stage_2c(
    segments_by_r4_dir: &Path,
    airport_areas: &[AirportArea],
    h3r4_dir: &Path,
    n_days: u16,
    scope: Option<&ScopeBbox>,
) -> Result<usize> {
    let traffic_n = airport_traffic_writer::run_airport_traffic(
        segments_by_r4_dir,
        airport_areas,
        h3r4_dir,
        n_days,
        scope,
    )?;
    eprintln!("[stage2c] airport_traffic.arrow R4s={traffic_n}");
    Ok(traffic_n)
}
