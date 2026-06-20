//! Production GPU airborne builder: the region-resident kernel (`noise_gpu::airborne`)
//! wired into the cluster's per-chunk region loop. Mirrors `build-heatmap-aircraft`'s CLI
//! (`--regions-file --n-days --h3r4-dir --prepared-dir --zoom --output`) so
//! `cluster-build-chunk.sh` can swap it in for the airborne source on a GPU box. Cruise
//! stays on the CPU builder (a different kernel, not yet ported).
//!
//! One GPU → the region loop is SEQUENTIAL (the device parallelises within each tile);
//! Morton order keeps the R4 source LRU hot, exactly like the CPU builder.
//!
//!   NOISE_GPU_PREPARED=… DATA_YEAR=… gpu-airborne --regions-file <r4-list> --n-days N \
//!       --h3r4-dir <h3r4> --prepared-dir <prep> --zoom 13 --output <dir>
//!   gpu-airborne --bbox S,W,N,E …      gpu-airborne --tile-x X --tile-y Y …   (dev modes)

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use clap::Parser;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::TileAccumulator;
use heatmap_aircraft::grid::{tile_bbox, tile_range};
use heatmap_aircraft::r4_source_cache::{R4SourceCache, SourceSel};
use heatmap_aircraft::region_runner::{morton_order, region_tiles, tile_centre_r4};
use heatmap_aircraft::wire_hm3::{collapse_lden_u8, write_tile, SOURCE_ID_AIRCRAFT};
use heatmap_aircraft::worklist::{any_source_arrow, resolve_n_days};
use noise_compute::emission::aircraft::SegmentPrepared;
use noise_gpu::airborne::{is_cell_unbuildable, region_candidates, AirborneGpu, RegionTooDense};
use noise_gpu::pack_airborne_segs;
use raster_reader::fused_tile_z13::{default_batch_size, FusedTileZ13, TileBatch};
use raster_reader::RealRasters;
use rayon::prelude::*;

/// Airborne only — cruise/traffic ride the CPU builder for now.
const SEL: SourceSel = SourceSel {
    cruise: false,
    airborne: true,
    traffic: false,
};

#[derive(Parser, Debug)]
struct Args {
    /// Build EXACTLY the output R4s in this file (one 15-hex cell/line) — the cluster's
    /// per-chunk unit. Disjoint chunks (centre-R4 ownership) → no tile built twice.
    #[arg(long)]
    regions_file: Option<PathBuf>,
    /// Dev: every tile at --zoom intersecting `south,west,north,east`.
    #[arg(long, value_parser = parse_bbox)]
    bbox: Option<[f64; 4]>,
    /// Dev: a single tile (requires --tile-y).
    #[arg(long)]
    tile_x: Option<u32>,
    #[arg(long)]
    tile_y: Option<u32>,
    #[arg(long, default_value_t = 13)]
    zoom: u8,
    #[arg(long)]
    h3r4_dir: PathBuf,
    #[arg(long)]
    prepared_dir: PathBuf,
    #[arg(long)]
    output: PathBuf,
    /// Build-wide Lden divisor. Omit to derive it from arrow metadata; if given it is
    /// verified against the metadata (a mismatch is fatal — same contract as the CPU builder).
    #[arg(long)]
    n_days: Option<u16>,
    /// Per-batch dimension. 0 = auto-detect from L3 size.
    #[arg(long, default_value_t = 0)]
    batch_size: u32,
    /// Decoded-R4 LRU capacity (≥ grid_disk(1)=7 to cache a region's ring). 16 keeps the ring
    /// plus a locality margin warm while bounding the decoded-source baseline — 64 (the old,
    /// untuned default) accumulated ~16 GB of dense hub-cell sources in the LRU, starving a dense
    /// cell's region_candidates Vec of host memcap. Morton order shares 4-5 of 7 ring neighbours,
    /// so 16 holds the working set with no extra re-decodes.
    #[arg(long, default_value_t = 16)]
    r4_cache: usize,
    #[arg(long, default_value_t = false)]
    write_empty: bool,
    /// STREAM mode: read output R4 cell IDs (one hex/line) from stdin and build each on a warm
    /// K-in-flight worker pool (K = rayon threads, each its own CUDA stream + R4 LRU, reused
    /// across cells — no per-chunk process spawn), printing `done <r4hex> <written> <skipped>
    /// <ms>` (or `fail <r4hex> <err>`) per cell as it finishes. The persistent worker the
    /// cluster orchestrator feeds. Requires --seed-regions (resolves n_days + class_weights once).
    #[arg(long, default_value_t = false)]
    stream: bool,
    /// STREAM mode: resolve the build-wide n_days + class_weights ONCE at startup from this seed
    /// regions-file (the orchestrator's representative source set). Streamed cells inherit it,
    /// consistency-asserted vs --n-days — same contract as the batch path's single resolve.
    #[arg(long)]
    seed_regions: Option<PathBuf>,
}

