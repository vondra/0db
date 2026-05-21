//! `aircraft-extract` CLI — driver that walks Stage 0..2C end to end
//! per day. Subcommands let an operator re-run any single stage from
//! its persisted input artifact (re-run Stage 1 without re-doing
//! Stage 0; re-run Stage 2A/2B/2C without re-running Stage 1, …).

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use aircraft_extract::airport_io::{read_global_airport_lines, read_global_airports};
use aircraft_extract::arrow_io::read_record_batches;
use aircraft_extract::source::FlightSource;
use aircraft_extract::source_adsb_tar::AdsbTarSource;
use aircraft_extract::stage_0::run_stage_0;
use aircraft_extract::stage_1::{read_flights, run_stage_1};
use aircraft_extract::scope::ScopeBbox;
use aircraft_extract::stage_2a::run_stage_2a;
use aircraft_extract::stage_2b::run_stage_2b;
use aircraft_extract::stage_2c::run_stage_2c;
use aircraft_extract::stage_airport_discover_runner::run_stage_airport_discover;
use raster_reader::RealRasters;
use rayon::iter::Either;
use rayon::prelude::*;

#[derive(Parser)]
#[command(name = "aircraft-extract", about = "Aircraft pipeline driver")]
struct Cli {
    /// Cap rayon's global thread pool. Set when per-task RAM peak
    /// (decoded day ~1.5 GB, worst-R4 working set ~2 GB) × all cores
    /// exceeds host RAM — e.g. `--max-threads 20` on a 90 GB / 24-core
    /// box keeps any one stage below ~80 GB peak. Omit to keep rayon's
    /// default (honours `RAYON_NUM_THREADS` or `available_parallelism()`).
    #[arg(long, global = true)]
    max_threads: Option<NonZeroUsize>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Stage 0: ADS-B TAR → flights/<day>.arrow
    Stage0 {
        #[arg(long)]
        adsb_cache: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        day: String,
    },
    /// Stage 1: flights → segments/<day>.arrow
    Stage1 {
        #[arg(long)]
        flights_dir: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        day: String,
        #[arg(long)]
        prepared_dir: PathBuf,
    },
    /// Shuffle: segments/<day>.arrow → per-R4 airborne/ground shards
    Shuffle {
        /// Dir containing Stage 1's `segments/<day>.arrow` outputs.
        #[arg(long)]
        segments_dir: PathBuf,
        /// Output dir for `<R4>/{airborne,ground}.arrow` per-R4 shards.
        #[arg(long)]
        out_dir: PathBuf,
        #[arg(long)]
        scope_bbox: Option<String>,
    },
    /// Stage 2A: per-R4 airborne shards → per-R4 airborne.arrow
    Stage2a {
        /// Dir containing the shuffle output `<R4>/airborne.arrow`.
        #[arg(long)]
        segments_by_r4: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        /// `data/prepared` root — Stage 2A samples per-sub-segment
        /// midpoint DEM elevation here (v15 Opt A). Same path Stage 1
        /// receives; reuse to share the tile cache when calling stages
        /// in sequence (`run-all` does this implicitly).
        #[arg(long)]
        prepared_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
        /// Optional `min_lat,min_lon,max_lat,max_lon` bbox — required
        /// when the upstream segments came from a bbox/radius subset
        /// cache. See `RunAll::scope_bbox` for full rationale.
        #[arg(long)]
        scope_bbox: Option<String>,
    },
    /// Stage 2B: per-day segments shards → per-R4 cruise.arrow
    Stage2b {
        /// Dir containing Stage 1's `segments/<day>.arrow` outputs.
        #[arg(long)]
        segments_dir: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
        #[arg(long)]
        scope_bbox: Option<String>,
    },
    /// Stage 2C: per-R4 ground shards → per-R4 airport_traffic.arrow
    Stage2c {
        /// Dir containing the shuffle output `<R4>/ground.arrow`.
        #[arg(long)]
        segments_by_r4: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
        #[arg(long)]
        scope_bbox: Option<String>,
    },
    /// Run every stage end-to-end for a list of days.
    RunAll {
        #[arg(long)]
        adsb_cache: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long)]
        prepared_dir: PathBuf,
        /// Working directory for intermediate Stage 0/1 artifacts.
        #[arg(long)]
        work_dir: PathBuf,
        #[arg(long, value_delimiter = ',')]
        days: Vec<String>,
        /// Optional `min_lat,min_lon,max_lat,max_lon` bbox.
        /// Required when `--adsb-cache` points at a bbox/radius
        /// subset (Canary, Praha-150km, etc.) — those caches keep
        /// full daily traces for any flight that entered the
        /// filter, so without scope filtering Stage 2A/2B/2C would
        /// overwrite global R4 files with those out-of-scope
        /// trajectories.
        #[arg(long)]
        scope_bbox: Option<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    init_rayon_pool(cli.max_threads)?;
    match cli.cmd {
        Cmd::Stage0 { adsb_cache, out, day } => {
            std::fs::create_dir_all(&out)?;
            let sources: Vec<Box<dyn FlightSource>> = vec![Box::new(AdsbTarSource::new(adsb_cache))];
            let n = run_stage_0(&sources, &day, &out)?;
            eprintln!("[stage0] {day}: {n} flights");
        }
        Cmd::Stage1 { flights_dir, out, day, prepared_dir } => {
            std::fs::create_dir_all(&out)?;
            let rasters = RealRasters::new(&prepared_dir);
            let n = run_stage_1(&flights_dir, &out, &day, &rasters)?;
            eprintln!("[stage1] {day}: {n} segments");
        }
        Cmd::Shuffle { segments_dir, out_dir, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            let day_paths = list_segments_day_paths(&segments_dir)?;
            aircraft_extract::shuffle::shuffle_per_r4(&day_paths, &out_dir, scope.as_ref())?;
            eprintln!("[shuffle] {} day shards → {}", day_paths.len(), out_dir.display());
        }
        Cmd::Stage2a {
            segments_by_r4,
            h3r4_dir,
            prepared_dir,
            n_days,
            scope_bbox,
        } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-by-r4", &segments_by_r4)?;
            let rasters = RealRasters::new(&prepared_dir);
            let n = run_stage_2a(&segments_by_r4, &h3r4_dir, n_days, scope.as_ref(), &rasters)?;
            eprintln!("[stage2a] {n} R4 hexes written");
        }
        Cmd::Stage2b { segments_dir, h3r4_dir, n_days, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-dir", &segments_dir)?;
            let day_paths = list_segments_day_paths(&segments_dir)?;
            let n = run_stage_2b(&day_paths, &h3r4_dir, n_days, scope.as_ref())?;
            eprintln!("[stage2b] {n} R4 hexes written");
        }
        Cmd::Stage2c { segments_by_r4, h3r4_dir, n_days, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-by-r4", &segments_by_r4)?;
            let areas = read_global_airports(&h3r4_dir)
                .with_context(|| format!("read airport_areas.arrow from {}", h3r4_dir.display()))?;
            eprintln!(
                "[stage2c] loaded {} aerodrome polygons globally",
                areas.len()
            );
            let n = run_stage_2c(&segments_by_r4, &areas, &h3r4_dir, n_days, scope.as_ref())?;
            eprintln!("[stage2c] {n} R4 hexes written");
        }
        Cmd::RunAll {
            adsb_cache,
            h3r4_dir,
            prepared_dir,
            work_dir,
            days,
            scope_bbox,
        } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_scope_for_subset_cache(&adsb_cache, scope.as_ref())?;
            if let Some(s) = scope.as_ref() {
                eprintln!(
                    "[run-all] scope bbox: lat {}..{}, lon {}..{}",
                    s.min_lat, s.max_lat, s.min_lon, s.max_lon
                );
            }
            let flights_dir = work_dir.join("flights");
            let segments_dir = work_dir.join("segments");
            std::fs::create_dir_all(&flights_dir)?;
            std::fs::create_dir_all(&segments_dir)?;

            // Dedup before par_iter — Stage 0/1 write fixed paths
            // (flights/<day>.arrow, segments/<day>.arrow) per day, so
            // duplicates would race on the same output file.
            let mut days_dedup = days.clone();
            days_dedup.sort();
            days_dedup.dedup();
            if days_dedup.len() != days.len() {
                eprintln!(
                    "[run-all] duplicate days dropped: {} → {} unique",
                    days.len(),
                    days_dedup.len()
                );
            }
            let days = days_dedup;

            let sources: Vec<Box<dyn FlightSource>> =
                vec![Box::new(AdsbTarSource::new(&adsb_cache))];
            let n_days = days.len() as u16;

            // Shared instance — TileStore is per-slot Mutex +
            // Arc<RawTile>, safe to fan out under par_iter.
            let rasters = RealRasters::new(&prepared_dir);

            // Per-day error tolerance: one corrupted TAR or DEM miss
            // must not throw away the other days' Stage 0+1 work.
            // Failed days are listed at the end so the operator can
            // rerun with `--days <failed,…>`.
            let (ok_paths, failed_days): (Vec<PathBuf>, Vec<String>) = days
                .par_iter()
                .partition_map(|day| {
                    let segments_path = segments_dir.join(format!("{day}.arrow"));
                    match run_day(day, &sources, &flights_dir, &segments_dir, &rasters) {
                        Ok(()) if segments_path.exists() => Either::Left(segments_path),
                        Ok(()) => {
                            eprintln!("[run-all] {day}: FAILED — no segments file produced");
                            Either::Right(day.clone())
                        }
                        Err(e) => {
                            eprintln!("[run-all] {day}: FAILED stage0/1 — {e}, skipping");
                            Either::Right(day.clone())
                        }
                    }
                });

            if !failed_days.is_empty() {
                eprintln!(
                    "[run-all] {} day(s) failed: {} — Stage 2 runs on the rest; rerun with --days {} to retry",
                    failed_days.len(),
                    failed_days.join(","),
                    failed_days.join(",")
                );
            }

            // Read the global aerodrome set once. Stage 1.5
            // (`run_stage_airport_discover`) uses it for the
            // polygon-radius-aware re-attribution / reject pass on
            // DBSCAN clusters; Stage 2C reuses the same vec for its
            // `nearest_aerodrome_within` resolver. Airport identity
            // must stay global — aerodromes straddle R4 boundaries.
            let areas = read_global_airports(&h3r4_dir)?;
            eprintln!("[run-all] global aerodromes: {} polygons", areas.len());
            let global_lines = read_global_airport_lines(&h3r4_dir)?;
            eprintln!(
                "[run-all] global airport lines: {} microsegments",
                global_lines.len()
            );

            // Shuffle Stage 1 per-day shards into per-R4
            // `segments_by_r4/<R4>/{airborne,ground}.arrow`. Stages 1.5
            // / 2A / 2C all consume these; Stage 2B reads the per-day
            // shards directly (cruise straddles R4 boundaries).
            let by_r4_dir = work_dir.join("segments_by_r4");
            let t_shuf = Instant::now();
            aircraft_extract::shuffle::shuffle_per_r4(&ok_paths, &by_r4_dir, scope.as_ref())?;
            let t1_5 = Instant::now();
            eprintln!("[run-all] shuffle done ({:?})", t1_5 - t_shuf);

            // Stage 1.5 — DBSCAN auto-discovery of OSM-missing
            // airfields. Runs BEFORE Stage 2C so its synth sidecars
            // are visible when Stage 2C loads each R4's airport_lines
            // cache. Writes empty arrows for in-scope R4s with no
            // current clusters so a stale strip cannot leak through.
            let r1_5 = run_stage_airport_discover(
                &by_r4_dir,
                &areas,
                &global_lines,
                &h3r4_dir,
                scope.as_ref(),
            )?;
            let t2a = Instant::now();
            eprintln!(
                "[run-all] stage1.5 R4s with synth lines={r1_5} ({:?})",
                t2a - t1_5
            );

            let r2a = run_stage_2a(&by_r4_dir, &h3r4_dir, n_days, scope.as_ref(), &rasters)?;
            let t2b = Instant::now();
            // Stage 2B reads per-day cruise shards, NOT the shuffled
            // per-R4 ones — cruise output R4 derives from each
            // touched R8's parent (`stage_2b.rs:cell.parent(R4)`).
            let r2b = run_stage_2b(&ok_paths, &h3r4_dir, n_days, scope.as_ref())?;
            let t2c = Instant::now();
            let r2c = run_stage_2c(&by_r4_dir, &areas, &h3r4_dir, n_days, scope.as_ref())?;
            let t_end = Instant::now();
            eprintln!(
                "[run-all] stage2a={r2a} ({:?}), stage2b={r2b} ({:?}), stage2c={r2c} ({:?})",
                t2b - t2a,
                t2c - t2b,
                t_end - t2c
            );

            // Best-effort cleanup of the per-R4 shuffle scratch dir.
            // A crash mid-stage leaves it on disk; the next run's
            // shuffle wipes it before recreating.
            let _ = std::fs::remove_dir_all(&by_r4_dir);
        }
    }
    Ok(())
}

