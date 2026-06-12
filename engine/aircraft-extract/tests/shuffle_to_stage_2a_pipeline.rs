//! End-to-end coverage of the shuffle → list_r4_shards → Stage 2A
//! chain that RunAll wires up.
//!
//! Specifically guards two `/gg`-flagged failure modes from Step 5:
//!  - `shuffle_per_r4` must wipe `out_dir` so a previous run's R4
//!    shards can't leak into the next run as zombie data.
//!  - Stage 2A must consume the shuffle output (not an in-memory
//!    Vec) — the regression we hit when the orchestrator still held
//!    the global `all_segments` Vec while consumers had migrated.

use std::path::PathBuf;

use aircraft_extract::arrow_io::{read_record_batches, write_segments};
use aircraft_extract::flight::{FlightSegment, Phase};
use aircraft_extract::geo::{lat_lon_to_cell, r4_hex_str};
use aircraft_extract::shuffle::shuffle_per_r4;
use aircraft_extract::stage_2a::run_stage_2a;
use raster_reader::RealRasters;

/// Empty-tree `RealRasters` for integration tests: falls back to
/// sea-level (0 m) elevation everywhere without depending on the
/// real DEM tile cache under `data/prepared`.
fn test_rasters() -> RealRasters {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().to_path_buf();
    std::mem::forget(tmp);
    RealRasters::new(&path)
}

fn seg(flight_id: u64, phase: Phase, lat: f32, lon: f32) -> FlightSegment {
    FlightSegment {
        callsign: format!("FL{flight_id:04}"),
        aircraft_type: *b"A320",
        flight_id,
        profile_idx: 0,
        source_id: 0,
        origin: 0,
        veh_kind: 0,
        gse_class: 0,
        period: 0,
        date_id: 0,
        phase,
        flags: 0,
        start_lat: lat,
        start_lon: lon,
        start_alt_m: 5000.0,
        end_lat: lat + 0.001,
        end_lon: lon + 0.001,
        end_alt_m: 5100.0,
        speed_kt: 300.0,
        length_m: 200.0,
        agl_avg_m: 1000.0,
        start_elev_m: 0.0,
        end_elev_m: 0.0,
    }
}

/// R4 of a `seg()` fixture's MIDPOINT — must match the production path
/// (`shuffle::r4_of_midpoint`). Computing from start-only would be a
/// few-metre offset at the 0.001° step used here and happen to land
/// in the same R4 today, but a future test with longer segments
/// would diverge spuriously.
fn r4_of_seg_at(lat: f32, lon: f32) -> u64 {
    let mid_lat = (lat + (lat + 0.001)) * 0.5;
    let mid_lon = (lon + (lon + 0.001)) * 0.5;
    u64::from(lat_lon_to_cell(mid_lat as f64, mid_lon as f64, h3o::Resolution::Four).unwrap())
}

fn write_day(segments_dir: &std::path::Path, day: &str, segs: &[FlightSegment]) -> PathBuf {
    let path = segments_dir.join(format!("{day}.arrow"));
    write_segments(&path, segs).unwrap();
    path
}

fn list_r4_dirs(root: &std::path::Path) -> Vec<u64> {
    let mut out: Vec<u64> = std::fs::read_dir(root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            u64::from_str_radix(&name, 16).ok()
        })
        .collect();
    out.sort_unstable();
    out
}

