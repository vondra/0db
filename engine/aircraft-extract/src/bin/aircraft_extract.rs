//! `aircraft-extract` CLI — driver that walks Stage 0..2C end to end
//! per day. Subcommands let an operator re-run any single stage from
//! its persisted input artifact (re-run Stage 1 without re-doing
//! Stage 0; re-run Stage 2A/2B/2C without re-running Stage 1, …).

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};

use aircraft_extract::airport_index::AerodromeIndex;
use aircraft_extract::airport_io::{read_global_airport_lines, read_global_airports};
use aircraft_extract::progress::ts;
use aircraft_extract::source::FlightSource;
use aircraft_extract::source_adsb_tar::{AdsbTarSource, ClassWindowFilter};
use aircraft_extract::stage_0::run_stage_0;
use aircraft_extract::stage_1::run_stage_1;
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

/// Entry stage for `run-all`. Variants are declared in pipeline order
/// (Stage 0 → 2C); `PartialOrd`/`Ord` compare by that order so the
/// dispatcher can ask `from_stage <= FromStage::Shuffle` to decide
/// whether to execute each phase. Stage reuse skips every phase whose
/// output already exists on disk under `--work-dir`.
///
/// Required inputs under `--work-dir` per variant (output of an earlier
/// stage that we expect the operator's prior run to have produced):
///
/// | Variant   | flights/ | segments/ | segments_by_r4/ |
/// |-----------|----------|-----------|-----------------|
/// | Stage0    | —        | —         | —               |
/// | Stage1    | yes      | —         | —               |
/// | Shuffle   | —        | yes       | —               |
/// | Stage1_5  | —        | yes       | yes             |
/// | Stage2a   | —        | yes       | yes             |
/// | Stage2b   | —        | yes       | yes             |
/// | Stage2c   | —        | —         | yes             |
#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, PartialOrd, Ord)]
enum FromStage {
    /// Full pipeline: Stage 0 (ADS-B TAR decode) onward. Default.
    Stage0,
    /// Skip Stage 0; reuse `<work-dir>/flights/<day>.arrow`.
    Stage1,
    /// Skip Stage 0+1; reuse `<work-dir>/segments/<day>.arrow`.
    Shuffle,
    /// Skip Stage 0+1+shuffle; reuse `<work-dir>/{segments,segments_by_r4}/`.
    Stage1_5,
    /// Skip everything before Stage 2A; reuse `<work-dir>/{segments,segments_by_r4}/`.
    Stage2a,
    /// Skip everything before Stage 2B; reuse `<work-dir>/{segments,segments_by_r4}/`.
    /// Stage 2B reads per-day cruise shards from `segments/`; Stage 2C reads `segments_by_r4/`.
    Stage2b,
    /// Skip everything before Stage 2C; reuse `<work-dir>/segments_by_r4/`.
    Stage2c,
}

/// Which ADS-B network the `--adsb-cache` holds. Both ship the identical readsb
/// `trace_full` TAR format, so this only stamps the provenance `source_id` (and
/// dedup identity). The per-feed default cache PATH lives in
/// `run-aircraft-extract.sh`.
#[derive(Clone, Copy, Debug, ValueEnum)]
enum Feed {
    Adsblol,
    Adsbexchange,
}

impl Feed {
    fn source_id(self) -> u8 {
        use aircraft_extract::flight::source_id;
        match self {
            Feed::Adsblol => source_id::ADSB_LOL_TAR,
            Feed::Adsbexchange => source_id::ADSB_EXCHANGE,
        }
    }
}

/// CLI surface (`all|ga|non-ga`) for the hybrid Stage-0 class-window
/// filter (`ga-365d-hybrid-plan.md` §3). `all` keeps every trace —
/// byte-identical to the pre-hybrid single-window extract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum ClassFilterArg {
    All,
    Ga,
    NonGa,
}

impl ClassFilterArg {
    fn window(self) -> ClassWindowFilter {
        match self {
            ClassFilterArg::All => ClassWindowFilter::All,
            ClassFilterArg::Ga => ClassWindowFilter::GaOnly,
            ClassFilterArg::NonGa => ClassWindowFilter::NonGa,
        }
    }