fn parse_bbox(s: &str) -> Result<[f64; 4], String> {
    let v: Vec<f64> = s
        .split(',')
        .map(|p| p.parse::<f64>().map_err(|e| format!("bbox float: {e}")))
        .collect::<Result<_, _>>()?;
    if v.len() != 4 {
        return Err(format!(
            "expected south,west,north,east; got {} values",
            v.len()
        ));
    }
    if v[0] >= v[2] || v[1] >= v[3] {
        return Err(format!("need south<north and west<east, got {v:?}"));
    }
    Ok([v[0], v[1], v[2], v[3]])
}

/// Union of `grid_disk(1)` over the output regions — the source R4 set whose `n_days` must agree.
fn ring_union(regions: impl Iterator<Item = u64>) -> Vec<u64> {
    let mut set: BTreeSet<u64> = BTreeSet::new();
    for r4 in regions {
        if let Ok(cell) = CellIndex::try_from(r4) {
            for nbr in cell.grid_disk::<Vec<_>>(1) {
                set.insert(u64::from(nbr));
            }
        }
    }
    set.into_iter().collect()
}

fn main() -> Result<()> {
    let args = Args::parse();
    if !(6..=18).contains(&args.zoom) {
        bail!("zoom {} out of supported range 6..=18", args.zoom);
    }
    let z = args.zoom;

    if args.stream {
        return run_stream(&args, z);
    }

    // Output regions (R4 → its target tiles): regions-file (cluster) | bbox | single tile (dev).
    let regions: BTreeMap<u64, Vec<(u32, u32)>> =
        match (&args.regions_file, &args.bbox, args.tile_x, args.tile_y) {
            (Some(rf), None, None, None) => {
                let r4s = heatmap_aircraft::region_runner::read_r4_file(rf)?;
                eprintln!("regions-file: {} output R4s", r4s.len());
                r4s.into_iter()
                    .map(|r4| (r4, region_tiles(r4, z)))
                    .collect()
            }
            (None, Some(b), None, None) => {
                let (xr, yr) = tile_range(z, b[0], b[1], b[2], b[3]);
                let mut m: BTreeMap<u64, Vec<(u32, u32)>> = BTreeMap::new();
                for y in yr {
                    for x in xr.clone() {
                        if let Some(r4) = tile_centre_r4(z, x, y) {
                            m.entry(r4).or_default().push((x, y));
                        }
                    }
                }
                m
            }
            (None, None, Some(x), Some(y)) => {
                let r4 = tile_centre_r4(z, x, y).context("tile centre out of range")?;
                BTreeMap::from([(r4, vec![(x, y)])])
            }
            _ => bail!("specify exactly one of --regions-file, --bbox, or --tile-x/--tile-y"),
        };
    if regions.is_empty() {
        bail!("no regions to build");
    }

    // One build-wide n_days, data-derived and verified against any explicit --n-days (the
    // cluster resolves it once for the whole area and passes it to every chunk).
    let source_r4s = ring_union(regions.keys().copied());
    // A chunk can hold road/rail but no airborne (rural). Building the absent airborne is a
    // no-op, not a fatal resolve — else the shared `line` job loses its road/rail too (Codex /gg).
    if !any_source_arrow(&args.h3r4_dir, &source_r4s, SEL)? {
        eprintln!("no airborne data in this chunk — nothing to build");
        return Ok(());
    }
    let resolved = resolve_n_days(&args.h3r4_dir, &source_r4s, SEL)?;
    let n_days = match args.n_days {
        Some(cli) if cli != resolved => {
            bail!("--n-days {cli} disagrees with arrow metadata ({resolved})")
        }
        _ => resolved,
    };
    // GA 365-day hybrid weight LUT, resolved once build-wide from the
    // source arrows' `sample_days_by_class` (consistency-asserted like
    // n_days) and uploaded device-global by `AirborneGpu::new`.
    let class_weights = heatmap_aircraft::worklist::resolve_class_weights(
        &args.h3r4_dir,
        &source_r4s,
        SEL,
        n_days,
    )?;
    let n_tiles: usize = regions.values().map(Vec::len).sum();
    eprintln!(
        "{} region(s), {n_tiles} tile(s) at z={z}, n_days={n_days}",
        regions.len()
    );

    let rasters = RealRasters::new(&args.prepared_dir);
    let bn = if args.batch_size == 0 {
        default_batch_size()
    } else {
        args.batch_size
    };
    // Per-worker GPU + LRU, rayon over a contiguous Morton chunk per worker — mirrors
    // build_heatmap_aircraft's par_chunks. Each worker owns its AirborneGpu (its own CUDA
    // stream, M1b) and its R4SourceCache. The near/far candidate gate that used to run
    // single-threaded per tile on the CPU (the "1 core at 98%, 15 idle" wall) now runs on
    // the GPU as a counting-sort inside `scatter_region` (M4), so the device stays saturated
    // (~95%) instead of stalling on the CPU between launches. Commutative over regions, and
    // parity-equivalent to the per-tile `scatter_tile` (compare_hm3: 0 cells > 0.5 dB).
    let order = morton_order(&regions.keys().copied().collect::<Vec<_>>());
    let n_workers = rayon::current_num_threads().max(1);
    let chunk_size = order.len().div_ceil(n_workers).max(1);
    let t = Instant::now();
    let (written, skipped, hits, misses) = order
        .par_chunks(chunk_size)
        .map(|chunk| -> Result<(usize, usize, u64, u64)> {
            let gpu = AirborneGpu::new(&class_weights);
            let mut cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);
            let (mut w, mut s) = (0usize, 0usize);
            for &r4 in chunk {
                let (rw, rs) = process_region_gpu(
                    &gpu,
                    &mut cache,
                    &rasters,
                    &args,
                    z,
                    bn,
                    n_days,
                    r4,
                    &regions[&r4],
                )?;
                w += rw;
                s += rs;
            }
            let (h, m) = cache.stats();
            Ok((w, s, h, m))
        })
        .try_reduce(
            || (0, 0, 0, 0),
            |(a, b, c, d), (e, f, g, h)| Ok((a + e, b + f, c + g, d + h)),
        )?;
    let hit_pct = 100.0 * hits as f64 / (hits + misses).max(1) as f64;
    eprintln!(
        "done: {written} tiles written, {skipped} skipped, {} region(s), {:.1} s | \
         cache {hits} hits / {misses} misses ({hit_pct:.0}% hit, {n_workers} workers)",
        regions.len(),
        t.elapsed().as_secs_f64(),
    );
    Ok(())
}

