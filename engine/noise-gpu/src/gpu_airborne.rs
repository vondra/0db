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
use heatmap_aircraft::grid::{tile_bbox, tile_range};
use heatmap_aircraft::r4_source_cache::{R4SourceCache, SourceSel};
use heatmap_aircraft::region_runner::{morton_order, region_tiles, tile_centre_r4};
use heatmap_aircraft::wire_hm3::{collapse_lden_u8, write_tile, SOURCE_ID_AIRCRAFT};
use heatmap_aircraft::worklist::resolve_n_days;
use noise_gpu::airborne::{region_candidates, AirborneGpu};
use raster_reader::fused_tile_z13::{default_batch_size, TileBatch};
use raster_reader::RealRasters;

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
    let resolved = resolve_n_days(&args.h3r4_dir, &source_r4s, SEL)?;
    let n_days = match args.n_days {
        Some(cli) if cli != resolved => {
            bail!("--n-days {cli} disagrees with arrow metadata ({resolved})")
        }
        _ => resolved,
    };
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
    let gpu = AirborneGpu::new();
    let mut cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);

    // Morton order so neighbouring regions' grid_disk(1) rings stay hot in the LRU.
    let order = morton_order(&regions.keys().copied().collect::<Vec<_>>());
    let (mut written, mut skipped) = (0usize, 0usize);
    let t = Instant::now();
    for r4 in order {
        let tiles = &regions[&r4];
        if tiles.is_empty() {
            continue;
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
        for ((bx, by), btiles) in &batches {
            let batch = TileBatch::build(z, *bx, *by, bn, 0.0, &rasters);
            for &(tx, ty) in btiles {
                let tile = &batch.tiles[((ty - by) * bn + (tx - bx)) as usize];
                let accum = gpu.scatter_tile(&resident, tile);
                let out = args
                    .output
                    .join(z.to_string())
                    .join(tx.to_string())
                    .join(format!("{ty}.bin"));
                let cells = collapse_lden_u8(&accum, n_days as f64);
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
    }
    let (hits, misses) = cache.stats();
    eprintln!(
        "done: {written} tiles written, {skipped} skipped, {} region(s), {:.1} s | cache {hits} hits / {misses} misses",
        regions.len(),
        t.elapsed().as_secs_f64(),
    );
    Ok(())
}