    /// Stage 0/1 per-day RAM estimate (GB) for `max_concurrent_days`.
    /// GA-filtered days decode to a small fraction of a full day (only
    /// PROP_C172 + HELICOPTER traces survive the prefix probe), so the
    /// full-day 28 GB calibration would throttle the 365-day GA pass
    /// to 2 concurrent days for no RAM benefit
    /// (`ga-365d-hybrid-plan.md` §4.2.7).
    fn stage01_peak_per_day_gb(self) -> f64 {
        match self {
            ClassFilterArg::Ga => 6.0,
            ClassFilterArg::All | ClassFilterArg::NonGa => 28.0,
        }
    }
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
        /// Hybrid class-window pass (`ga-365d-hybrid-plan.md` §3).
        #[arg(long, value_enum, default_value_t = ClassFilterArg::All)]
        class_filter: ClassFilterArg,
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
        /// Dir(s) containing Stage 1's `segments/<day>.arrow` outputs
        /// (repeatable; the primary/airline window — counted into the
        /// `n_days` manifest).
        #[arg(long, required = true)]
        segments_dir: Vec<PathBuf>,
        /// GA-pass `segments/<day>.arrow` dir(s) for hybrid extracts —
        /// shuffled under a distinct pass key and counted into the
        /// `ga_n_days` manifest (`ga-365d-hybrid-plan.md` §4.2.3).
        #[arg(long)]
        ga_segments_dir: Vec<PathBuf>,
        /// Output dir for `<R4>/{airborne,ground}.arrow` per-R4 shards.
        #[arg(long)]
        out_dir: PathBuf,
        #[arg(long)]
        scope_bbox: Option<String>,
    },
    /// Stage 1.5: per-R4 airfield discovery — DBSCAN-clusters ground
    /// vertices that don't snap to existing OSM aeroway lines, writes
    /// `<R4>/synth_airport_lines.arrow` + `synth_airport_areas.arrow`.
    /// Consumed by Stage 2C; runs BEFORE Stage 2A in the orchestrator.
    #[command(name = "stage1-5")]
    Stage1_5 {
        /// Dir containing the shuffle output `<R4>/ground.arrow`.
        #[arg(long)]
        segments_by_r4: PathBuf,
        /// h3r4 dir holding the global `airport_areas.arrow` /
        /// `airport_lines.arrow` (same dir written by `osm-extract`).
        #[arg(long)]
        h3r4_dir: PathBuf,
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
        /// Hard-fail when GA-class segments reach cruise (default:
        /// warn only — `ga-365d-hybrid-plan.md` binding delta 4).
        #[arg(long, default_value_t = false)]
        fail_on_ga_cruise: bool,
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
    /// Run every stage end-to-end for a list of days. REFUSES to start
    /// when `--work-dir` already contains populated stage artifacts
    /// from a previous run unless the operator passes `--from-stage`
    /// explicitly — the safety check exists because re-running the
    /// orchestrator with default `--from-stage stage0` would silently
    /// overwrite 1-3 hours of cached upstream work that the operator
    /// almost certainly meant to reuse. Prefer the per-stage
    /// subcommands (`stage0`, `stage1`, `shuffle`, `stage1-5`,
    /// `stage2a`, `stage2b`, `stage2c`) when iterating on one stage,
    /// and pass `--from-stage stageX` to keep using the orchestrator
    /// from a chosen entry point.
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
        /// Skip every phase before `<stage>` and reuse its persisted
        /// input artifact from `--work-dir`. One of:
        /// `stage0` (default — full pipeline), `stage1`, `shuffle`,
        /// `stage1-5`, `stage2a`, `stage2b`, `stage2c`. Use after an
        /// earlier `run-all` populated `--work-dir` to iterate on a
        /// downstream stage without re-running upstream work.
        #[arg(long, value_enum, default_value_t = FromStage::Stage0)]
        from_stage: FromStage,
        /// Stop after the named stage (inclusive; default `stage2c` =
        /// run to the end). The hybrid flow's per-pass invocations end
        /// at `--until-stage stage1`; a later merge invocation resumes
        /// with `--from-stage shuffle` (`ga-365d-hybrid-plan.md` §4.2).
        #[arg(long, value_enum, default_value_t = FromStage::Stage2c)]
        until_stage: FromStage,
        /// Which network `--adsb-cache` holds; stamps the provenance source_id
        /// (identical TAR format either way).
        #[arg(long, value_enum, default_value_t = Feed::Adsblol)]
        feed: Feed,
        /// Hybrid class-window pass for Stage 0 ingest: `ga` keeps only
        /// the 365-day-sampled GA/heli classes, `non-ga` the complement
        /// (incl. GSE). Default `all` = byte-identical single-window
        /// extract (`ga-365d-hybrid-plan.md` §3).
        #[arg(long, value_enum, default_value_t = ClassFilterArg::All)]
        class_filter: ClassFilterArg,
        /// Hybrid merge: the GA pass's `segments/` dir (per-day Stage 1
        /// shards). Shuffle unions both windows and writes the
        /// `ga_n_days` manifest next to `n_days`
        /// (`ga-365d-hybrid-plan.md` §4.2.3).
        #[arg(long)]
        ga_segments_dir: Option<PathBuf>,
        /// Hard-fail when GA-class segments reach Stage 2B / cruise
        /// (default: warn only — `ga-365d-hybrid-plan.md` delta 4).
        #[arg(long, default_value_t = false)]
        fail_on_ga_cruise: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    init_rayon_pool(cli.max_threads)?;
    match cli.cmd {
        Cmd::Stage0 { adsb_cache, out, day, class_filter } => {
            std::fs::create_dir_all(&out)?;
            let sources: Vec<Box<dyn FlightSource>> = vec![Box::new(
                AdsbTarSource::new(adsb_cache).with_class_filter(class_filter.window()),
            )];
            let n = run_stage_0(&sources, &day, &out)?;
            eprintln!("{} [stage0] {day}: {n} flights", ts());
        }
        Cmd::Stage1 { flights_dir, out, day, prepared_dir } => {
            std::fs::create_dir_all(&out)?;
            let rasters = RealRasters::new(&prepared_dir);
            let n = run_stage_1(&flights_dir, &out, &day, &rasters)?;
            eprintln!("{} [stage1] {day}: {n} segments", ts());
        }
        Cmd::Shuffle { segments_dir, ga_segments_dir, out_dir, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            let day_paths = list_segments_day_paths_multi(&segments_dir)?;
            let ga_day_paths = list_segments_day_paths_multi(&ga_segments_dir)?;
            aircraft_extract::shuffle::shuffle_per_r4(
                &day_paths,
                &ga_day_paths,
                &out_dir,
                scope.as_ref(),
            )?;
            eprintln!(
                "{} [shuffle] {} airline + {} GA day shards → {}",
                ts(),
                day_paths.len(),
                ga_day_paths.len(),
                out_dir.display()
            );
        }
        Cmd::Stage1_5 { segments_by_r4, h3r4_dir, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-by-r4", &segments_by_r4)?;
            let areas = read_global_airports(&h3r4_dir).with_context(|| {
                format!("read airport_areas.arrow from {}", h3r4_dir.display())
            })?;
            let lines = read_global_airport_lines(&h3r4_dir).with_context(|| {
                format!("read airport_lines.arrow from {}", h3r4_dir.display())
            })?;
            eprintln!(
                "{} [stage1.5] loaded {} aerodromes + {} airport lines globally",
                ts(),
                areas.len(),
                lines.len()
            );
            let aerodrome_index = AerodromeIndex::build(&areas);
            let n = run_stage_airport_discover(
                &segments_by_r4,
                &aerodrome_index,
                &lines,
                &h3r4_dir,
                scope.as_ref(),
            )?;
            eprintln!("{} [stage1.5] {n} R4s populated with synth airport_lines", ts());
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
            // GA-class window from the shuffle manifest (0 = single-window).
            let ga_n_days = read_ga_n_days(&segments_by_r4)?;
            let n = run_stage_2a(
                &segments_by_r4,
                &h3r4_dir,
                n_days,
                ga_n_days,
                scope.as_ref(),
                &rasters,
            )?;
            eprintln!("{} [stage2a] {n} R4 hexes written", ts());
        }
        Cmd::Stage2b { segments_dir, h3r4_dir, n_days, scope_bbox, fail_on_ga_cruise } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-dir", &segments_dir)?;
            let day_paths = list_segments_day_paths(&segments_dir)?;
            let n = run_stage_2b(&day_paths, &h3r4_dir, n_days, scope.as_ref(), fail_on_ga_cruise)?;
            eprintln!("{} [stage2b] {n} R4 hexes written", ts());
        }
        Cmd::Stage2c { segments_by_r4, h3r4_dir, n_days, scope_bbox } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_input_dir_exists("--segments-by-r4", &segments_by_r4)?;
            let areas = read_global_airports(&h3r4_dir)
                .with_context(|| format!("read airport_areas.arrow from {}", h3r4_dir.display()))?;
            eprintln!(
                "{} [stage2c] loaded {} aerodrome polygons globally",
                ts(),
                areas.len()
            );
            let ga_n_days = read_ga_n_days(&segments_by_r4)?;
            let n = run_stage_2c(
                &segments_by_r4,
                &areas,
                &h3r4_dir,
                n_days,
                ga_n_days,
                scope.as_ref(),
            )?;
            eprintln!("{} [stage2c] {n} R4 hexes written", ts());
        }
        Cmd::RunAll {
            adsb_cache,
            h3r4_dir,
            prepared_dir,
            work_dir,
            days,
            scope_bbox,
            from_stage,
            until_stage,
            feed,
            class_filter,
            ga_segments_dir,
            fail_on_ga_cruise,
        } => {
            let scope = parse_scope(scope_bbox.as_deref())?;
            require_scope_for_subset_cache(&adsb_cache, scope.as_ref())?;
            if until_stage < from_stage {
                anyhow::bail!(
                    "--until-stage {} precedes --from-stage {} — nothing would run",
                    from_stage_name(until_stage),
                    from_stage_name(from_stage),
                );
            }
            // Whether a pipeline phase executes this invocation: inside
            // the [from_stage, until_stage] window (both inclusive).
            let runs = |stage: FromStage| from_stage <= stage && stage <= until_stage;
            // Without any days, run-all would emit zero ok_paths and
            // proceed to shuffle, which wipes `segments_by_r4/` before
            // writing nothing. Bail loud to catch the typo / forgot-
            // --days case before shuffle erases existing cache.
            if days.is_empty() {
                anyhow::bail!(
                    "--days is empty — refusing to start. Pass at least one day, \
                     e.g. `--days 2025-01-01` or comma-separated list",
                );
            }
            // Refuse to silently overwrite a populated work_dir when
            // `--from-stage` resolves to stage0 (default OR explicit).
            // If the operator passed a later entry point, the populated
            // dir IS the input they want to reuse and we proceed.
            // Clean full run requires `rm -rf $WORK_DIR` first — data
            // loss must be intentional, not accidental.
            if from_stage == FromStage::Stage0 {
                bail_on_populated_work_dir(&work_dir)?;
            }
            if let Some(s) = scope.as_ref() {
                eprintln!(
                    "{} [run-all] scope bbox: lat {}..{}, lon {}..{}",
                    ts(),
                    s.min_lat,
                    s.max_lat,
                    s.min_lon,
                    s.max_lon
                );
            }
            if from_stage != FromStage::Stage0 {
                let name = from_stage_name(from_stage);
                eprintln!(
                    "{} [run-all] --from-stage {name}: skipping every phase before {name}",
                    ts()
                );
            }
            if until_stage != FromStage::Stage2c {
                let name = from_stage_name(until_stage);
                eprintln!(
                    "{} [run-all] --until-stage {name}: stopping after {name}",
                    ts()
                );
            }
            if class_filter != ClassFilterArg::All {
                eprintln!(
                    "{} [run-all] --class-filter {:?}: Stage 0 ingests only that \
                     hybrid window's classes (ga-365d-hybrid-plan.md §3)",
                    ts(),
                    class_filter
                );
            }
            let flights_dir = work_dir.join("flights");
            let segments_dir = work_dir.join("segments");
            let by_r4_dir = work_dir.join("segments_by_r4");

            // Hybrid merge input — resolved up front so a wrong path
            // fails before hours of Stage 0/1, and only when shuffle
            // actually consumes it.
            let ga_day_paths: Vec<PathBuf> = match &ga_segments_dir {
                None => Vec::new(),
                Some(_) if !runs(FromStage::Shuffle) => {
                    eprintln!(
                        "{} [run-all] --ga-segments-dir ignored: shuffle is outside \
                         the from/until window, segments_by_r4 + its manifests are \
                         reused as-is",
                        ts()
                    );
                    Vec::new()
                }
                Some(dir) => {
                    require_input_dir_exists("--ga-segments-dir", dir)?;
                    // Same physical dir as the airline segments would feed
                    // every airline day into BOTH passes (double energy
                    // under two pass keys) — refuse.
                    if dir.canonicalize().ok().is_some_and(|ga| {
                        segments_dir.canonicalize().ok() == Some(ga)
                    }) {
                        anyhow::bail!(
                            "--ga-segments-dir {} is the airline segments dir itself; \
                             point it at the GA pass's work dir (e.g. <ga-work>/segments)",
                            dir.display()
                        );
                    }
                    let paths = list_segments_day_paths(dir)?;
                    if paths.is_empty() {
                        anyhow::bail!(
                            "--ga-segments-dir {} contains no .arrow day shards — did \
                             the GA pass (--class-filter ga --until-stage stage1) run?",
                            dir.display()
                        );
                    }
                    eprintln!(
                        "{} [run-all] hybrid merge: {} GA day shard(s) from {}",
                        ts(),
                        paths.len(),
                        dir.display()
                    );
                    paths
                }
            };

            // Dedup before par_iter — Stage 0/1 write fixed paths
            // (flights/<day>.arrow, segments/<day>.arrow) per day, so
            // duplicates would race on the same output file.
            let mut days_dedup = days.clone();
            days_dedup.sort();
            days_dedup.dedup();
            if days_dedup.len() != days.len() {
                eprintln!(
                    "{} [run-all] duplicate days dropped: {} → {} unique",
                    ts(),
                    days.len(),
                    days_dedup.len()
                );
            }
            let days = days_dedup;

            // Shared instance — TileStore is per-slot Mutex +
            // Arc<RawTile>, safe to fan out under par_iter.
            let rasters = RealRasters::new(&prepared_dir);

            // Per-day phase. `ok_paths` is the input list for both
            // `shuffle_per_r4` and `run_stage_2b`; either consumer empty
            // means the corresponding output is silently wiped, so we
            // must populate it for every variant that still runs them.
            // After this block, Stage 2B (when it runs) gets a non-empty
            // list — or we fail loud before nuking anything.
            let needs_ok_paths = runs(FromStage::Shuffle) || runs(FromStage::Stage2b);
            let ok_paths: Vec<PathBuf> = if from_stage <= FromStage::Stage1 {
                std::fs::create_dir_all(&flights_dir)?;
                std::fs::create_dir_all(&segments_dir)?;
                let sources: Vec<Box<dyn FlightSource>> = vec![Box::new(
                    AdsbTarSource::new(&adsb_cache)
                        .with_source_id(feed.source_id())
                        .with_class_filter(class_filter.window()),
                )];
                // Per-day error tolerance: one corrupted TAR or DEM miss
                // must not throw away the other days' Stage 0+1 work.
                // Failed days are listed at the end so the operator can
                // rerun with `--days <failed,…>`.
                // Process days in RAM-bounded chunks. Each concurrent day holds
                // its full flight + segment working set in memory; within-day
                // work is already rayon-parallel over flights, so even one chunk
                // saturates every core. Running ALL days at once only multiplies
                // RAM with no throughput gain — it OOM-killed the 2026-05 global
                // TTM extract (7 dense days ≈ 16 GB each > 110 GB cgroup).
                let max_concurrent =
                    max_concurrent_days(days.len(), class_filter.stage01_peak_per_day_gb());
                eprintln!(
                    "{} [run-all] Stage 0/1: {} day(s), <={} concurrent (RAM-bounded; within-day fills every core)",
                    ts(),
                    days.len(),
                    max_concurrent
                );
                // A run stopping at Stage 0 produces flights, not
                // segments — success is judged on the artifact the last
                // executed stage writes.
                let done_dir = if until_stage == FromStage::Stage0 {
                    &flights_dir
                } else {
                    &segments_dir
                };
                let mut ok_paths: Vec<PathBuf> = Vec::new();
                let mut failed_days: Vec<String> = Vec::new();
                for chunk in days.chunks(max_concurrent) {
                    let (mut ok, mut fail): (Vec<PathBuf>, Vec<String>) = chunk
                        .par_iter()
                        .partition_map(|day| {
                            let done_path = done_dir.join(format!("{day}.arrow"));
                            match run_day(
                                day,
                                &sources,
                                &flights_dir,
                                &segments_dir,
                                &rasters,
                                from_stage,
                                until_stage,
                            ) {
                                Ok(()) if done_path.exists() => Either::Left(done_path),
                                Ok(()) => {
                                    eprintln!(
                                        "{} [run-all] {day}: FAILED — no output file produced",
                                        ts()
                                    );
                                    Either::Right(day.clone())
                                }
                                Err(e) => {
                                    eprintln!(
                                        "{} [run-all] {day}: FAILED stage0/1 — {e}, skipping",
                                        ts()
                                    );
                                    Either::Right(day.clone())
                                }
                            }
                        });
                    ok_paths.append(&mut ok);
                    failed_days.append(&mut fail);
                }

                if !failed_days.is_empty() {
                    eprintln!(
                        "{} [run-all] {} day(s) failed: {} — Stage 2 runs on the rest; rerun with --days {} to retry",
                        ts(),
                        failed_days.len(),
                        failed_days.join(","),
                        failed_days.join(",")
                    );
                }
                // Every day failed → ok_paths empty → shuffle would
                // proceed and wipe `segments_by_r4/` before writing
                // nothing, destroying the cached partition from any
                // earlier successful run. Bail loud instead. Same bail
                // when this is a per-pass invocation stopping at Stage
                // 0/1 — an all-failed pass must not look successful.
                if ok_paths.is_empty() {
                    return Err(anyhow::anyhow!(
                        "every requested day failed Stage 0/1 — nothing produced under \
                         {}. Check upstream errors and rerun with --days <surviving-list>",
                        work_dir.display(),
                    ));
                }
                ok_paths
            } else if needs_ok_paths {
                // Skipped Stage 0+1; reuse whatever Stage 1 left in
                // `segments_dir`. Filter by requested days so a stale
                // shard from a prior wider run doesn't sneak into
                // Stage 2B. Empty result = previous Stage 1 never ran
                // or `--days` doesn't match the cache; fail loud
                // because Stage 2B would otherwise wipe in-scope
                // `cruise.arrow` then write nothing.
                require_input_dir_exists("--work-dir/segments (--from-stage)", &segments_dir)?;
                let requested: std::collections::HashSet<&str> =
                    days.iter().map(String::as_str).collect();
                let mut paths: Vec<PathBuf> = list_segments_day_paths(&segments_dir)?
                    .into_iter()
                    .filter(|p| {
                        p.file_stem()
                            .and_then(|s| s.to_str())
                            .map(|s| requested.contains(s))
                            .unwrap_or(false)
                    })
                    .collect();
                paths.sort();
                if paths.is_empty() {
                    return Err(anyhow::anyhow!(
                        "--work-dir/segments {} contains no shard matching --days; rerun \
                         from an earlier stage or fix --days",
                        segments_dir.display()
                    ));
                }
                eprintln!(
                    "{} [run-all] reusing {} segment shard(s) from {}",
                    ts(),
                    paths.len(),
                    segments_dir.display()
                );
                paths
            } else {
                // Stage 2C only — neither shuffle nor Stage 2B runs,
                // so `ok_paths` is unused.
                Vec::new()
            };

            if until_stage <= FromStage::Stage1 {
                eprintln!(
                    "{} [run-all] stopped after {} (--until-stage): {} day artifact(s) \
                     under {}",
                    ts(),
                    from_stage_name(until_stage),
                    ok_paths.len(),
                    work_dir.display()
                );
                return Ok(());
            }

            // Read the global aerodrome set once. Stage 1.5
            // (`run_stage_airport_discover`) uses it for the
            // polygon-radius-aware re-attribution / reject pass on
            // DBSCAN clusters; Stage 2C reuses the same vec for its
            // `nearest_aerodrome_within` resolver. Airport identity
            // must stay global — aerodromes straddle R4 boundaries.
            // Skipped entirely when neither consumer is in the
            // from/until window.
            let needs_airports = runs(FromStage::Stage1_5) || runs(FromStage::Stage2c);
            let (areas, global_lines) = if needs_airports {
                let areas = read_global_airports(&h3r4_dir)?;
                eprintln!(
                    "{} [run-all] global aerodromes: {} polygons",
                    ts(),
                    areas.len()
                );
                // 0 global aerodromes ⇒ the OSM airport data isn't in --h3r4-dir (e.g. an
                // empty staging dir). Both Stage 1.5 gates then no-op → every ground segment
                // becomes a DBSCAN candidate (hours/R4 + garbage). Fail fast; cost a run once.
                if areas.is_empty() {
                    anyhow::bail!(
                        "0 global aerodromes loaded from {} — the OSM airport_areas.arrow data \
                         is missing there. Stage 1.5 would then treat every ground segment as a \
                         new-airport candidate (DBSCAN over millions of points → hours per R4 + \
                         garbage synth airports). Point --h3r4-dir at a prepared h3r4 that HAS \
                         the OSM airport data, not an empty or staging dir.",
                        h3r4_dir.display()
                    );
                }
                let global_lines = read_global_airport_lines(&h3r4_dir)?;
                eprintln!(
                    "{} [run-all] global airport lines: {} microsegments",
                    ts(),
                    global_lines.len()
                );
                (areas, global_lines)
            } else {
                (Vec::new(), Vec::new())
            };

            // Shuffle Stage 1 per-day shards into per-R4
            // `segments_by_r4/<R4>/{airborne,ground}.arrow`. Stages 1.5
            // / 2A / 2C all consume these; Stage 2B reads the per-day
            // shards directly (cruise straddles R4 boundaries) plus the
            // `n_days` manifest written here. The GA-window shards merge
            // into the same per-R4 pool under a distinct pass key
            // (ga-365d-hybrid-plan.md §4.2).
            if runs(FromStage::Shuffle) {
                let t_shuf = Instant::now();
                aircraft_extract::shuffle::shuffle_per_r4(
                    &ok_paths,
                    &ga_day_paths,
                    &by_r4_dir,
                    scope.as_ref(),
                )?;
                eprintln!("{} [run-all] shuffle done ({:?})", ts(), t_shuf.elapsed());
            } else {
                // Stages 1.5 / 2A / 2C read `<by_r4_dir>/<R4>/…`, Stage 2B
                // its `n_days` manifest; fail loud before any of them
                // silently no-ops on a missing dir.
                require_input_dir_exists(
                    "--work-dir/segments_by_r4 (required by Stage 1.5 / 2A / 2B / 2C)",
                    &by_r4_dir,
                )?;
            }
            if until_stage <= FromStage::Shuffle {
                eprintln!(
                    "{} [run-all] stopped after shuffle (--until-stage): per-R4 shards in {}",
                    ts(),
                    by_r4_dir.display()
                );
                return Ok(());
            }

            // Stage 1.5 — DBSCAN auto-discovery of OSM-missing
            // airfields. Runs BEFORE Stage 2C so its synth sidecars
            // are visible when Stage 2C loads each R4's airport_lines
            // cache. Writes empty arrows for in-scope R4s with no
            // current clusters so a stale strip cannot leak through.
            if runs(FromStage::Stage1_5) {
                let t1_5 = Instant::now();
                // Grid-index the global aerodromes so the per-ground-segment gate is
                // O(few-nearby), not O(45443) — else a mega-hub R4 is ~30 min/core.
                let aerodrome_index = AerodromeIndex::build(&areas);
                let r1_5 = run_stage_airport_discover(
                    &by_r4_dir,
                    &aerodrome_index,
                    &global_lines,
                    &h3r4_dir,
                    scope.as_ref(),
                )?;
                eprintln!(
                    "{} [run-all] stage1.5 R4s with synth lines={r1_5} ({:?})",
                    ts(),
                    t1_5.elapsed()
                );
            }
            if until_stage <= FromStage::Stage1_5 {
                eprintln!("{} [run-all] stopped after stage1-5 (--until-stage)", ts());
                return Ok(());
            }

            // n_days for Lden, from the shuffle's day-count manifest (see
            // `read_window_n_days`). All three Stage-2 outputs stamp this
            // one window, so the popup's max-n_days collapse
            // (source-reader/lib.rs:150) stays consistent across co-loaded
            // layers and can't drift to the 2026-05-24 n_days=7-on-full-year
            // mislabel (~17 dB off).
            let window_n_days = read_window_n_days(&by_r4_dir)?;
            let ga_n_days = read_ga_n_days(&by_r4_dir)?;
            if ga_n_days > 0 {
                eprintln!(
                    "{} [run-all] hybrid windows: n_days={window_n_days} (airline) + \
                     ga_n_days={ga_n_days} (GA classes, ga-365d-hybrid-plan.md)",
                    ts()
                );
            }

            if runs(FromStage::Stage2a) {
                let t2a = Instant::now();
                let r2a = run_stage_2a(
                    &by_r4_dir,
                    &h3r4_dir,
                    window_n_days,
                    ga_n_days,
                    scope.as_ref(),
                    &rasters,
                )?;
                eprintln!("{} [run-all] stage2a={r2a} ({:?})", ts(), t2a.elapsed());
            }
            if until_stage <= FromStage::Stage2a {
                eprintln!("{} [run-all] stopped after stage2a (--until-stage)", ts());
                return Ok(());
            }

            if runs(FromStage::Stage2b) {
                let t2b = Instant::now();
                // Stage 2B reads per-day cruise shards (`ok_paths`), NOT the
                // shuffled per-R4 ones — cruise output R4 derives from each
                // touched R7's parent (`stage_2b.rs:cell.parent(R4)`). Its
                // input window must therefore equal the shuffled window it is
                // stamped with; a `--from-stage` re-run with a shrunk `--days`
                // would aggregate fewer days than `segments_by_r4` holds and
                // mis-normalize cruise (while wiping the full-window files).
                // Refuse it — re-shuffle for the requested days instead.
                //
                // Hybrid runs change nothing here: `ok_paths` is the AIRLINE
                // pass only (GA shards enter solely via --ga-segments-dir →
                // shuffle), so cruise keeps plain `n_days` semantics and this
                // guard still compares airline days to the airline manifest
                // (ga-365d-hybrid-plan.md §4.2.6).
                if ok_paths.len() as u16 != window_n_days {
                    anyhow::bail!(
                        "Stage 2B input is {} day(s) but the shuffled window is {} \
                         (segments_by_r4/n_days). Re-run with `--from-stage shuffle` to \
                         re-shuffle for the requested --days, or pass the full day set.",
                        ok_paths.len(),
                        window_n_days,
                    );
                }
                let r2b = run_stage_2b(
                    &ok_paths,
                    &h3r4_dir,
                    window_n_days,
                    scope.as_ref(),
                    fail_on_ga_cruise,
                )?;
                eprintln!("{} [run-all] stage2b={r2b} ({:?})", ts(), t2b.elapsed());
            }
            if until_stage <= FromStage::Stage2b {
                eprintln!("{} [run-all] stopped after stage2b (--until-stage)", ts());
                return Ok(());
            }

            // Stage 2C is the last stage; reaching here means
            // `until_stage == Stage2c`, so it always runs.
            let t2c = Instant::now();
            let r2c = run_stage_2c(
                &by_r4_dir,
                &areas,
                &h3r4_dir,
                window_n_days,
                ga_n_days,
                scope.as_ref(),
            )?;
            eprintln!("{} [run-all] stage2c={r2c} ({:?})", ts(), t2c.elapsed());

            // `by_r4_dir` is left on disk so `--from-stage stage1-5/2a/2c`
            // can iterate on the same scratch dir without re-running
            // shuffle. The next shuffle wipes it before recreating;
            // operators clear `--work-dir` manually between major runs.
        }
    }
    Ok(())
}

