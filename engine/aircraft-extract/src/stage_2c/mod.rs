//! Stage 2C — ground operations.
//!
//! Two parallel writers run from the same Stage 1 segment slice:
//!
//! - **ground.arrow** (v10 `raw_paths_v10` contract): 1 row =
//!   1 aircraft × 1 contiguous ground path. Per-leg ops_kind
//!   smoothing + count_weight normalization. See `ground_path.rs`.
//! - **airport_traffic.arrow** (v1 `airport_traffic_v1` contract):
//!   Sparse per-microsegment per-period counters. Replaces ground.arrow
//!   in Phase 6 after popup parity validation. See
//!   `airport_traffic_writer.rs`.
//!
//! Both consult OSM `airport_areas.arrow` for nearest-aerodrome
//! identity. airport_traffic additionally reads `airport_lines.arrow`
//! per R4 for the OSM aeroway microsegment graph.

use std::path::Path;

use anyhow::Result;
use noise_compute::types::{AirportArea, RasterSampler};

use crate::flight::FlightSegment;

pub mod airport_traffic;
pub mod airport_traffic_writer;
pub mod ground_path;

/// Run Stage 2C over a global segment slice + global aerodrome
/// identity set. `airport_areas` aggregates every R4's
/// `airport_areas.arrow` (filtered to `aeroway = aerodrome`) so the
/// nearest-aerodrome lookup sees whole airports even when an airport
/// is split across R4 boundaries.
///
/// Returns the R4-count from the legacy ground.arrow writer (the
/// load-bearing log line in production). airport_traffic writer
/// emits in parallel; its row count goes to stderr via its own
/// internal log so callers can compare.
pub fn run_stage_2c(
    segments: &[FlightSegment],
    airport_areas: &[AirportArea],
    h3r4_dir: &Path,
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Result<usize> {
    let ground_n =
        ground_path::run_stage_2c(segments, airport_areas, h3r4_dir, rasters, n_days)?;
    let traffic_n =
        airport_traffic_writer::run_airport_traffic(segments, airport_areas, h3r4_dir, n_days)?;
    eprintln!(
        "[stage2c] ground.arrow R4s={ground_n} airport_traffic.arrow R4s={traffic_n}"
    );
    Ok(ground_n)
}
