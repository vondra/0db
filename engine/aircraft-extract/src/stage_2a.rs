//! Stage 2A — Airborne segments → per-R4 `airborne.arrow`.
//!
//! One row per (flight, R4) crossing. Sub-segments (each carrying its
//! own period / date / flags) are kept in a `List<Struct>` so a long
//! crossing that straddles 19:00 still gets the correct Lden weighting.
//!
//! Consumes the per-R4 airborne shards produced by
//! [`crate::shuffle::shuffle_per_r4`] — one input file per R4 means each
//! worker owns its R4's segments + accumulator, no global merge.
//!
//! v15 (Opt A) samples per-sub-segment midpoint elevation here from
//! `rasters.dem` so the popup terrain gates can drop `SegmentTerrain::sample`
//! (5 raster lookups per sub-segment, mutex-serialised in raster-reader)
//! on the hot path. Start/end elevations propagate from Stage 1's
//! per-point loop. Stage 2A is the right layer for mid because the
//! mid-point is interpolated between two ADS-B samples, not stored
//! per-point.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use rayon::prelude::*;

use crate::arrow_io::read_segments;
use crate::flight::{
    segment_flags, AirborneEvent, AirborneSubSegment, FlightSegment, Phase,
};
use crate::geo::{interp_along_path, r4_hex_str};
use crate::scope::ScopeBbox;
use crate::shuffle::list_r4_shards;
use noise_compute::types::RasterSampler;
use raster_reader::RealRasters;

/// Run Stage 2A against the shuffled per-R4 airborne shards under
/// `segments_by_r4_dir/<R4>/airborne.arrow`. When `scope` is set, R4
/// subdirs outside it are skipped — scope was applied during shuffle
/// already, so this is defensive and cheap.
///
/// `rasters` provides DEM access for per-sub-segment midpoint elevation
/// (v15 Opt A). The shared `RealRasters` instance is mutex-internal so
/// rayon parallelism is safe; the caller may want to call
/// `rasters.dem.preload_bbox` before invoking us if the scope is known
/// (CLI does this implicitly via Stage 1 having already touched every
/// tile in scope; in isolated `stage2a` runs preload happens per-R4
/// inside the per-shard loop).
pub fn run_stage_2a(
    segments_by_r4_dir: &Path,
    h3r4_dir: &Path,
    n_days: u16,
    scope: Option<&ScopeBbox>,
    rasters: &RealRasters,
) -> Result<usize> {
    // Wipe stale airborne.arrow from in-scope R4s before workers write
    // fresh files. R4s with no airborne activity this run would otherwise
    // retain a prior-run file (possibly older schema) and the popup
    // reader would fatal-fail on schema_version mismatch. Symmetric to
    // the Stage 2B/2C guards.
    let wiped = crate::wipe::wipe_stale_arrows_for_scope(
        h3r4_dir,
        "airborne.arrow",
        scope,
    )?;
    if wiped > 0 {
        eprintln!("[stage2a] wiped {wiped} stale airborne.arrow file(s) before write");
    }
    let r4_inputs = list_r4_shards(segments_by_r4_dir, "airborne.arrow", scope)?;
    let n_r4 = r4_inputs.len();
    eprintln!("[stage2a] starting: {n_r4} R4 cells");
    let stage_start = std::time::Instant::now();

    let written = std::sync::atomic::AtomicUsize::new(0);
    r4_inputs
        .par_iter()
        .try_for_each(|(r4, shard_path)| -> Result<()> {
            let segments = read_segments(shard_path)
                .with_context(|| format!("read {}", shard_path.display()))?;
            let events = aggregate_events_for_r4(&segments, rasters);
            if events.is_empty() {
                return Ok(());
            }
            let dir = h3r4_dir.join(r4_hex_str(*r4));
            std::fs::create_dir_all(&dir)?;
            crate::arrow_io::write_airborne(&dir.join("airborne.arrow"), &events, n_days)?;
            written.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        })?;
    let written = written.load(std::sync::atomic::Ordering::Relaxed);
    eprintln!("[stage2a] done: {written} R4s in {:?}", stage_start.elapsed());
    Ok(written)
}