/// Refuse to run the orchestrator at `--from-stage stage0` (default
/// OR explicit) when `--work-dir` already holds outputs from an
/// earlier run. Operators almost always want to REUSE that cache
/// (via `--from-stage stage1` / `shuffle` / `stage1-5` / ...); the
/// orchestrator would otherwise re-do Stage 0 + Stage 1 silently and
/// discard 1-3 hours of cached upstream work. The error message
/// shows the exact dirs that would be overwritten and offers the
/// two valid recovery paths: skip ahead with `--from-stage stageX`,
/// or `rm -rf $WORK_DIR` to start fresh.
fn bail_on_populated_work_dir(work_dir: &Path) -> Result<()> {
    let flights_dir = work_dir.join("flights");
    let segments_dir = work_dir.join("segments");
    let by_r4_dir = work_dir.join("segments_by_r4");
    let mut populated: Vec<(&str, &Path)> = Vec::new();
    for (name, dir) in [
        ("flights", flights_dir.as_path()),
        ("segments", segments_dir.as_path()),
        ("segments_by_r4", by_r4_dir.as_path()),
    ] {
        if dir.exists() && dir.is_dir() {
            let any = std::fs::read_dir(dir)
                .with_context(|| format!("read_dir {}", dir.display()))?
                .next()
                .is_some();
            if any {
                populated.push((name, dir));
            }
        }
    }
    if populated.is_empty() {
        return Ok(());
    }
    let listing = populated
        .iter()
        .map(|(n, p)| format!("  - {n}/  ({})", p.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(anyhow::anyhow!(
        "--work-dir {} already holds outputs from a previous run:\n\
         {listing}\n\n\
         The default `--from-stage stage0` would silently overwrite the cached \
         upstream work. Pick one:\n\
         (a) Reuse the cache — pass `--from-stage stage1` (or later) to skip ahead \
             to the stage whose code actually changed. The other six per-stage \
             subcommands also run standalone against the existing dirs.\n\
         (b) Wipe and rerun fresh — `rm -rf {work_dir}` first, then run-all.\n\
         The safety check fires only when both conditions hold: default `--from-stage` AND \
         a non-empty work_dir. Move the dir, archive it, or commit to (a)/(b) before retrying.",
        work_dir.display(),
        work_dir = work_dir.display(),
    ))
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

/// Union of [`list_segments_day_paths`] over repeatable `--segments-dir`
/// flags. Duplicate day stems across dirs are caught downstream by the
/// shuffle's stem-uniqueness bail (one Pass-A temp path per stem).
fn list_segments_day_paths_multi(dirs: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for dir in dirs {
        require_input_dir_exists("--segments-dir/--ga-segments-dir", dir)?;
        out.extend(list_segments_day_paths(dir)?);
    }
    out.sort();
    Ok(out)
}

/// Reads the shuffle day-count manifest (`<by_r4_dir>/n_days`). The shuffle
/// writes it from the segments it actually shuffled, so it is the true Lden
/// normalization window — the count of distinct extracted days present in
/// `segments_by_r4/` — and is invariant to a `--from-stage` re-run that
/// takes a stale `--days` from a shrunk ADS-B cache. A missing manifest
/// (legacy `segments_by_r4/` from before this field) fails loud.
fn read_window_n_days(by_r4_dir: &Path) -> Result<u16> {
    let path = by_r4_dir.join("n_days");
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "missing day-count manifest {} — re-run with `--from-stage shuffle` \
             to regenerate it from the segment files",
            path.display()
        )
    })?;
    let n = raw
        .trim()
        .parse::<u16>()
        .with_context(|| format!("parse n_days from {}", path.display()))?;
    if n == 0 {
        anyhow::bail!("day-count manifest {} is 0 — re-run `--from-stage shuffle`", path.display());
    }
    Ok(n)
}

