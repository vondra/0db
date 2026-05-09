//! Stage 2C v2 — ground operations into per-R4 `ground.arrow`.
//!
//! 1. Convert Stage 1 segments to the [`AircraftSegment`] shape the v5
//!    synth + emission helpers consume.
//! 2. Synthesize surface segments for airports whose observed flights
//!    don't cover their ground footprint (`missing_scale > 5%`).
//!    Synth runs once globally — buckets land in their owning R4 in
//!    step 4, which is what makes airports split across R4 boundaries
//!    aggregate without double-counting.
//! 3. For every ground-eligible segment (observed ≤ low AGL OR
//!    `surface_model = true`), snap onto the nearest OSM aeroway line
//!    / airport area, falling back to a ~20 m R10 pseudo-line when
//!    nothing is in range. The snap result carries the bucket key
//!    (`osm_id`, `ops_kind`, `sub_bucket_idx`).
//! 4. Aggregate per bucket — energy is summed in linear space and
//!    stored back as dB SPL per the `dB_sum_v6_1` ground contract.
//! 5. Map bucket centroids onto R4 hexes and write ground.arrow.

use std::path::Path;

use anyhow::Result;
use noise_compute::types::{AircraftSegment, AirportArea, AirportLine, RasterSampler};

use crate::flight::FlightSegment;

pub mod aeroway_snap;
pub mod bucket;
pub mod coverage;
pub mod r4_partition;
pub mod synthesize;

/// Run Stage 2C over a global segment slice + global airport geometry.
/// `airport_lines` / `airport_areas` aggregate every R4's
/// `airport_lines.arrow` / `airport_areas.arrow` so coverage / synth
/// see whole airports even when an airport is split across R4s.
pub fn run_stage_2c(
    segments: &[FlightSegment],
    airport_lines: &[AirportLine],
    airport_areas: &[AirportArea],
    h3r4_dir: &Path,
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Result<usize> {
    let observed_v5 = synthesize::convert_segments(segments);
    let synth_v5 = synthesize::synthesize(&observed_v5, airport_lines, airport_areas, rasters, n_days);

    let mut items: Vec<(AircraftSegment, aeroway_snap::AeroSnap)> = Vec::new();

    for seg in &observed_v5 {
        if !is_ground_candidate(seg, rasters) {
            continue;
        }
        let snap = aeroway_snap::assign(seg, airport_lines, airport_areas);
        items.push((seg.clone(), snap));
    }
    for seg in &synth_v5 {
        let snap = aeroway_snap::assign(seg, airport_lines, airport_areas);
        items.push((seg.clone(), snap));
    }

    let buckets = bucket::accumulate(&items, rasters, n_days);
    r4_partition::write_per_r4(buckets, h3r4_dir, n_days)
}

/// Pre-snap filter for observed segments — drops anything that's
/// obviously not a ground op so we don't churn the snap loop on
/// airborne cruise. The full ground-eligibility gate (raster AGL +
/// ground_context) lives inside `build_ground_ops_line_emission` and
/// catches the rest at bucket time. The 80 m AGL threshold uses the
/// raster DEM so elevated airports (Praha = 380 m MSL, Mexico City =
/// 2200 m MSL) aren't pre-rejected; /gg (Codex) caught a prior
/// version that compared `seg.start_alt_m < 80.0` against MSL altitude.
fn is_ground_candidate(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.on_ground || seg.surface_model {
        return true;
    }
    let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
    let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
    let elev = rasters.elevation(mid_lat, mid_lon);
    let agl_min = ((seg.start_alt_m as f64) - elev).min((seg.end_alt_m as f64) - elev);
    agl_min < 80.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flight::{segment_flags, FlightSegment, Phase};
    use noise_compute::types::AirportLine;
    use std::collections::HashMap;
    use tempfile::tempdir;

    /// Stub raster — flat ground at sea level.
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

    fn ground_segment(flight_id: u64, lat: f64, lon: f64) -> FlightSegment {
        FlightSegment {
            flight_id,
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            period: 0,
            date_id: 0,
            phase: Phase::Ground,
            flags: segment_flags::ON_GROUND,
            start_lat: lat as f32,
            start_lon: lon as f32,
            start_alt_m: 0.0,
            end_lat: lat as f32,
            end_lon: (lon + 0.0001) as f32,
            end_alt_m: 0.0,
            speed_kt: 25.0,
            length_m: 50.0,
            agl_avg_m: 0.0,
        }
    }

    fn runway() -> AirportLine {
        AirportLine {
            osm_id: 42,
            aeroway_type: 0,
            name: "RWY24".into(),
            airport_key: "LKPR".into(),
            start_lat: 50.10,
            start_lon: 14.25,
            end_lat: 50.10,
            end_lon: 14.272,
            width_m: 45.0,
        }
    }

    #[test]
    fn empty_input_writes_no_files() {
        let dir = tempdir().unwrap();
        let n = run_stage_2c(&[], &[], &[], dir.path(), &FlatGround, 1).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn n_observed_per_day_is_raw_count_over_window() {
        // 3 observed Ground segments → bucket.n_observed must be 3
        // (raw count over the extraction window). Per-day division
        // happens at popup compute time; if Stage 2C divided here
        // it would be 3/n_days = 1.0 for n_days=3, masking the raw
        // contract.
        let segs: Vec<FlightSegment> = (0..3).map(|i| ground_segment(i, 50.10, 14.262)).collect();
        let observed_v5 = synthesize::convert_segments(&segs);
        let mut items = Vec::new();
        for seg in &observed_v5 {
            let snap = aeroway_snap::assign(seg, &[runway()], &[]);
            items.push((seg.clone(), snap));
        }
        let buckets: HashMap<_, _> = bucket::accumulate(&items, &FlatGround, 3);
        let total_observed: f32 = buckets.values().map(|b| b.n_observed).sum();
        assert!(
            (total_observed - 3.0).abs() < 1e-3,
            "expected raw count 3.0 (not 1.0 = 3/n_days), got {}",
            total_observed
        );
    }

    #[test]
    fn observed_segments_snap_to_runway_bucket() {
        // 5 ground segments along the runway → one or two buckets
        // (depending on the 100 m sub-bucket split), all with
        // osm_id = runway.osm_id.
        let segs: Vec<FlightSegment> = (0..5)
            .map(|i| ground_segment(i, 50.10001, 14.252 + 0.001 * i as f64))
            .collect();
        let observed_v5 = synthesize::convert_segments(&segs);
        let mut items = Vec::new();
        for seg in &observed_v5 {
            let snap = aeroway_snap::assign(seg, &[runway()], &[]);
            items.push((seg.clone(), snap));
        }
        let buckets = bucket::accumulate(&items, &FlatGround, 1);
        assert!(!buckets.is_empty(), "buckets should be non-empty");
        for (key, _) in &buckets {
            assert_eq!(key.osm_id, 42, "all observed segments should snap to runway");
        }
    }
}
