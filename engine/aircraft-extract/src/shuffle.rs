//! Two-pass shuffle from `segments/<day>.arrow` to per-R4 shards.
//!
//! Why two-pass: a naive single-pass approach would either open one
//! writer per R4 per worker (10k R4s × 24 workers = FD exhaustion) or
//! mutex-serialise writes through one writer per R4 (bottleneck).
//!
//! - **Pass A (scatter).** `par_iter` over `segments/<day>.arrow`. Each
//!   worker decodes one day, partitions Airborne + Ground segments by
//!   `(phase, hash(R4) % SHUFFLE_HASH_BUCKETS)` in RAM, then writes one
//!   complete IPC file per non-empty bucket sequentially — 1 FD per
//!   worker at a time. Paths embed the day so workers never collide.
//!   Cruise is left in the per-day shards (Stage 2B reads them directly;
//!   midpoint-shuffling cruise would lose cross-R4 R8 routing).
//! - **Pass B (gather).** `par_iter` over `2 × SHUFFLE_HASH_BUCKETS`
//!   `(phase, hash)` pairs. Each worker reads every Pass A part file for
//!   its pair, buckets exactly by R4 in RAM, writes
//!   `<out_dir>/<R4>/<phase>.arrow` sequentially. Per-worker peak RAM
//!   bounded by one (phase, hash) bucket's decoded segments.
//!
//! Empirically at 365-day global: Pass A produces ~256 × 2 × 365 ≈ 187k
//! temp files (decode cost dominates write cost). Pass B's per-bucket
//! decoded peak ≈ `total_segments / 256` ≈ ~6 GB per worker; `--max-threads`
//! caps concurrent workers when the host's RAM is below that × cores.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use h3o::Resolution;
use rayon::prelude::*;

use crate::arrow_io::{read_segments, write_segments};
use crate::flight::{FlightSegment, Phase};
use crate::geo::{lat_lon_to_cell, midpoint, r4_hex_str};
use crate::scope::ScopeBbox;

/// Coarse hash buckets the shuffle is partitioned across. 256 is small
/// enough that one Pass B worker holds one bucket's decoded segments in
/// RAM (~6 GB at 365-day global) without OOM on a 90-128 GB box, and
/// large enough that Pass A's per-worker bucket count stays well under
/// any FD limit (each writer opens one file at a time).
const SHUFFLE_HASH_BUCKETS: u64 = 256;

/// SplitMix64 over the H3 cell index — same rationale as
/// `stage_2b::spill_bucket`. H3 packs mode/resolution/base-cell into
/// high bits with digit bits in low positions; a naive `% N` would
/// correlate buckets with the lowest digits and skew load. The mixer
/// avalanches both halves so adjacent R4 cells land in independent
/// buckets. Constants are the published SplitMix64 mixers.
fn shuffle_bucket(r4: u64) -> u64 {
    let mut x = r4;
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    let mixed = x ^ (x >> 31);
    mixed % SHUFFLE_HASH_BUCKETS
}

fn r4_of_midpoint(seg: &FlightSegment) -> Option<u64> {
    let (mid_lat, mid_lon) =
        midpoint(seg.start_lat, seg.start_lon, seg.end_lat, seg.end_lon);
    lat_lon_to_cell(mid_lat as f64, mid_lon as f64, Resolution::Four).map(u64::from)
}

fn phase_name(phase: Phase) -> Option<&'static str> {
    match phase {
        Phase::Airborne => Some("airborne"),
        Phase::Ground => Some("ground"),
        _ => None,
    }
}

fn pass_a_path(temp_dir: &Path, phase: &str, hash: u64, day_stem: &str) -> PathBuf {
    temp_dir
        .join(phase)
        .join(format!("hash_{hash:03x}"))
        .join(format!("day_{day_stem}.arrow"))
}

fn pass_a_bucket_dir(temp_dir: &Path, phase: &str, hash: u64) -> PathBuf {
    temp_dir.join(phase).join(format!("hash_{hash:03x}"))
}