/// Sibling of [`read_window_n_days`] for the GA-window manifest
/// (`<by_r4_dir>/ga_n_days`, written only by hybrid shuffles). A
/// missing file is 0 = plain single-window extract — all downstream
/// stamping then degenerates to today's behavior
/// (`ga-365d-hybrid-plan.md` §4.2.4).
fn read_ga_n_days(by_r4_dir: &Path) -> Result<u16> {
    let path = by_r4_dir.join("ga_n_days");
    let raw = match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        other => other.with_context(|| format!("read {}", path.display()))?,
    };
    raw.trim()
        .parse::<u16>()
        .with_context(|| format!("parse ga_n_days from {}", path.display()))
}

/// Shared `--scope-bbox` parser, identical surface across Stage2 + RunAll.
fn parse_scope(s: Option<&str>) -> Result<Option<ScopeBbox>> {
    s.map(ScopeBbox::parse)
        .transpose()
        .map_err(|e| anyhow::anyhow!("--scope-bbox: {e}"))
}

/// Render `FromStage` using its clap-side CLI value (`stage1-5`),
/// not the Rust variant name (`Stage1_5`). Used in operator-facing
/// log lines so the displayed value matches what they passed on the
/// command line.
fn from_stage_name(from_stage: FromStage) -> &'static str {
    match from_stage {
        FromStage::Stage0 => "stage0",
        FromStage::Stage1 => "stage1",
        FromStage::Shuffle => "shuffle",
        FromStage::Stage1_5 => "stage1-5",
        FromStage::Stage2a => "stage2a",
        FromStage::Stage2b => "stage2b",
        FromStage::Stage2c => "stage2c",
    }
}