/// One grid-aligned tile-block, CPU-prepped: its NW corner `(bx,by)`, the owned tiles in it,
/// and the DEM-only `TileBatch`. `gpu_build_cell` rebuilds the `&FusedTileZ13` refs from
/// `batch.tiles` by the same `((ty-by)*bn + (tx-bx))` index the serial path used.
struct PrepBlock {
    bx: u32,
    by: u32,
    btiles: Vec<(u32, u32)>,
    batch: TileBatch,
}

/// One cell's CPU prep output, handed across the A2 channel to the GPU thread. Holds the
/// pre-packed region SoA (`sll`/`sf`/`si`, ready for `upload_region` — `region` itself is
/// dropped after packing; the stream path never reads it) and the prepped tile-blocks.
/// `Send` because every field is a `Vec`/`usize`/`Instant` and `TileBatch` is `Vec`s of
/// primitives + `Arc<FusedGrid>` (`FusedGrid: Send+Sync`). `t_start` is stamped at the START
/// of prep so the reported ms = prep+build wall time per cell, matching the serial `done` line.
/// (The cell's `r4` is NOT a field: the stream channel carries it alongside as `(u64, Result<_>)`
/// so the GPU thread can report `fail`/FATAL even when prep itself errored and produced no cell.)
struct PreparedCell {
    sll: Vec<f64>,
    sf: Vec<f32>,
    si: Vec<i32>,
    nreg: usize,
    blocks: Vec<PrepBlock>,
    t_start: Instant,
}