/// Fail loud when an operator runs a Stage 2 subcommand against a
/// missing input dir — a typo or a failed upstream shuffle would
/// otherwise become a silent no-op and leave stale `h3r4` outputs in
/// place (`list_r4_shards` swallows NotFound by design for RunAll).
fn require_input_dir_exists(flag: &str, dir: &Path) -> Result<()> {
    if !dir.exists() {
        return Err(anyhow::anyhow!(
            "{flag} {} does not exist — did the upstream shuffle / Stage 1 run?",
            dir.display()
        ));
    }
    if !dir.is_dir() {
        return Err(anyhow::anyhow!(
            "{flag} {} is not a directory",
            dir.display()
        ));
    }
    Ok(())
}

/// Collect `segments/<day>.arrow` paths from a directory, sorted by
/// filename. Subcommand input for Stage 2B and Shuffle.
fn list_segments_day_paths(segments_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(segments_dir)
        .with_context(|| format!("read_dir {}", segments_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("arrow"))
        .collect();
    out.sort();
    Ok(out)
}

/// Shared `--scope-bbox` parser, identical surface across Stage2 + RunAll.
fn parse_scope(s: Option<&str>) -> Result<Option<ScopeBbox>> {
    s.map(ScopeBbox::parse)
        .transpose()
        .map_err(|e| anyhow::anyhow!("--scope-bbox: {e}"))
}

fn init_rayon_pool(max_threads: Option<NonZeroUsize>) -> Result<()> {
    let Some(n) = max_threads else { return Ok(()) };
    rayon::ThreadPoolBuilder::new().num_threads(n.get()).build_global()?;
    eprintln!("[rayon] global pool = {} threads", n);
    Ok(())
}

/// Hard-fail when `--adsb-cache` points at a bbox/radius subset path
/// and the operator forgot `--scope-bbox`. The subset caches keep
/// whole daily traces for any in-scope flight; without a scope filter
/// Stage 2A/2B/2C would silently overwrite global R4 files with those
/// out-of-scope trajectories — the exact corruption that bit us when
/// the first Canary re-extract overwrote 95 Praha `841e3*` R4s.
fn require_scope_for_subset_cache(
    adsb_cache: &std::path::Path,
    scope: Option<&ScopeBbox>,
) -> Result<()> {
    if scope.is_some() {
        return Ok(());
    }
    let s = adsb_cache.to_string_lossy();
    if s.contains("/bbox/") || s.contains("/radius/") {
        return Err(anyhow::anyhow!(
            "--adsb-cache {} looks like a subset cache (path contains /bbox/ or \
             /radius/) but --scope-bbox is not set. Either pass --scope-bbox \
             min_lat,min_lon,max_lat,max_lon matching the subset filter, or \
             point --adsb-cache at the global archive root.",
            s
        ));
    }
    Ok(())
}

/// Run Stage 0 + Stage 1 for a single day. Lifted out of `RunAll` so
/// the per-day try/log/continue caller stays a flat `match` instead of
/// a `Result`-returning IIFE.
fn run_day(
    day: &str,
    sources: &[Box<dyn FlightSource>],
    flights_dir: &Path,
    segments_dir: &Path,
    rasters: &RealRasters,
) -> Result<()> {
    let t0 = Instant::now();
    let n0 = run_stage_0(sources, day, flights_dir)?;
    let t_stage0 = Instant::now();
    let n1 = run_stage_1(flights_dir, segments_dir, day, rasters)?;
    eprintln!(
        "[run-all] {day}: stage0={n0} ({:?}) stage1={n1} ({:?})",
        t_stage0 - t0,
        Instant::now() - t_stage0
    );
    Ok(())
}

#[allow(dead_code)]
fn _unused_paths() -> (PathBuf, &'static Path) {
    let p = PathBuf::new();
    let _ = read_record_batches(&p);
    let _ = read_flights(&p);
    (p, Path::new(""))
}
