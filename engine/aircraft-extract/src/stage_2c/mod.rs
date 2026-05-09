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

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use noise_compute::emission::aircraft::prepare_ground_context;
use noise_compute::types::{AircraftSegment, AirportArea, AirportLine, RasterSampler};

use crate::flight::FlightSegment;
use crate::progress::Ticker;
use crate::stage_2c::aeroway_snap::{AeroSnap, SnapSource, SNAP_SOURCES};

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
    eprintln!("[stage2c] converting {} segments", segments.len());
    let mut observed_v5 = synthesize::convert_segments(segments);

    // Multi-day clustering of low-AGL observed segments tags grass
    // strips / informal helipads with `GROUND_CONTEXT_INFERRED` BEFORE
    // synth runs — synth's coverage decision then sees the inferred
    // airport identity and skips the apron-template fill that would
    // otherwise emit anonymous R10-fallback rows for those clusters.
    // Inference is offline-only (see `infer_repeated_ground_context`
    // docstring in noise-compute/src/emission/aircraft.rs — popup
    // runtime can't afford the O(N log N) clustering pass; Stage 2C
    // is the batch-extract caller and runs once per global re-extract).
    let prep_stats = prepare_ground_context(
        &mut observed_v5,
        airport_lines,
        airport_areas,
        rasters,
        n_days,
        /* enable_inference */ true,
    );
    eprintln!(
        "[stage2c] prepare_ground_context: airport_marked={} inferred_marked={} resolved_kind={}",
        prep_stats.airport_context_marked,
        prep_stats.inferred_context_marked,
        prep_stats.resolved_ops_kind,
    );

    let synth_v5 = synthesize::synthesize(&observed_v5, airport_lines, airport_areas, rasters, n_days);
    eprintln!(
        "[stage2c] {} observed + {} synthetic surface segments — snapping",
        observed_v5.len(),
        synth_v5.len()
    );

    // Snap loop is the single hot section in Stage 2C; aeroway
    // lookups + raster AGL probes dominate. Praha-150km does this in
    // ~30 s; globally it's the long pole so observability matters.
    let total = observed_v5.len() + synth_v5.len();
    let mut processed = 0usize;
    let mut items: Vec<(AircraftSegment, aeroway_snap::AeroSnap)> = Vec::new();
    let mut ticker = Ticker::new();
    let mut log_progress = |processed: usize, kept: usize| {
        ticker.maybe_tick(|| {
            eprintln!(
                "[stage2c] {processed}/{total} segments snapped ({pct:.1}%) — {kept} kept",
                pct = 100.0 * processed as f64 / total.max(1) as f64,
            );
        });
    };

    for seg in &observed_v5 {
        processed += 1;
        log_progress(processed, items.len());
        if !is_ground_candidate(seg, rasters) {
            continue;
        }
        let snap = aeroway_snap::assign(seg, airport_lines, airport_areas);
        items.push((seg.clone(), snap));
    }
    for seg in &synth_v5 {
        processed += 1;
        log_progress(processed, items.len());
        let snap = aeroway_snap::assign(seg, airport_lines, airport_areas);
        items.push((seg.clone(), snap));
    }

    log_snap_breakdown(&items);

    eprintln!("[stage2c] bucketing {} snapped items", items.len());
    let buckets = bucket::accumulate(&items, rasters, n_days);
    eprintln!("[stage2c] writing {} buckets per R4", buckets.len());
    r4_partition::write_per_r4(buckets, h3r4_dir, n_days)
}

/// Per-airport + global breakdown of snap-source provenance. Drives the
/// "is OSM aeroway tagging good enough at airport X?" question — when a
/// busy airport drops below the line+area threshold, OSM is missing
/// runways/taxiways and the fix is upstream (OSM tagging) not in the
/// snap chain.
fn log_snap_breakdown(items: &[(AircraftSegment, AeroSnap)]) {
    // Below this many segments, the line+area share is too noisy to
    // distinguish a slow-tagging airport from random small-strip traffic.
    // 50 ≈ a few days × a handful of movements at a regional aerodrome.
    const BUSY_AIRPORT_THRESHOLD: u32 = 50;
    // 30 % is a heuristic floor: LKPR canonical case empirically lands
    // ~50 % line+area after M3 (was 28 % pre-M3); a busy airport under
    // 30 % is almost certainly an OSM-tagging gap, not a snap-chain bug.
    // Tune by eye if false positives appear.
    const LINE_AREA_WARN_PCT: f32 = 30.0;
    const TOP_AIRPORTS: usize = 20;

    if items.is_empty() {
        return;
    }
    let mut totals = [0u32; SNAP_SOURCES.len()];
    let mut by_airport: HashMap<&str, [u32; SNAP_SOURCES.len()]> = HashMap::new();
    for (_, snap) in items {
        let idx = snap.snap_source as usize;
        totals[idx] += 1;
        if !snap.airport_key.is_empty() {
            by_airport
                .entry(snap.airport_key.as_str())
                .or_insert([0u32; SNAP_SOURCES.len()])[idx] += 1;
        }
    }
    let total: u32 = totals.iter().sum();
    let pct = |n: u32| 100.0 * n as f32 / total.max(1) as f32;
    let summary: String = SNAP_SOURCES
        .iter()
        .map(|s| format!("{s}={} ({:.1}%) ", totals[*s as usize], pct(totals[*s as usize])))
        .collect();
    eprintln!("[stage2c] snap breakdown — {summary}of {total} segments");

    let mut sorted: Vec<_> = by_airport.into_iter().collect();
    // Tiebreaker on airport key — HashMap order is random, so without
    // it the top-20 cutoff would flip-flop across runs.
    sorted.sort_by(|a, b| {
        let sa: u32 = a.1.iter().sum();
        let sb: u32 = b.1.iter().sum();
        sb.cmp(&sa).then_with(|| a.0.cmp(b.0))
    });
    for (airport, counts) in sorted.iter().take(TOP_AIRPORTS) {
        let n: u32 = counts.iter().sum();
        // Skip R10Fallback: it always has an empty airport_key, so the
        // per-airport tally never sees those snaps. Showing `r10=0` for
        // every airport would falsely suggest "this airport had no
        // anonymous fallbacks" — they're tallied in the global summary
        // above instead. /gg (Gemini) caught the misleading column.
        let breakdown: String = SNAP_SOURCES
            .iter()
            .filter(|s| **s != SnapSource::R10Fallback)
            .map(|s| format!("{s}={} ", counts[*s as usize]))
            .collect();
        eprintln!("[stage2c] {airport}: {n} segs → {breakdown}");
        let line_area = counts[SnapSource::Line as usize] + counts[SnapSource::Area as usize];
        let line_area_pct = 100.0 * line_area as f32 / n.max(1) as f32;
        if n >= BUSY_AIRPORT_THRESHOLD && line_area_pct < LINE_AREA_WARN_PCT {
            eprintln!(
                "[stage2c] WARN {airport}: only {line_area_pct:.0}% line+area on {n} segments — OSM aeroway may be missing runway/taxiway geometry",
            );
        }
    }
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
            callsign: String::new(),
            aircraft_type: [0u8; 4],
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