/// (memory.max, memory.current) of this process's cgroup-v2 scope, in bytes — the live memcap
/// budget the memcap wrapper set. None if unreadable or unlimited ("max"), in which case the
/// caller skips the guard (no cap to respect).
fn cgroup_mem() -> Option<(u64, u64)> {
    let cg = std::fs::read_to_string("/proc/self/cgroup").ok()?; // "0::/user.slice/…/run-XXX.scope"
    let rel = cg.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
    let base = format!("/sys/fs/cgroup{rel}");
    let max = std::fs::read_to_string(format!("{base}/memory.max")).ok()?;
    let max = max.trim().parse::<u64>().ok()?; // "max" → parse fails → None (no cap)
    let cur = std::fs::read_to_string(format!("{base}/memory.current"))
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some((max, cur))
}

/// CPU prep stage for one cell (no GPU/device touch): load its grid_disk(1) airborne sources
/// through `cache`, `region_candidates` + pack the region SoA, then build the DEM-only tile
/// batches for `tiles` (the cell's owned tiles — `region_tiles(r4,z)` on the stream/production
/// path, a bbox/single-tile subset on the dev paths). The packed SoA is uploaded later by
/// `gpu_build_cell` via `upload_region`. `region` is dropped right after packing — only the SoA
/// crosses the channel, so host RAM per buffered cell is the SoA + its tile blocks, not the
/// prepared-segment Vec too. (Takes no `&Args`: the output dir + write-empty flag this stage's
/// serial predecessor referenced live in `gpu_build_cell` now, the only stage that writes tiles.)
fn prep_cell(
    rasters: &RealRasters,
    cache: &mut R4SourceCache,
    z: u8,
    bn: u32,
    r4: u64,
    tiles: &[(u32, u32)],
) -> Result<PreparedCell> {
    let t_start = Instant::now();
    if tiles.is_empty() {
        // No owned tiles → nothing to upload or build; empty blocks + an empty SoA. The GPU
        // thread's `for` over `blocks` is a no-op (0 written, 0 skipped), same as the serial path.
        return Ok(PreparedCell {
            sll: Vec::new(),
            sf: Vec::new(),
            si: Vec::new(),
            nreg: 0,
            blocks: Vec::new(),
            t_start,
        });
    }
    // Load the region's grid_disk(1) airborne sources (Arc'd — held only for this function's
    // lifetime so the merged views stay valid while we pack), then region-prep + pack ONCE.
    let cell = CellIndex::try_from(r4)?;
    let mut arcs = Vec::with_capacity(7);
    for nbr in cell.grid_disk::<Vec<_>>(1) {
        arcs.push(cache.get_or_load(u64::from(nbr))?);
    }
    let views: Vec<_> = arcs.iter().flat_map(|a| a.airborne.views()).collect();
    // HOST-memory guard (the host analog of `scatter_region`'s VRAM `RegionTooDense`): the ~5
    // densest megahub cells build a `region` Vec of tens of GB that spikes the engine past its
    // cgroup MemoryMax → an uncatchable cgroup SIGKILL that crash-loops the worker. Estimate the
    // Vec's peak host bytes from the total sub-segment count (its element upper bound) BEFORE
    // allocating it; if it wouldn't fit the live memcap, return RegionTooDense — the SAME
    // graceful per-cell skip path the VRAM limit uses (run_stream reports `fail`, hub leaves the
    // cell uncomputed; accepted for ~5 cells). When there is no cgroup cap (local dev) the guard
    // is skipped entirely. Conservative by design (×2 for the construction peak + the packed SoA
    // built from it, +4 GiB for the prep-ahead overlap cell): err toward skipping a borderline
    // cell, since a skipped cell is uncomputed (accepted) but a host OOM crash-loops (not).
    if let Some((max, cur)) = cgroup_mem() {
        let n_sub: usize = views.iter().map(|v| v.sub_segments.start_lat.len()).sum();
        let est = (n_sub as u64)
            .saturating_mul(std::mem::size_of::<(SegmentPrepared, u8)>() as u64)
            .saturating_mul(2);
        if cur.saturating_add(est).saturating_add(4 << 30) > max {
            return Err(RegionTooDense(format!(
                "region ~{} GiB for {} sub-segs would exceed host memcap (cur {} + est > max {}) \
                 — skipping",
                est >> 30,
                n_sub,
                cur >> 30,
                max >> 30
            ))
            .into());
        }
    }
    let region = region_candidates(&views, r4, z);
    let nreg = region.len();
    let (sll, sf, si) = pack_airborne_segs(&region);
    // The SoA is fully packed — the prepared-segment Vec (and the source Arcs/views it borrows)
    // are no longer needed for the stream/scatter_region path, so drop them to bound host RAM.
    drop(region);
    drop(views);
    drop(arcs);

    // Pre-fault this region's DEM footprint so the per-tile build doesn't serialise on mmap page
    // faults (mirrors region_runner::preload_region). DEM-only: airborne consumes only rx_alt_m.
    let (mut ps, mut pn, mut pw, mut pe) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(tx, ty) in tiles {
        let bb = tile_bbox(z, tx, ty);
        ps = ps.min(bb.south_lat);
        pn = pn.max(bb.north_lat);
        pw = pw.min(bb.west_lon);
        pe = pe.max(bb.east_lon);
    }
    rasters.preload_dem_bbox(ps, pn, pw, pe);

    // Batch the region's tiles into grid-aligned blocks. DEM-only (build_receiver_altitude_only): airborne
    // reads only rx_alt_m, so skip sampling building/forest/imd + the halo the full build would compute.
    let mut batches: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    for &(tx, ty) in tiles {
        batches
            .entry(((tx / bn) * bn, (ty / bn) * bn))
            .or_default()
            .push((tx, ty));
    }
    let mut blocks = Vec::with_capacity(batches.len());
    for ((bx, by), btiles) in batches {
        let batch = TileBatch::build_receiver_altitude_only(z, bx, by, bn, rasters);
        blocks.push(PrepBlock {
            bx,
            by,
            btiles,
            batch,
        });
    }
    Ok(PreparedCell {
        sll,
        sf,
        si,
        nreg,
        blocks,
        t_start,
    })
}

