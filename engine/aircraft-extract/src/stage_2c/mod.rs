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

pub mod airport_summary_reduce;
pub mod airport_traffic;
pub mod airport_traffic_writer;

/// Filename of the global airport summary sidecar emitted by Stage 2C
/// reduce. Lives at `<aircraft_dir>/airport_summary.arrow` where
/// `aircraft_dir` is typically `data/prepared/{year}/aircraft/`.
pub const AIRPORT_SUMMARY_FILENAME: &str = "airport_summary.arrow";

/// Run Stage 2C against the per-R4 ground shards under
/// `segments_by_r4_dir/<R4>/ground.arrow`. `airport_areas` is the
/// global aerodrome identity set (aerodromes straddle R4 boundaries
/// so per-line resolution must see the whole set). When `scope` is
/// set, R4 cells outside its bbox+buffer are skipped — see
/// [`run_stage_2a`](crate::stage_2a::run_stage_2a) for rationale.
///
/// `aircraft_summary_dir` is where the global `airport_summary.arrow`
/// sidecar is written after the per-R4 pass. Per plan §1.3 the popup
/// reads from a single canonical location instead of merging per-R4
/// duplicates. When `None`, defaults to `<h3r4_dir>/../aircraft/`.
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

    // Reduce phase — walk per-R4 airport_summary_parts and union per
    // airport_key. Always run even when traffic_n == 0 so the popup
    // gets a (possibly empty) `airport_summary.arrow` to load (popup
    // §4.3 requires the file to exist when airport_traffic.arrow is
    // present anywhere in the grid disk).
    let parts_root = h3r4_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("h3r4_dir has no parent for airport_summary_parts"))?
        .join("airport_summary_parts");
    let summary_dir = h3r4_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("h3r4_dir has no parent for aircraft sidecar dir"))?
        .join("aircraft");
    std::fs::create_dir_all(&summary_dir)?;
    let summary_path = summary_dir.join(AIRPORT_SUMMARY_FILENAME);
    let n_airports =
        airport_summary_reduce::run_airport_summary_reduce(&parts_root, &summary_path)?;
    eprintln!(
        "[stage2c] airport_summary.arrow airports={n_airports} → {}",
        summary_path.display()
    );
    // Best-effort cleanup: parts/ is intermediate scratch.
    let _ = std::fs::remove_dir_all(&parts_root);
    Ok(traffic_n)
}