/// Shuffle Stage 1 per-day shards into per-R4 shards for Stages 1.5 /
/// 2A / 2C. Output layout:
///
/// ```text
/// <out_dir>/<R4>/airborne.arrow
/// <out_dir>/<R4>/ground.arrow
/// ```
///
/// `scope`, when set, drops out-of-scope R4s during Pass A so they
/// never hit disk. Cleanup of the temp scratch dir is best-effort —
/// the next run's `if exists` wipe at start handles a crash mid-merge.
pub fn shuffle_per_r4(
    day_paths: &[PathBuf],
    out_dir: &Path,
    scope: Option<&ScopeBbox>,
) -> Result<()> {
    let temp_dir = out_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("out_dir has no parent for temp_shuffle sibling"))?
        .join("temp_shuffle");
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir)?;
    }
    // Wipe `out_dir` too: stale `<R4>/{airborne,ground}.arrow` from a
    // crashed previous run or a narrower-scope rerun would otherwise
    // leak into Stage 1.5/2A/2C as zombie data (list_r4_shards has no
    // way to know which shards belong to the current scope).
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir)?;
    }
    for phase in ["airborne", "ground"] {
        for h in 0..SHUFFLE_HASH_BUCKETS {
            std::fs::create_dir_all(pass_a_bucket_dir(&temp_dir, phase, h))?;
        }
    }
    std::fs::create_dir_all(out_dir)?;

    eprintln!("[shuffle] passA over {} days", day_paths.len());
    let pass_a_start = std::time::Instant::now();
    pass_a(day_paths, &temp_dir, scope)?;
    eprintln!("[shuffle] passA done in {:?}", pass_a_start.elapsed());

    eprintln!("[shuffle] passB → {}", out_dir.display());
    let pass_b_start = std::time::Instant::now();
    pass_b(&temp_dir, out_dir)?;
    eprintln!("[shuffle] passB done in {:?}", pass_b_start.elapsed());

    let _ = std::fs::remove_dir_all(&temp_dir);
    Ok(())
}

fn pass_a(day_paths: &[PathBuf], temp_dir: &Path, scope: Option<&ScopeBbox>) -> Result<()> {
    day_paths.par_iter().try_for_each(|day_path| -> Result<()> {
        let segments = read_segments(day_path)
            .with_context(|| format!("read {}", day_path.display()))?;
        let day_stem = day_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow::anyhow!("missing file stem: {}", day_path.display()))?;

        let mut buckets: HashMap<(&'static str, u64), Vec<FlightSegment>> = HashMap::new();
        for seg in segments {
            let Some(phase) = phase_name(seg.phase) else {
                continue;
            };
            let Some(r4) = r4_of_midpoint(&seg) else {
                continue;
            };
            if let Some(s) = scope {
                if !s.contains_r4(r4) {
                    continue;
                }
            }
            buckets
                .entry((phase, shuffle_bucket(r4)))
                .or_default()
                .push(seg);
        }

        // Sequential per-bucket write — paths are unique per
        // (phase, hash, day) so no worker writes the same file.
        for ((phase, hash), segs) in buckets {
            write_segments(&pass_a_path(temp_dir, phase, hash, day_stem), &segs)?;
        }
        Ok(())
    })
}

fn pass_b(temp_dir: &Path, out_dir: &Path) -> Result<()> {
    let phases = ["airborne", "ground"];
    (0..SHUFFLE_HASH_BUCKETS)
        .into_par_iter()
        .try_for_each(|hash| -> Result<()> {
            for phase in phases {
                let parts = list_pass_a_parts(&pass_a_bucket_dir(temp_dir, phase, hash))?;
                if parts.is_empty() {
                    continue;
                }
                let mut by_r4: HashMap<u64, Vec<FlightSegment>> = HashMap::new();
                for part in &parts {
                    let segs = read_segments(part)
                        .with_context(|| format!("read {}", part.display()))?;
                    for seg in segs {
                        let Some(r4) = r4_of_midpoint(&seg) else {
                            continue;
                        };
                        by_r4.entry(r4).or_default().push(seg);
                    }
                }
                for (r4, segs) in by_r4 {
                    let r4_dir = out_dir.join(r4_hex_str(r4));
                    std::fs::create_dir_all(&r4_dir)?;
                    write_segments(&r4_dir.join(format!("{phase}.arrow")), &segs)?;
                }
            }
            Ok(())
        })
}