fn aggregate_events_for_r4(
    segments: &[FlightSegment],
    rasters: &RealRasters,
) -> Vec<AirborneEvent> {
    let mut by_flight: HashMap<u64, AirborneEventBuilder> = HashMap::new();
    for seg in segments {
        // Shuffle pre-filtered by Phase; veh_kind only filtered here
        // because the schema can't distinguish aircraft from GSE at
        // shuffle time (Phase::Ground covers both; Airborne should
        // already be aircraft-only, but defense-in-depth is cheap).
        if seg.phase != Phase::Airborne || seg.veh_kind != 0 {
            continue;
        }
        by_flight
            .entry(seg.flight_id)
            .or_insert_with(|| AirborneEventBuilder::new(seg))
            .push(seg, rasters);
    }
    by_flight.into_values().map(AirborneEventBuilder::finish).collect()
}

struct AirborneEventBuilder {
    flight_id: u64,
    callsign: String,
    aircraft_type: [u8; 4],
    profile_idx: u8,
    source_id: u8,
    origin: u8,
    sub_segments: Vec<AirborneSubSegment>,
    bbox_min_lat: f32,
    bbox_max_lat: f32,
    bbox_min_lon: f32,
    bbox_max_lon: f32,
    total_length_m: f32,
}

impl AirborneEventBuilder {
    fn new(seed: &FlightSegment) -> Self {
        Self {
            flight_id: seed.flight_id,
            callsign: seed.callsign.clone(),
            aircraft_type: seed.aircraft_type,
            profile_idx: seed.profile_idx,
            source_id: seed.source_id,
            origin: seed.origin,
            sub_segments: Vec::new(),
            bbox_min_lat: f32::MAX,
            bbox_max_lat: f32::MIN,
            bbox_min_lon: f32::MAX,
            bbox_max_lon: f32::MIN,
            total_length_m: 0.0,
        }
    }
    fn push(&mut self, seg: &FlightSegment, rasters: &RealRasters) {
        let mut flags = 0u8;
        if seg.is_departure() {
            flags |= segment_flags::IS_DEPARTURE;
        }
        self.bbox_min_lat = self
            .bbox_min_lat
            .min(seg.start_lat)
            .min(seg.end_lat);
        self.bbox_max_lat = self
            .bbox_max_lat
            .max(seg.start_lat)
            .max(seg.end_lat);
        self.bbox_min_lon = self
            .bbox_min_lon
            .min(seg.start_lon)
            .min(seg.end_lon);
        self.bbox_max_lon = self
            .bbox_max_lon
            .max(seg.start_lon)
            .max(seg.end_lon);
        self.total_length_m += seg.length_m;
        // v15 (Opt A): sample q1 / mid / q3 terrain elevation here.
        // Start/end come from Stage 1 (per-point ADS-B lookup); the
        // three intermediate samples are between ADS-B samples and
        // must be sampled now. All stored explicitly because real
        // DEM is non-linear: a narrow ridge at frac=0.25 or 0.75 can
        // sit tens of metres above any linear estimate between
        // endpoints, and the popup AGL gate needs to detect that
        // underground segments aren't passed through silently
        // (LOWI / SEQM / KASE mountain airports). `interp_along_path`
        // is antimeridian-safe so polar / dateline-crossing
        // sub-segments sample the right tiles.
        let (q1_lat, q1_lon) = interp_along_path(
            seg.start_lat, seg.start_lon, seg.end_lat, seg.end_lon, 0.25,
        );
        let (mid_lat, mid_lon) = interp_along_path(
            seg.start_lat, seg.start_lon, seg.end_lat, seg.end_lon, 0.5,
        );
        let (q3_lat, q3_lon) = interp_along_path(
            seg.start_lat, seg.start_lon, seg.end_lat, seg.end_lon, 0.75,
        );
        let q1_elev = rasters.elevation(q1_lat as f64, q1_lon as f64) as f32;
        let mid_elev = rasters.elevation(mid_lat as f64, mid_lon as f64) as f32;
        let q3_elev = rasters.elevation(q3_lat as f64, q3_lon as f64) as f32;
        self.sub_segments.push(AirborneSubSegment {
            start_lat: seg.start_lat,
            start_lon: seg.start_lon,
            start_alt_m: seg.start_alt_m,
            end_lat: seg.end_lat,
            end_lon: seg.end_lon,
            end_alt_m: seg.end_alt_m,
            speed_kt: seg.speed_kt,
            length_m: seg.length_m,
            period: seg.period,
            date_id: seg.date_id,
            flags,
            terrain_start_elev_m: seg.start_elev_m,
            terrain_q1_elev_m: q1_elev,
            terrain_mid_elev_m: mid_elev,
            terrain_q3_elev_m: q3_elev,
            terrain_end_elev_m: seg.end_elev_m,
        });
    }
    fn finish(self) -> AirborneEvent {
        AirborneEvent {
            flight_id: self.flight_id,
            callsign: self.callsign,
            aircraft_type: self.aircraft_type,
            profile_idx: self.profile_idx,
            source_id: self.source_id,
            origin: self.origin,
            sub_segments: self.sub_segments,
            total_length_m: self.total_length_m,
            bbox_min_lat: self.bbox_min_lat,
            bbox_max_lat: self.bbox_max_lat,
            bbox_min_lon: self.bbox_min_lon,
            bbox_max_lon: self.bbox_max_lon,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(flight_id: u64, lat: f32, lon: f32) -> FlightSegment {
        FlightSegment {
            callsign: String::new(),
            aircraft_type: [0u8; 4],
            flight_id,
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            veh_kind: 0,
            gse_class: 0,
            period: 0,
            date_id: 0,
            phase: Phase::Airborne,
            flags: 0,
            start_lat: lat,
            start_lon: lon,
            start_alt_m: 1000.0,
            end_lat: lat + 0.001,
            end_lon: lon + 0.001,
            end_alt_m: 1100.0,
            speed_kt: 250.0,
            length_m: 200.0,
            agl_avg_m: 500.0,
            start_elev_m: 250.0,
            end_elev_m: 260.0,
        }
    }

    /// Test-only `RealRasters` factory: points at a tempdir that has
    /// no DEM tiles, so `rasters.elevation` returns 0.0 m everywhere
    /// (the raster-reader fall-through path for missing tiles). Keeps
    /// unit tests independent of `data/prepared` DEM availability.
    fn test_rasters() -> RealRasters {
        let tmp = tempfile::tempdir().unwrap();
        // RealRasters::new takes a `data/prepared` dir; an empty dir
        // exercises the no-tile path which returns sea-level (0 m).
        // We leak the tmp so the path remains valid for the test's
        // lifetime — tests bin gets cleaned up at process exit anyway.
        let path = tmp.path().to_path_buf();
        std::mem::forget(tmp);
        RealRasters::new(&path)
    }

    #[test]
    fn aggregate_groups_per_flight() {
        let rasters = test_rasters();
        let s1 = seg(1, 50.10, 14.26);
        let s2 = seg(1, 50.10, 14.27);
        let s3 = seg(2, 50.10, 14.26);
        let segs = vec![s1, s2, s3];
        let events = aggregate_events_for_r4(&segs, &rasters);
        assert_eq!(events.len(), 2);
        let f1 = events.iter().find(|e| e.flight_id == 1).unwrap();
        assert_eq!(f1.sub_segments.len(), 2);
        let f2 = events.iter().find(|e| e.flight_id == 2).unwrap();
        assert_eq!(f2.sub_segments.len(), 1);
    }

    #[test]
    fn aggregate_filters_non_aircraft_and_non_airborne() {
        let rasters = test_rasters();
        let mut gse = seg(1, 50.10, 14.26);
        gse.veh_kind = 1;
        let mut ground = seg(2, 50.10, 14.26);
        ground.phase = Phase::Ground;
        let ok = seg(3, 50.10, 14.26);
        let events = aggregate_events_for_r4(&[gse, ground, ok], &rasters);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].flight_id, 3);
    }