fn init_rayon_pool(max_threads: Option<NonZeroUsize>) -> Result<()> {
    let Some(n) = max_threads else { return Ok(()) };
    rayon::ThreadPoolBuilder::new().num_threads(n.get()).build_global()?;
    eprintln!("{} [rayon] global pool = {} threads", ts(), n);
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
/// a `Result`-returning IIFE. `from_stage` selects whether to execute
/// Stage 0 — when set to `Stage1`, the caller is reusing a populated
/// `flights_dir` from a previous run and we go straight to Stage 1.
/// `until_stage == Stage0` stops before Stage 1 (per-pass hybrid runs
/// that only need the Stage 0 cache).
fn run_day(
    day: &str,
    sources: &[Box<dyn FlightSource>],
    flights_dir: &Path,
    segments_dir: &Path,
    rasters: &RealRasters,
    from_stage: FromStage,
    until_stage: FromStage,
) -> Result<()> {
    let t0 = Instant::now();
    let stage0_log = if from_stage <= FromStage::Stage0 {
        let n0 = run_stage_0(sources, day, flights_dir)?;
        format!("stage0={n0} ({:?})", t0.elapsed())
    } else {
        // Distinguish "skipped" from a real but empty Stage 0 result —
        // the latter has its own diagnostic (no flights for the day).
        "stage0=skipped".to_string()
    };
    if until_stage == FromStage::Stage0 {
        eprintln!(
            "{} [run-all] {day}: {stage0_log} stage1=skipped (--until-stage stage0)",
            ts()
        );
        return Ok(());
    }
    let t_stage1 = Instant::now();
    let n1 = run_stage_1(flights_dir, segments_dir, day, rasters)?;
    eprintln!(
        "{} [run-all] {day}: {stage0_log} stage1={n1} ({:?})",
        ts(),
        t_stage1.elapsed()
    );
    Ok(())
}

/// How many days to run through Stage 0/1 concurrently, sized to the host's
/// RAM. Within-day work is already rayon-parallel over flights, so a single
/// day saturates every core; extra concurrency only overlaps each day's serial
/// I/O prefix/suffix, at the cost of holding that many days' flight + segment
/// working sets in RAM at once. Auto-scaling off total RAM keeps the extract
/// OOM-free on any host (laptop → 256 GB server) with zero manual tuning.
///
/// `peak_per_day_gb` is the effective RAM cost per concurrent day. For full
/// days it was calibrated from the 2026-05 global TTM extract: 4 concurrent
/// dense days OOM-killed a 110 GB cgroup at the segment-write peak, i.e.
/// ~28 GB per concurrent day once the shared DEM tile cache + per-day segment
/// accumulation are amortized in (the per-day segment set alone is ~16 GB; 28
/// folds in the fixed shared-cache share so the linear K model stays safely
/// below the limit). GA-filtered passes use a lower estimate — see
/// `ClassFilterArg::stage01_peak_per_day_gb`.
fn max_concurrent_days(num_days: usize, peak_per_day_gb: f64) -> usize {
    // Effective budget = min(host RAM, this process's cgroup memory limit) so a
    // container or `systemd-run -p MemoryMax=…` scope caps concurrency too —
    // sizing off host RAM alone re-OOMs inside a smaller cgroup.
    let total_gb = available_memory_bytes() as f64 / 1_000_000_000.0;
    // Budget 60%: leaves headroom for the OS, the shared raster cache, and the
    // parent process while staying well clear of the OOM boundary.
    let k = (total_gb * 0.60 / peak_per_day_gb).floor() as usize;
    k.clamp(1, num_days.max(1))
}

/// Total physical RAM in bytes from `/proc/meminfo` (Linux). Falls back to a
/// conservative 16 GB if it can't be read, so the cap stays safe off-Linux.
fn host_ram_bytes() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb * 1024)
        .unwrap_or(16 * 1024 * 1024 * 1024)
}