/// Walk `<segments_by_r4_dir>/<R4>/<shard_name>` for in-scope R4s —
/// the dual of `shuffle_per_r4`'s output. Stage 1.5 / 2A / 2C each call
/// this once per stage to drive their per-R4 par_iter.
pub fn list_r4_shards(
    segments_by_r4_dir: &Path,
    shard_name: &str,
    scope: Option<&ScopeBbox>,
) -> Result<Vec<(u64, PathBuf)>> {
    let read = match std::fs::read_dir(segments_by_r4_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(e).with_context(|| {
                format!("read_dir {}", segments_by_r4_dir.display())
            })
        }
    };
    let mut out = Vec::new();
    for entry in read {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(r4) = u64::from_str_radix(name, 16) else {
            continue;
        };
        if let Some(s) = scope {
            if !s.contains_r4(r4) {
                continue;
            }
        }
        let shard = path.join(shard_name);
        if shard.exists() {
            out.push((r4, shard));
        }
    }
    Ok(out)
}

fn list_pass_a_parts(dir: &Path) -> Result<Vec<PathBuf>> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read_dir {}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in read {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("arrow") {
            out.push(path);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flight::Phase;

    fn seg(flight_id: u64, phase: Phase, lat: f32, lon: f32) -> FlightSegment {
        FlightSegment {
            callsign: format!("FL{flight_id:04}"),
            aircraft_type: [b'A', b'3', b'2', b'0'],
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
        }
    }

    #[test]
    fn round_trip_airborne_and_ground() {
        let tmp = tempfile::tempdir().unwrap();
        let segments_dir = tmp.path().join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();
        // One day with mixed phases at one location; cruise is dropped
        // by shuffle.
        let day_path = segments_dir.join("2025-01-21.arrow");
        write_segments(
            &day_path,
            &[
                seg(1, Phase::Airborne, 50.10, 14.26),
                seg(2, Phase::Ground, 50.10, 14.26),
                seg(3, Phase::Cruise, 50.10, 14.26),
            ],
        )
        .unwrap();

        let out_dir = tmp.path().join("segments_by_r4");
        shuffle_per_r4(&[day_path], &out_dir, None).unwrap();

        // temp_shuffle must be cleaned up.
        assert!(!tmp.path().join("temp_shuffle").exists());
        // Exactly one R4 directory should contain both shards.
        let r4_dirs: Vec<_> = std::fs::read_dir(&out_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        assert_eq!(r4_dirs.len(), 1);
        let dir = r4_dirs[0].path();
        let airborne = read_segments(&dir.join("airborne.arrow")).unwrap();
        let ground = read_segments(&dir.join("ground.arrow")).unwrap();
        assert_eq!(airborne.len(), 1);
        assert_eq!(ground.len(), 1);
        assert_eq!(airborne[0].flight_id, 1);
        assert_eq!(ground[0].flight_id, 2);
        // Cruise must NOT appear in either shard.
    }

    #[test]
    fn scope_filters_out_of_scope_r4s() {
        let tmp = tempfile::tempdir().unwrap();
        let segments_dir = tmp.path().join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();
        let day_path = segments_dir.join("2025-01-21.arrow");
        write_segments(
            &day_path,
            &[
                seg(1, Phase::Airborne, 50.10, 14.26), // CZ
                seg(2, Phase::Airborne, 35.0, 139.0),  // Tokyo — out of scope
            ],
        )
        .unwrap();

        let out_dir = tmp.path().join("segments_by_r4");
        let scope = ScopeBbox::parse("48.65,12.00,51.55,16.90").unwrap();
        shuffle_per_r4(&[day_path], &out_dir, Some(&scope)).unwrap();

        // Only the CZ R4 must appear.
        let r4_dirs: Vec<_> = std::fs::read_dir(&out_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        assert_eq!(r4_dirs.len(), 1);
        let airborne =
            read_segments(&r4_dirs[0].path().join("airborne.arrow")).unwrap();
        assert_eq!(airborne.len(), 1);
        assert_eq!(airborne[0].flight_id, 1);
    }

    #[test]
    fn empty_input_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let out_dir = tmp.path().join("segments_by_r4");
        shuffle_per_r4(&[], &out_dir, None).unwrap();
        assert!(out_dir.exists(), "out_dir must be created");
        // No R4 subdirs.
        let count = std::fs::read_dir(&out_dir).unwrap().count();
        assert_eq!(count, 0);
        assert!(!tmp.path().join("temp_shuffle").exists());
    }
}
