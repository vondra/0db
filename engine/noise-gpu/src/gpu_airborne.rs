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
use noise_gpu::airborne::{region_candidates, AirborneGpu};
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
    /// Decoded-R4 LRU capacity (≥ grid_disk(1)=7 to cache a region's ring).
    #[arg(long, default_value_t = 64)]
    r4_cache: usize,
    #[arg(long, default_value_t = false)]
    write_empty: bool,
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

/// Build every owned tile of one region on the GPU: load its grid_disk(1) airborne
/// sources through `cache`, upload the region's candidate sub-segs once, then scatter
/// each tile-block. Returns (tiles_written, tiles_skipped). Empty / silent regions are NOT
/// skipped early — `scatter_region` fast-paths an empty region to zeroed tiles, which
/// still unlink any stale prior tile (gg: a bare `continue` would leave ghost tiles
/// in an incremental rebuild). The build-wide `!any_source_arrow` guard in `main`
/// already returns Ok(()) before any GPU work for a no-airborne chunk.
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
    if tiles.is_empty() {
        return Ok((0, 0));
    }
    // Load the region's grid_disk(1) airborne sources (Arc'd — held for the region's
    // lifetime so the merged views stay valid), then region-prep + upload ONCE.
    let cell = CellIndex::try_from(r4)?;
    let mut arcs = Vec::with_capacity(7);
    for nbr in cell.grid_disk::<Vec<_>>(1) {
        arcs.push(cache.get_or_load(u64::from(nbr))?);
    }
    let views: Vec<_> = arcs.iter().flat_map(|a| a.airborne.views()).collect();
    let resident = gpu.load_region(region_candidates(&views, r4, z));

    // Pre-fault this region's DEM footprint so TileBatch::build doesn't serialise on mmap
    // page faults (mirrors region_runner::preload_region).
    let (mut ps, mut pn, mut pw, mut pe) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(tx, ty) in tiles {
        let bb = tile_bbox(z, tx, ty);
        ps = ps.min(bb.south_lat);
        pn = pn.max(bb.north_lat);
        pw = pw.min(bb.west_lon);
        pe = pe.max(bb.east_lon);
    }
    rasters.preload_bbox(ps, pn, pw, pe);

    // Batch the region's tiles into grid-aligned blocks (one shared 0-halo each).
    let mut batches: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    for &(tx, ty) in tiles {
        batches
            .entry(((tx / bn) * bn, (ty / bn) * bn))
            .or_default()
            .push((tx, ty));
    }
    let (mut written, mut skipped) = (0usize, 0usize);
    for ((bx, by), btiles) in &batches {
        let batch = TileBatch::build(z, *bx, *by, bn, 0.0, rasters);
        let tile_refs: Vec<&FusedTileZ13> = btiles
            .iter()
            .map(|&(tx, ty)| &batch.tiles[((ty - by) * bn + (tx - bx)) as usize])
            .collect();
        // One GPU-classify + batched launch + sync for the whole block → one TileAccumulator
        // per tile, then the shared write below.
        let accums: Vec<TileAccumulator> = gpu.scatter_region(&resident, &tile_refs);
        for (&(tx, ty), accum) in btiles.iter().zip(accums.iter()) {
            let out = args
                .output
                .join(z.to_string())
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