    #[test]
    fn aggregate_propagates_terrain_elevs_from_stage1() {
        // Synthetic case: Stage 1 said start=250 m, end=260 m. With
        // ZeroRasters q1/mid/q3 = 0. Verifies start/end pass through
        // and q1/mid/q3 are sampled (not interpolated).
        let rasters = test_rasters();
        let events = aggregate_events_for_r4(&[seg(1, 50.10, 14.26)], &rasters);
        assert_eq!(events.len(), 1);
        let sub = &events[0].sub_segments[0];
        assert!((sub.terrain_start_elev_m - 250.0).abs() < 1e-3);
        assert!((sub.terrain_end_elev_m - 260.0).abs() < 1e-3);
        // q1/mid/q3 are sampled from rasters (0 m at empty-tile
        // fall-through), NOT linearly interpolated from start/end.
        assert!((sub.terrain_q1_elev_m - 0.0).abs() < 1e-3);
        assert!((sub.terrain_mid_elev_m - 0.0).abs() < 1e-3);
        assert!((sub.terrain_q3_elev_m - 0.0).abs() < 1e-3);
    }

    /// Round trip: write a per-R4 airborne shard via the shuffle
    /// schema, run Stage 2A, verify an airborne.arrow lands in h3r4.
    #[test]
    fn run_stage_2a_consumes_per_r4_shard() {
        use crate::arrow_io::write_segments;
        let tmp = tempfile::tempdir().unwrap();
        let by_r4 = tmp.path().join("segments_by_r4");
        let h3r4 = tmp.path().join("h3r4");
        let r4 = {
            use h3o::{LatLng, Resolution};
            let ll = LatLng::new(50.10, 14.26).unwrap();
            u64::from(ll.to_cell(Resolution::Four))
        };
        let r4_dir = by_r4.join(r4_hex_str(r4));
        std::fs::create_dir_all(&r4_dir).unwrap();
        write_segments(
            &r4_dir.join("airborne.arrow"),
            &[seg(1, 50.10, 14.26), seg(2, 50.10, 14.27)],
        )
        .unwrap();

        let rasters = test_rasters();
        let n = run_stage_2a(&by_r4, &h3r4, 1, None, &rasters).unwrap();
        assert_eq!(n, 1);
        let out = h3r4.join(r4_hex_str(r4)).join("airborne.arrow");
        assert!(out.exists(), "Stage 2A must write airborne.arrow");
    }

