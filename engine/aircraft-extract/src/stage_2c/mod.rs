//! Stage 2C v10 — ground operations into per-R4 `ground.arrow`.
//!
//! Replaces the v9 OSM aeroway snap chain (line / area / aerodrome
//! proximity / R10 fallback) with raw ADS-B passthrough: 1 row =
//! 1 aircraft × 1 contiguous ground path. OSM `airport_areas.arrow`
//! is consulted only for the nearest-aerodrome identity lookup —
//! geometry is the actual aircraft trajectory. See `ground_path.rs`
//! for the path extraction + per-leg ops_kind smoothing + count_weight
//! normalization.

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
pub fn run_stage_2c(
    segments: &[FlightSegment],
    airport_areas: &[AirportArea],
    h3r4_dir: &Path,
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Result<usize> {
    ground_path::run_stage_2c(segments, airport_areas, h3r4_dir, rasters, n_days)
}