/// GPU build stage for one prepped cell (the only device-touching half): upload the region SoA
/// ONCE, then per block rebuild the `&FusedTileZ13` refs, `scatter_region`, and run the EXACT
/// serial write loop (`collapse_lden_u8` + `write_tile` + stale-unlink on shrink-to-silence).
/// Returns (tiles_written, tiles_skipped). Empty / silent regions are NOT skipped early —
/// `scatter_region` fast-paths an empty region to zeroed tiles, which still unlink any stale
/// prior tile (gg: a bare `continue` would leave ghost tiles in an incremental rebuild).
fn gpu_build_cell(
    gpu: &AirborneGpu,
    args: &Args,
    n_days: u16,
    p: PreparedCell,
) -> Result<(usize, usize)> {
    // No owned tiles (e.g. an off-grid cell) → no block to scatter, so skip the device upload
    // entirely — a true no-op, matching the serial path's early `Ok((0,0))`. (A cell WITH tiles
    // but zero airborne candidates still uploads an empty SoA below and runs `scatter_region`,
    // which zeros + stale-unlinks every tile, exactly as before.)
    if p.blocks.is_empty() {
        return Ok((0, 0));
    }
    let resident = gpu.upload_region(p.sll, p.sf, p.si, p.nreg)?;
    let (mut written, mut skipped) = (0usize, 0usize);
    for block in &p.blocks {
        let (bx, by, bn) = (block.bx, block.by, block.batch.batch_n);
        let tile_refs: Vec<&FusedTileZ13> = block
            .btiles
            .iter()
            .map(|&(tx, ty)| &block.batch.tiles[((ty - by) * bn + (tx - bx)) as usize])
            .collect();
        // One GPU-classify + batched launch + sync for the whole block → one TileAccumulator
        // per tile, then the shared write below.
        let accums: Vec<TileAccumulator> = gpu.scatter_region(&resident, &tile_refs)?;
        for (&(tx, ty), accum) in block.btiles.iter().zip(accums.iter()) {
            let out = args
                .output
                .join(args.zoom.to_string())
                .join(tx.to_string())
                .join(format!("{ty}.bin"));
            let cells = collapse_lden_u8(accum, n_days as f64);
            if write_tile(&out, &cells, SOURCE_ID_AIRCRAFT, !args.write_empty)? > 0 {
                written += 1;
            } else {
                // Re-run shrank this tile to silence — unlink any stale prior tile so an
                // incremental recombine/pyramid can't read phantom energy (mirrors CPU builder).
                if out.exists() {
                    std::fs::remove_file(&out)
                        .with_context(|| format!("rm stale {}", out.display()))?;
                }
                skipped += 1;
            }
        }
    }
    Ok((written, skipped))
}