    /// Regression for wipe-on-scope applied to airborne: a stale
    /// `airborne.arrow` in an in-scope R4 must be wiped before
    /// `run_stage_2a` returns, even if no airborne segments hit that
    /// R4 this run. Symmetric to Stage 2B/2C tests.
    #[test]
    fn run_stage_2a_wipes_in_scope_stale_airborne() {
        use h3o::{LatLng, Resolution};
        let tmp = tempfile::tempdir().unwrap();
        let by_r4 = tmp.path().join("segments_by_r4");
        let h3r4 = tmp.path().join("h3r4");
        // Praha R4 — in-scope. No segments_by_r4 input → writer does
        // not emit a fresh airborne.arrow for this run.
        let r4 = u64::from(
            LatLng::new(50.10, 14.26)
                .unwrap()
                .to_cell(Resolution::Four),
        );
        let r4_dir = h3r4.join(r4_hex_str(r4));
        std::fs::create_dir_all(&r4_dir).unwrap();
        let stale = r4_dir.join("airborne.arrow");
        std::fs::write(&stale, b"stale-prev-run").unwrap();
        std::fs::create_dir_all(&by_r4).unwrap();
        let scope = ScopeBbox::parse("48.65,12.00,51.55,16.90").unwrap();
        let rasters = test_rasters();
        let n = run_stage_2a(&by_r4, &h3r4, 1, Some(&scope), &rasters).unwrap();
        assert_eq!(n, 0, "no R4 shards → no R4 written");
        assert!(
            !stale.exists(),
            "stale airborne.arrow must be wiped from in-scope R4"
        );
    }

    /// Out-of-scope counterexample for the airborne wipe: a stale
    /// `airborne.arrow` in an R4 OUTSIDE the scope bbox must survive.
    #[test]
    fn run_stage_2a_leaves_out_of_scope_stale_airborne() {
        use h3o::{LatLng, Resolution};
        let tmp = tempfile::tempdir().unwrap();
        let by_r4 = tmp.path().join("segments_by_r4");
        let h3r4 = tmp.path().join("h3r4");
        // Gran Canaria R4 — outside Praha scope.
        let r4 = u64::from(
            LatLng::new(27.93, -15.39)
                .unwrap()
                .to_cell(Resolution::Four),
        );
        let r4_dir = h3r4.join(r4_hex_str(r4));
        std::fs::create_dir_all(&r4_dir).unwrap();
        let stale = r4_dir.join("airborne.arrow");
        std::fs::write(&stale, b"stale-prev-run").unwrap();
        std::fs::create_dir_all(&by_r4).unwrap();
        let praha = ScopeBbox::parse("48.65,12.00,51.55,16.90").unwrap();
        let rasters = test_rasters();
        let _ = run_stage_2a(&by_r4, &h3r4, 1, Some(&praha), &rasters).unwrap();
        assert!(
            stale.exists(),
            "out-of-scope R4 airborne.arrow must survive a scoped reextract"
        );
    }
}