/// This process's cgroup-v2 `memory.max` in bytes, if it is a real numeric
/// limit (not "max"). Resolves the cgroup path from `/proc/self/cgroup`
/// (v2 single line `0::<path>`). Returns None on cgroup v1 or no limit →
/// caller falls back to host RAM.
fn cgroup_memory_limit_bytes() -> Option<u64> {
    let cg = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let rel = cg.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
    let raw = std::fs::read_to_string(format!("/sys/fs/cgroup{rel}/memory.max")).ok()?;
    raw.trim().parse::<u64>().ok()
}

/// Memory budget for concurrency sizing: the smaller of host RAM and this
/// process's cgroup limit, so the day-concurrency cap is OOM-safe in
/// containers and `systemd-run -p MemoryMax=…` scopes, not just on bare metal.
fn available_memory_bytes() -> u64 {
    let host = host_ram_bytes();
    cgroup_memory_limit_bytes().map_or(host, |lim| host.min(lim))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_ga_n_days_missing_file_is_zero() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_ga_n_days(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn read_ga_n_days_parses_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("ga_n_days"), "365\n").unwrap();
        assert_eq!(read_ga_n_days(tmp.path()).unwrap(), 365);
    }

    #[test]
    fn read_ga_n_days_rejects_garbage() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("ga_n_days"), "not-a-number").unwrap();
        assert!(read_ga_n_days(tmp.path()).is_err());
    }
}