/// Build every owned tile of one region on the GPU (the BATCH `par_chunks` path): CPU-prep then
/// GPU-build, SERIAL — `prep_cell` + `gpu_build_cell` share the exact code the A2 stream pipeline
/// splits across two threads, so this path is unchanged in behaviour. `tiles` is the cell's owned
/// tile list (`region_tiles` for `--regions-file`, a bbox/single-tile subset for the dev modes),
/// forwarded to `prep_cell` so the dev paths keep their explicit subset; the build-wide
/// `!any_source_arrow` guard in `main` already returns Ok(()) before any GPU work for a
/// no-airborne chunk.
#[allow(clippy::too_many_arguments)]
fn process_region_gpu(
    gpu: &AirborneGpu,
    cache: &mut R4SourceCache,
    rasters: &RealRasters,
    args: &Args,
    z: u8,
    bn: u32,
    n_days: u16,
    r4: u64,
    tiles: &[(u32, u32)],
) -> Result<(usize, usize)> {
    let p = prep_cell(rasters, cache, z, bn, r4, tiles)?;
    gpu_build_cell(gpu, args, n_days, p)
}

/// Shared streaming work queue: (pending Morton-ordered cells, stream-closed flag) under a mutex,
/// plus a condvar to park idle workers. Workers drain a contiguous run off the front; the stdin
/// reader pushes to the back and wakes one. (Factored to a type alias so the `let` below isn't a
/// clippy `type_complexity` lint.)
type StreamQueue = std::sync::Arc<(
    std::sync::Mutex<(std::collections::VecDeque<u64>, bool)>,
    std::sync::Condvar,
)>;