/// Happy path: 2 days of mixed-phase segments → shuffle → Stage 2A
/// produces an airborne.arrow per R4 that the segments visited.
#[test]
fn shuffle_then_stage_2a_writes_per_r4_outputs() {
    let tmp = tempfile::tempdir().unwrap();
    let segments_dir = tmp.path().join("segments");
    let by_r4_dir = tmp.path().join("segments_by_r4");
    let h3r4_dir = tmp.path().join("h3r4");
    std::fs::create_dir_all(&segments_dir).unwrap();

    let cz_lat = 50.10;
    let cz_lon = 14.26;
    let nyc_lat = 40.71;
    let nyc_lon = -74.00;

    let day1 = vec![
        seg(1, Phase::Airborne, cz_lat, cz_lon),
        seg(2, Phase::Ground, cz_lat, cz_lon),
        seg(3, Phase::Cruise, cz_lat, cz_lon), // dropped by shuffle
        seg(4, Phase::Airborne, nyc_lat, nyc_lon),
    ];
    let day2 = vec![seg(5, Phase::Airborne, cz_lat, cz_lon)];
    let day1_path = write_day(&segments_dir, "2025-01-21", &day1);
    let day2_path = write_day(&segments_dir, "2025-01-22", &day2);

    shuffle_per_r4(&[day1_path, day2_path], &[], &by_r4_dir, None).unwrap();

    let r4_cz = r4_of_seg_at(cz_lat, cz_lon);
    let r4_nyc = r4_of_seg_at(nyc_lat, nyc_lon);
    assert_eq!(
        list_r4_dirs(&by_r4_dir),
        {
            let mut v = vec![r4_cz, r4_nyc];
            v.sort_unstable();
            v
        },
        "shuffle output dir must contain exactly the two visited R4s"
    );

    let n_r4 = run_stage_2a(&by_r4_dir, &h3r4_dir, 2, 0, None, &test_rasters()).unwrap();
    assert_eq!(n_r4, 2, "Stage 2A should emit airborne.arrow for both R4s");

    let cz_airborne_path = h3r4_dir.join(r4_hex_str(r4_cz)).join("airborne.arrow");
    let nyc_airborne_path = h3r4_dir.join(r4_hex_str(r4_nyc)).join("airborne.arrow");
    assert!(cz_airborne_path.exists());
    assert!(nyc_airborne_path.exists());
    // CZ saw 2 airborne flights (fid=1, fid=5); NYC saw 1 (fid=4).
    let (_, cz_batches) = read_record_batches(&cz_airborne_path).unwrap();
    let (_, nyc_batches) = read_record_batches(&nyc_airborne_path).unwrap();
    let cz_rows: usize = cz_batches.iter().map(|b| b.num_rows()).sum();
    let nyc_rows: usize = nyc_batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(cz_rows, 2, "CZ airborne should have 2 flight rows");
    assert_eq!(nyc_rows, 1, "NYC airborne should have 1 flight row");
}

/// `shuffle_per_r4` must wipe `out_dir` at start. Without this, a
/// narrower-scope rerun (or a recovery from a crashed run) would mix
/// stale R4 shards into the new shuffle output and feed Stage 1.5 /
/// 2A / 2C zombie data — the C1 CRITICAL caught at /gg review.
#[test]
fn second_shuffle_wipes_stale_r4_shards() {
    let tmp = tempfile::tempdir().unwrap();
    let segments_dir = tmp.path().join("segments");
    let by_r4_dir = tmp.path().join("segments_by_r4");
    std::fs::create_dir_all(&segments_dir).unwrap();

    // First run: two R4s touched.
    let cz_lat = 50.10;
    let cz_lon = 14.26;
    let nyc_lat = 40.71;
    let nyc_lon = -74.00;
    let day_path = write_day(
        &segments_dir,
        "2025-01-21",
        &[
            seg(1, Phase::Airborne, cz_lat, cz_lon),
            seg(2, Phase::Airborne, nyc_lat, nyc_lon),
        ],
    );
    shuffle_per_r4(std::slice::from_ref(&day_path), &[], &by_r4_dir, None).unwrap();
    let r4_cz = r4_of_seg_at(cz_lat, cz_lon);
    let r4_nyc = r4_of_seg_at(nyc_lat, nyc_lon);
    assert!(list_r4_dirs(&by_r4_dir).contains(&r4_nyc));

    // Second run: only the CZ segment. NYC R4 dir must be wiped.
    let cz_only = vec![seg(99, Phase::Airborne, cz_lat, cz_lon)];
    let cz_only_path = write_day(&segments_dir, "2025-01-22", &cz_only);
    shuffle_per_r4(&[cz_only_path], &[], &by_r4_dir, None).unwrap();

    let after = list_r4_dirs(&by_r4_dir);
    assert_eq!(
        after,
        vec![r4_cz],
        "second shuffle must wipe the stale NYC R4 shard"
    );
}

/// `shuffle_per_r4` with empty input creates an empty `out_dir` and
/// no temp dir. Stage 2A then sees zero R4 dirs and is a no-op.
#[test]
fn empty_input_pipeline_is_a_clean_noop() {
    let tmp = tempfile::tempdir().unwrap();
    let by_r4_dir = tmp.path().join("segments_by_r4");
    let h3r4_dir = tmp.path().join("h3r4");

    shuffle_per_r4(&[], &[], &by_r4_dir, None).unwrap();
    assert!(by_r4_dir.exists(), "out_dir must be created");
    assert!(!tmp.path().join("temp_shuffle").exists());
    assert!(list_r4_dirs(&by_r4_dir).is_empty());

    let n = run_stage_2a(&by_r4_dir, &h3r4_dir, 1, 0, None, &test_rasters()).unwrap();
    assert_eq!(n, 0);
}
