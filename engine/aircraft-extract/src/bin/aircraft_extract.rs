//! `aircraft-extract` CLI — driver that walks Stage 0..2C end to end
//! per day. Subcommands let an operator re-run any single stage from
//! its persisted input artifact (re-run Stage 1 without re-doing
//! Stage 0; re-run Stage 2A/2B/2C without re-running Stage 1, …).

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use aircraft_extract::airport_io::read_global_airports;
use aircraft_extract::arrow_io::read_record_batches;
use aircraft_extract::source::FlightSource;
use aircraft_extract::source_adsb_tar::AdsbTarSource;
use aircraft_extract::stage_0::run_stage_0;
use aircraft_extract::stage_1::{read_flights, run_stage_1};
use aircraft_extract::stage_2a::run_stage_2a;
use aircraft_extract::stage_2b::run_stage_2b;
use aircraft_extract::stage_2c::run_stage_2c;

#[derive(Parser)]
#[command(name = "aircraft-extract", about = "Aircraft pipeline driver")]
struct Cli {
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
    /// Stage 2A: segments → per-R4 airborne.arrow
    Stage2a {
        #[arg(long)]
        segments: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
    },
    /// Stage 2B: segments → per-R4 cruise.arrow
    Stage2b {
        #[arg(long)]
        segments: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
    },
    /// Stage 2C: segments → per-R4 ground.arrow
    Stage2c {
        #[arg(long)]
        segments: PathBuf,
        #[arg(long)]
        h3r4_dir: PathBuf,
        #[arg(long)]
        prepared_dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        n_days: u16,
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
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Stage0 { adsb_cache, out, day } => {
            std::fs::create_dir_all(&out)?;
            let sources: Vec<Box<dyn FlightSource>> = vec![Box::new(AdsbTarSource::new(adsb_cache))];
            let n = run_stage_0(&sources, &day, &out)?;
            eprintln!("[stage0] {day}: {n} flights");
        }
        Cmd::Stage1 { flights_dir, out, day, prepared_dir } => {
            std::fs::create_dir_all(&out)?;
            let n = run_stage_1(&flights_dir, &out, &day, &prepared_dir)?;
            eprintln!("[stage1] {day}: {n} segments");
        }
        Cmd::Stage2a { segments, h3r4_dir, n_days } => {
            let segs = aircraft_extract::arrow_io::read_segments(&segments)
                .with_context(|| format!("read {}", segments.display()))?;
            let n = run_stage_2a(&segs, &h3r4_dir, n_days)?;
            eprintln!("[stage2a] {n} R4 hexes written");
        }
        Cmd::Stage2b { segments, h3r4_dir, n_days } => {
            let segs = aircraft_extract::arrow_io::read_segments(&segments)
                .with_context(|| format!("read {}", segments.display()))?;
            let n = run_stage_2b(&segs, &h3r4_dir, n_days)?;
            eprintln!("[stage2b] {n} R4 hexes written");
        }
        Cmd::Stage2c { segments, h3r4_dir, prepared_dir, n_days } => {
            let segs = aircraft_extract::arrow_io::read_segments(&segments)
                .with_context(|| format!("read {}", segments.display()))?;
            let rasters = raster_reader::RealRasters::new(&prepared_dir);
            let areas = read_global_airports(&h3r4_dir)
                .with_context(|| format!("read airport_areas.arrow from {}", h3r4_dir.display()))?;
            eprintln!(
                "[stage2c] loaded {} aerodrome polygons globally",
                areas.len()
            );
            let n = run_stage_2c(&segs, &areas, &h3r4_dir, &rasters, n_days)?;
            eprintln!("[stage2c] {n} R4 hexes written");
        }
        Cmd::RunAll {
            adsb_cache,
            h3r4_dir,
            prepared_dir,
            work_dir,
            days,
        } => {
            let flights_dir = work_dir.join("flights");
            let segments_dir = work_dir.join("segments");
            std::fs::create_dir_all(&flights_dir)?;
            std::fs::create_dir_all(&segments_dir)?;

            let sources: Vec<Box<dyn FlightSource>> =
                vec![Box::new(AdsbTarSource::new(&adsb_cache))];
            let n_days = days.len() as u16;
            let mut all_segments = Vec::new();
            // Per-day error tolerance: one corrupted TAR or DEM miss
            // must not throw away the other 364 days' Stage 0+1 work.
            // Failed days are listed at the end so the operator can
            // rerun with `--days <failed,…>`.
            let mut failed_days: Vec<String> = Vec::new();
            for day in &days {
                match run_day(day, &sources, &flights_dir, &segments_dir, &prepared_dir) {
                    Ok(()) => match aircraft_extract::arrow_io::read_segments(
                        &segments_dir.join(format!("{day}.arrow")),
                    ) {
                        Ok(segs) => all_segments.extend(segs),
                        Err(e) => {
                            eprintln!("[run-all] {day}: FAILED to read segments — {e}");
                            failed_days.push(day.clone());
                        }
                    },
                    Err(e) => {
                        eprintln!("[run-all] {day}: FAILED stage0/1 — {e}, skipping");
                        failed_days.push(day.clone());
                    }
                }
            }
            if !failed_days.is_empty() {
                eprintln!(
                    "[run-all] {} day(s) failed: {} — Stage 2 runs on the rest; rerun with --days {} to retry",
                    failed_days.len(),
                    failed_days.join(","),
                    failed_days.join(",")
                );
            }

            let t2a = Instant::now();
            let r2a = run_stage_2a(&all_segments, &h3r4_dir, n_days)?;
            let t2b = Instant::now();
            let r2b = run_stage_2b(&all_segments, &h3r4_dir, n_days)?;
            let t2c = Instant::now();
            let rasters = raster_reader::RealRasters::new(&prepared_dir);
            let areas = read_global_airports(&h3r4_dir)?;
            eprintln!(
                "[run-all] stage2c airports: {} aerodrome polygons",
                areas.len()
            );
            let r2c = run_stage_2c(&all_segments, &areas, &h3r4_dir, &rasters, n_days)?;
            let t_end = Instant::now();
            eprintln!(
                "[run-all] stage2a={r2a} ({:?}), stage2b={r2b} ({:?}), stage2c={r2c} ({:?})",
                t2b - t2a,
                t2c - t2b,
                t_end - t2c
            );
        }
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
    prepared_dir: &Path,
) -> Result<()> {
    let t0 = Instant::now();
    let n0 = run_stage_0(sources, day, flights_dir)?;
    let t_stage0 = Instant::now();
    let n1 = run_stage_1(flights_dir, segments_dir, day, prepared_dir)?;
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