/// STREAM mode (`--stream`): the persistent warm worker the cluster orchestrator feeds — the
/// answer to the per-chunk process spawn + inter-chunk staging stall (~39% of box wall-time)
/// that capped the cluster's GPU at ~61% effective (a warm process sustains ~88-100%, STEP 1).
/// One process: CUDA context + NPD LUTs + class-weights + RealRasters all resident; R4 cell IDs
/// stream in on stdin and each is built by an A2 CPU-prep / GPU-build double-buffer — ONE prep
/// thread (its own `RealRasters` + R4 LRU) packs the NEXT cell while ONE GPU thread (one CUDA
/// stream, so exactly one cell's region in VRAM — no OOM, no cell loss) builds the current one.
/// The two stages are joined by a depth-1 `sync_channel`, so the prep thread runs at most one
/// cell ahead (host RAM stays ~2-3 cells) and the GPU stays saturated across each cell's CPU
/// prep instead of idling ~25% as in the serial per-worker loop. One `done <r4hex> <written>
/// <skipped> <ms>` (or `fail <r4hex> <err>`) line prints per cell AS IT FINISHES (the GPU thread
/// is the sole writer → no interleave), so the orchestrator can ACK + advance its lease without
/// waiting for the whole stream. n_days + class_weights resolve ONCE from `--seed-regions` (the
/// orchestrator's representative source set); the streamed cells inherit that build-wide value,
/// exactly as every chunk did in the batch cluster.
///
/// Termination / deadlock-freedom: the reader (main scope thread) parses stdin onto the Morton
/// work queue; on EOF it sets the closed flag + `notify_all`. The prep thread drains contiguous
/// runs (PULL_BATCH) and on "closed + empty" breaks its loop, returns, and DROPS its `Sender`.
/// `gpu_tx` was moved into the prep thread, so when prep exits the channel closes; the GPU
/// thread's `for msg in rx` then ends, and the scope joins both. No stage can block forever: the
/// bounded `send` only blocks while the channel is full, which the GPU thread always eventually
/// drains (it never blocks except on that same `rx`); the prep `cv.wait` is always woken by the
/// reader's per-cell `notify_one` or the EOF `notify_all`.
fn run_stream(args: &Args, z: u8) -> Result<()> {
    use std::collections::VecDeque;
    use std::io::{BufRead, Write};
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Condvar, Mutex};

    let seed = args.seed_regions.as_ref().context(
        "--stream requires --seed-regions (resolves the build-wide n_days + class_weights)",
    )?;
    let seed_r4s = heatmap_aircraft::region_runner::read_r4_file(seed)?;
    let source_r4s = ring_union(seed_r4s.iter().copied());
    if !any_source_arrow(&args.h3r4_dir, &source_r4s, SEL)? {
        bail!("--seed-regions has no airborne source — cannot resolve class_weights");
    }
    let resolved = resolve_n_days(&args.h3r4_dir, &source_r4s, SEL)?;
    let n_days = match args.n_days {
        Some(cli) if cli != resolved => {
            bail!("--n-days {cli} disagrees with arrow metadata ({resolved})")
        }
        _ => resolved,
    };
    let class_weights = heatmap_aircraft::worklist::resolve_class_weights(
        &args.h3r4_dir,
        &source_r4s,
        SEL,
        n_days,
    )?;
    let bn = if args.batch_size == 0 {
        default_batch_size()
    } else {
        args.batch_size
    };
    eprintln!(
        "stream: n_days={n_days}, batch={bn}, A2 prep+GPU pipeline — reading R4 cells from stdin"
    );

    // Morton-locality work queue. The single prep thread pulls a CONTIGUOUS run of up to
    // PULL_BATCH cells from the front of a shared queue the reader fills in arrival (= the
    // orchestrator's Morton) order, so its grid_disk(1) ring-cache stays warm across the run —
    // even better than the old per-worker pool, which split the Morton stream across K caches.
    // The mutex is held only to splice a run off the front (cheap); prep_cell runs unlocked.
    const PULL_BATCH: usize = 4;
    let work: StreamQueue = Arc::new((Mutex::new((VecDeque::new(), false)), Condvar::new()));
    // Depth-1: the prep thread may have 1 cell buffered in the channel + 1 in flight (its `send`
    // blocks on the 2nd), while the GPU thread holds the 1 it is building → host RAM ≈ 3 cells.
    let (gpu_tx, gpu_rx) = sync_channel::<(u64, Result<PreparedCell>)>(1);

    std::thread::scope(|scope| {
        // PREP THREAD (CPU only — no device touch). Owns its own RealRasters + R4 LRU (PER-prep,
        // not shared: it then locks only its OWN tile-store mutexes, the fix that broke the flat
        // 41%-CPU airborne ceiling — see 7746b452). Pulls Morton-contiguous runs, prep_cells each,
        // and sends `(r4, Result<PreparedCell>)` (the depth-1 `send` blocks when the channel is
        // full — the desired backpressure). Owns the ONLY Sender, so on exit the channel closes.
        let prep_work = Arc::clone(&work);
        scope.spawn(move || {
            let rasters = RealRasters::new(&args.prepared_dir);
            let mut cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);
            loop {
                let batch: Vec<u64> = {
                    let (lock, cv) = &*prep_work;
                    let mut g = lock.lock().unwrap();
                    loop {
                        if !g.0.is_empty() {
                            let take = g.0.len().min(PULL_BATCH);
                            break g.0.drain(..take).collect();
                        }
                        if g.1 {
                            break Vec::new(); // stream closed + drained → exit
                        }
                        g = cv.wait(g).unwrap();
                    }
                };
                if batch.is_empty() {
                    break; // → return → drop gpu_tx → channel closes → GPU thread's `for` ends
                }
                for r4 in batch {
                    let tiles = region_tiles(r4, z);
                    let prepared = prep_cell(&rasters, &mut cache, z, bn, r4, &tiles);
                    // A prep error (CPU/IO/source-load) is forwarded so the GPU thread reports it
                    // through the SAME A1 classification (non-OOM → exit(1)). If the GPU thread has
                    // already gone (rx dropped), send fails → drop the work and exit gracefully.
                    if gpu_tx.send((r4, prepared)).is_err() {
                        return;
                    }
                }
            }
        });

        // GPU THREAD (the only device-touching stage). Owns ONE AirborneGpu — one CUDA stream, so
        // exactly one cell's region is resident in VRAM at a time (A2 overlaps CPU prep, NOT GPU
        // concurrency: the threads=1 VRAM-safety is preserved). Sole stdout writer. Owns the ONLY
        // Receiver; the loop ends when the prep thread drops the Sender.
        let class_weights = &class_weights;
        scope.spawn(move || {
            let gpu = AirborneGpu::new(class_weights);
            for (r4, prepared) in gpu_rx {
                // ms = prep+build wall time per cell (t_start stamped at the START of prep_cell),
                // matching the serial `done` line. Read it before gpu_build_cell consumes the cell.
                let line = match prepared.and_then(|p| {
                    let t_start = p.t_start;
                    gpu_build_cell(&gpu, args, n_days, p).map(|(w, s)| (w, s, t_start))
                }) {
                    Ok((w, s, t_start)) => {
                        format!("done {r4:x} {w} {s} {}", t_start.elapsed().as_millis())
                    }
                    // A per-cell VRAM OOM / too-dense region: report THIS cell failed and keep
                    // streaming (the hub leaves it unstamped → uncomputed). A clean alloc failure
                    // leaves the CUDA context usable, so the next cell is fine.
                    Err(e) if is_cell_unbuildable(&e) => format!("fail {r4:x} {e}"),
                    // Anything else — a non-OOM CUDA error (illegal address, launch/sync failure ⇒
                    // possibly corrupted device state) or a CPU/IO failure (tile write, source
                    // load, on either thread) — is NOT safely skippable: abort so provision
                    // restarts a clean engine instead of silently failing every later cell.
                    Err(e) => {
                        eprintln!("airborne: FATAL unrecoverable error on {r4:x}: {e:?}");
                        std::process::exit(1);
                    }
                };
                // One locked writeln+flush so each cell's result reaches the orchestrator at once.
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        });

        // Reader on the main scope thread (StdinLock is !Send): parse hex R4s onto the queue tail in
        // arrival order, waking the prep thread per cell. On EOF flag done + wake it so it drains + exits.
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let s = line.trim();
            if s.is_empty() {
                continue;
            }
            match u64::from_str_radix(s, 16) {
                Ok(r4) => {
                    let (lock, cv) = &*work;
                    lock.lock().unwrap().0.push_back(r4);
                    cv.notify_one();
                }
                Err(_) => eprintln!("stream: skip non-hex line: {s}"),
            }
        }
        let (lock, cv) = &*work;
        lock.lock().unwrap().1 = true;
        cv.notify_all();
    });
    Ok(())
}
