//! GPU surface heatmap batch runner for the LINE layers (road + rail) — the
//! production wiring of the binned scatter kernel. Road and rail are both
//! `LineRow` sources feeding the identical CNOSSOS line-source physics, so one
//! kernel (`line_binned`) serves both; only the loader, halo reach, and HM3
//! source_id differ. Builds one tile block's shared 10 km halo once, then per
//! tile per layer: load rows, bin sources per 8×8 block, run the kernel,
//! collapse to Lden u8, write `{output}/{layer}/13/x/y.bin` and (if a baseline
//! exists) diff it. Reports per-layer throughput.
//!
//!   # one grid-aligned block (dev/bench), diff vs baseline:
//!   NOISE_GPU_BASELINE=/root/baseline gpu-surface --layers rail 4510 2786 4
//!   # a whole region (production), road+rail → HM3:
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared DATA_YEAR=2026 \
//!     gpu-surface --layers road,rail --bbox 38.27,-9.78,39.17,-8.50 --output OUT
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use cudarc::driver::{CudaDevice, CudaFunction, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::{CellIndex, LatLng};
use heatmap_aircraft::accumulator::TileAccumulator;
use heatmap_aircraft::grid::tile_range;
use heatmap_aircraft::region_runner::{read_r4_file, region_tiles, tile_centre_r4};
use heatmap_aircraft::source_line::LineRow;
use heatmap_aircraft::source_loader_rail::RailData;
use heatmap_aircraft::source_loader_road::RoadData;
use heatmap_aircraft::wire_hm3::{
    collapse_lden_surface_u8, read_tile, write_tile, SOURCE_ID_RAIL, SOURCE_ID_ROAD,
};
use noise_compute::admin;
use noise_compute::constants::RAILWAY_MAX_RADIUS;
use noise_gpu::{pack_sources, pack_tile, TileBuffers, BIN_W, N_BINS};
use raster_reader::fused_tile_z13::{default_batch_size, TileBatch, TILE_PX};
use raster_reader::RealRasters;

const SCATTER_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/scatter.ptx"));
const NO_DATA: u8 = 255;
const ROAD_HALO_M: f64 = 10_000.0; // motorway-class reach (matches build_heatmap_surface)
const ETA: f64 = 0.40; // energy-budget skip threshold (production default)
const TW: f64 = 8.0; // pack_tile swizzle width — the binned kernel ignores it (only
                     // the un-binned `rail` bench kernel in e2-full swizzles by it)

#[derive(Clone, Copy, PartialEq, Eq)]
enum LineLayer {
    Road,
    Rail,
}

impl LineLayer {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "road" => Ok(Self::Road),
            "rail" => Ok(Self::Rail),
            _ => bail!("unknown line layer {s:?} (road|rail)"),
        }
    }
    fn dir(self) -> &'static str {
        match self {
            Self::Road => "road",
            Self::Rail => "rail",
        }
    }
    fn source_id(self) -> u8 {
        match self {
            Self::Road => SOURCE_ID_ROAD,
            Self::Rail => SOURCE_ID_RAIL,
        }
    }
    /// Per-layer reach; the kernel still culls each source at its own
    /// `max_distance_m`, so a block's shared halo can use the widest of these
    /// without changing a shorter-reach layer's output.
    fn halo_m(self) -> f64 {
        match self {
            Self::Road => ROAD_HALO_M,
            Self::Rail => RAILWAY_MAX_RADIUS,
        }
    }
    /// Load this layer's `grid_disk(1)` line rows for a region. Road resolves the
    /// admin area for its default-AADT fallback; rail has no admin dependency.
    fn load_rows(self, h3r4: &Path, ring: &[u64], cell: CellIndex) -> Result<Vec<LineRow>> {
        Ok(match self {
            Self::Road => {
                let ll = LatLng::from(cell);
                let admin = admin::admin_for_latlng(ll.lat(), ll.lng());
                RoadData::load_for_r4s(h3r4, ring, admin)
                    .context("load roads")?
                    .into_rows()
            }
            Self::Rail => RailData::load_for_r4s(h3r4, ring)
                .context("load rail")?
                .into_rows(),
        })
    }
}

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// Per-layer end-to-end counters (timings in seconds, summed over tiles).
#[derive(Default)]
struct LayerStat {
    t_kernel: f64,
    t_bins: f64,
    t_load: f64,
    max_diff: i32,
    n_diff: usize,
    n_cmp: usize, // both-present cells compared (drift-gate denominator)
    n_le1: usize, // |Δ| ≤ 1 byte (0.5 dB)
    n_le3: usize, // |Δ| ≤ 3 bytes (1.5 dB)
    n_baseline: usize,
    n_written: usize,
    n_tiles: usize,
}

struct Cfg {
    z: u8,
    batch_n: u32,
    halo_m: f64,
    h3r4: PathBuf,
    baseline: String,
    output: Option<String>,
}

/// Heartbeat so a multi-block region build is observable, not a silent wait.
struct Progress {
    done: usize,
    total: usize,
    last_beat: Instant,
}

impl Progress {
    fn tick(&mut self) {
        self.done += 1;
        if self.last_beat.elapsed().as_secs() >= 30 {
            eprintln!(
                "  … {}/{} tile-layers ({:.0}%)",
                self.done,
                self.total,
                self.done as f64 / self.total.max(1) as f64 * 100.0
            );
            self.last_beat = Instant::now();
        }
    }
}

/// A layer's GPU-resident source buffers (`seg`, `sp`, `semis`), uploaded once per
/// region (by the caller) and shared across every block/tile of that region.
type LayerSrc = (LineLayer, (CudaSlice<f64>, CudaSlice<f64>, CudaSlice<f32>));

/// Build one grid-aligned block's shared halo once, upload it, then compute every
/// `(tile, layer)` in `block_tiles` on the GPU using the region's pre-loaded rows
/// and pre-uploaded sources (`src_dev`) — both loaded/uploaded once per centre-R4
/// region by the caller, not re-read or re-uploaded per block or tile.
#[allow(clippy::too_many_arguments)]
fn process_block(
    dev: &Arc<CudaDevice>,
    f: &CudaFunction,
    rasters: &RealRasters,
    cfg: &Cfg,
    bx: u32,
    by: u32,
    block_tiles: &[(u32, u32)],
    region_rows: &[(LineLayer, Vec<LineRow>)],
    src_dev: &[LayerSrc],
    stats: &mut BTreeMap<&'static str, LayerStat>,
    prog: &mut Progress,
) -> Result<()> {
    let batch = TileBatch::build(cfg.z, bx, by, cfg.batch_n, cfg.halo_m, rasters);
    let halo = &batch.tiles[0].halo;
    let halo_geom = halo.geom();
    let (_, _, _, rows, cols) = halo_geom;

    let elev: Vec<f32> = halo.pixels().iter().map(|p| p.elevation).collect();
    let mut cover = Vec::with_capacity(rows * cols * 3);
    for p in halo.pixels() {
        cover.push(p.building);
        cover.push(p.forest);
        cover.push(p.imd);
    }
    let d_elev = dev.htod_copy(elev).expect("elev");
    let d_cover = dev.htod_copy(cover).expect("cover");
    let n = TILE_PX * TILE_PX;
    let mut d_out = dev.alloc_zeros::<f32>(n * 3).expect("out");
    let launch_cfg = LaunchConfig {
        grid_dim: (N_BINS as u32, 1, 1),
        block_dim: ((BIN_W * BIN_W) as u32, 1, 1),
        shared_mem_bytes: 0,
    };

    // Software pipeline: a CUDA launch is async, so while tile N's kernel runs on
    // the GPU we bin+pack tile N+1 on the CPU (the cores otherwise idle during the
    // GPU wait). Single-threaded; dtoh_sync_copy is the join that waits for the
    // kernel. Same per-(tile,layer) work in the same order ⇒ identical output.
    // Order by LAYER first (all road, then all rail), not interleaved: the pipeline
    // overlaps tile N+1's prep with tile N's kernel, so consecutive same-layer items
    // (similar kernel ≈ similar prep cost) overlap far better than road↔rail swings.
    let items: Vec<(u32, u32, LineLayer)> = region_rows
        .iter()
        .flat_map(|(l, _)| block_tiles.iter().map(move |&(tx, ty)| (tx, ty, *l)))
        .collect();
    // GPU-side binning: the kernel (line_binned_fused) does the per-block source cull
    // itself, so per-tile prep is just the pack — no CPU build_pixel_bins (the old
    // prep-bound bottleneck). t_bins now measures only pack_tile (sub-ms).
    let prep = |it: (u32, u32, LineLayer)| -> TileBuffers {
        let (tx, ty, _layer) = it;
        let tile = &batch.tiles[((ty - by) * cfg.batch_n + (tx - bx)) as usize];
        pack_tile(tile, halo_geom, ETA, TW)
    };
    let prep_timed = |it: (u32, u32, LineLayer), stats: &mut BTreeMap<&'static str, LayerStat>| {
        let t = Instant::now();
        let p = prep(it);
        stats.entry(it.2.dir()).or_default().t_bins += t.elapsed().as_secs_f64();
        (it, p)
    };

    let mut iter = items.into_iter();
    let mut pending = iter.next().map(|it| prep_timed(it, stats));
    while let Some(((tx, ty, layer), bufs)) = pending {
        let tk = Instant::now();
        let d_inner = dev.htod_copy(bufs.inner).expect("inner");
        let d_meta = dev.htod_copy(bufs.meta).expect("meta");
        // Region-resident sources (uploaded once per layer above) — not re-uploaded per tile.
        let (d_seg, d_sp, d_semis) = &src_dev
            .iter()
            .find(|(l, _)| *l == layer)
            .expect("layer src")
            .1;
        // nsrc for this layer — the fused kernel scans [0, nsrc) and culls per block
        // (replaces the CPU CSR bins; same count for every tile of the layer).
        let nsrc = region_rows
            .iter()
            .find(|(l, _)| *l == layer)
            .expect("layer")
            .1
            .len() as i32;
        let d_rxll = dev.htod_copy(bufs.rxll).expect("rxll");
        let d_rxar = dev.htod_copy(bufs.rxar).expect("rxar");
        unsafe {
            f.clone()
                .launch(
                    launch_cfg,
                    (
                        &d_elev, &d_inner, &d_cover, &d_meta, d_seg, d_sp, d_semis, &d_rxll,
                        &d_rxar, nsrc, &mut d_out,
                    ),
                )
                .expect("launch");
        }
        // Overlap: prep the NEXT item on the CPU while this kernel runs on the GPU.
        pending = iter.next().map(|it| prep_timed(it, stats));
        // Join: dtoh_sync_copy waits for the kernel, then reads the result back.
        let gpu = dev.dtoh_sync_copy(&d_out).expect("dtoh");
        stats.entry(layer.dir()).or_default().t_kernel += tk.elapsed().as_secs_f64();

        let mut accum = TileAccumulator::new();
        accum.energy.copy_from_slice(&gpu);
        let cells = collapse_lden_surface_u8(&accum);

        if let Some(root) = &cfg.output {
            let out = Path::new(root)
                .join(layer.dir())
                .join(cfg.z.to_string())
                .join(tx.to_string())
                .join(format!("{ty}.bin"));
            if write_tile(&out, &cells, layer.source_id(), true)? > 0 {
                stats.entry(layer.dir()).or_default().n_written += 1;
            } else if out.exists() {
                // Rebuilt all-silent: unlink any stale tile a prior build left, else
                // combine keeps summing stale GPU energy (mirrors build_heatmap_surface).
                std::fs::remove_file(&out)
                    .with_context(|| format!("rm stale {}", out.display()))?;
            }
        }
        if !cfg.baseline.is_empty() {
            let bp = Path::new(&cfg.baseline)
                .join(layer.dir())
                .join(cfg.z.to_string())
                .join(tx.to_string())
                .join(format!("{ty}.bin"));
            if bp.exists() {
                let b = read_tile(&bp)?;
                let st = stats.entry(layer.dir()).or_default();
                for ci in 0..cells.len().min(b.len()) {
                    let (c, bb) = (cells[ci], b[ci]);
                    let differ = if c != NO_DATA && bb != NO_DATA {
                        let d = (c as i32 - bb as i32).abs();
                        st.max_diff = st.max_diff.max(d);
                        st.n_cmp += 1;
                        if d <= 1 {
                            st.n_le1 += 1;
                        }
                        if d <= 3 {
                            st.n_le3 += 1;
                        }
                        d > 0
                    } else {
                        c != bb
                    };
                    if differ {
                        st.n_diff += 1;
                    }
                }
                st.n_baseline += 1;
            }
        }
        stats.entry(layer.dir()).or_default().n_tiles += 1;
        prog.tick();
    }
    Ok(())
}

fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // Index-based parse: each known flag consumes the NEXT token (which must exist
    // and not itself be a flag); everything else is a positional. Tracking by
    // position (not value) avoids dropping a positional that equals a flag's value.
    let (mut output, mut bbox, mut layers_s, mut batch_s, mut regions_file) =
        (None, None, None, None, None);
    let mut pos: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "--output" | "--bbox" | "--layers" | "--batch" | "--regions-file" => {
                let v = argv
                    .get(i + 1)
                    .filter(|s| !s.starts_with("--"))
                    .cloned()
                    .with_context(|| format!("{a} needs a value"))?;
                match a {
                    "--output" => output = Some(v),
                    "--bbox" => bbox = Some(v),
                    "--layers" => layers_s = Some(v),
                    "--regions-file" => regions_file = Some(v),
                    _ => batch_s = Some(v),
                }
                i += 2;
            }
            s if s.starts_with("--") => bail!("unknown flag {s}"),
            _ => {
                pos.push(argv[i].clone());
                i += 1;
            }
        }
    }
    let layers: Vec<LineLayer> = layers_s
        .as_deref()
        .unwrap_or("rail")
        .split(',')
        .map(LineLayer::parse)
        .collect::<Result<_>>()?;

    let z = 13u8;
    let prepared = env("NOISE_GPU_PREPARED", "/dev/shm/qmap/prepared");
    let baseline = env("NOISE_GPU_BASELINE", ""); // empty ⇒ no diff (production)
    let year = env("DATA_YEAR", "2026");
    let h3r4 = PathBuf::from(format!("{prepared}/{year}/h3r4"));
    // Shared halo = the widest reach among the requested layers (road 10 km),
    // overridable for benchmarking; a shorter-reach layer culls at its own reach.
    let halo_m: f64 = match std::env::var("NOISE_GPU_HALO_M") {
        Ok(v) => v.parse()?,
        Err(_) => layers.iter().map(|l| l.halo_m()).fold(0.0, f64::max),
    };
    let batch_n: u32 = match batch_s {
        Some(s) => s.parse()?,
        None => default_batch_size(),
    };
    if batch_n == 0 {
        bail!("--batch / block size must be >= 1");
    }

    if layers.contains(&LineLayer::Road) {
        let _ = admin::init_admin_table(&admin::default_admin_path(&h3r4));
    }

    // Target tiles → grouped by centre R4 so each region's rows load ONCE
    // (~36 tiles share an R4), not re-read per tile; each region then batches into
    // grid-aligned halo blocks. Build `regions` directly in both modes so
    // n_targets counts exactly the valid tiles that get built.
    let mut regions: BTreeMap<u64, Vec<(u32, u32)>> = BTreeMap::new();
    let (blk_n, mode) = if let Some(rf) = &regions_file {
        // Cluster per-chunk unit: build exactly the listed output R4s' owned tiles
        // (centre-R4 ownership, same contract as build_heatmap_surface --regions-file).
        for r4 in read_r4_file(Path::new(rf))? {
            regions.insert(r4, region_tiles(r4, z));
        }
        (
            batch_n,
            format!("regions-file {rf} ({} R4s)", regions.len()),
        )
    } else if let Some(b) = &bbox {
        let v: Vec<f64> = b.split(',').map(|s| s.parse()).collect::<Result<_, _>>()?;
        if v.len() != 4 || v[0] >= v[2] || v[1] >= v[3] {
            bail!("--bbox needs south,west,north,east with south<north and west<east");
        }
        let (xr, yr) = tile_range(z, v[0], v[1], v[2], v[3]);
        for ty in yr {
            for tx in xr.clone() {
                if let Some(r4) = tile_centre_r4(z, tx, ty) {
                    regions.entry(r4).or_default().push((tx, ty));
                }
            }
        }
        (batch_n, format!("bbox {b}"))
    } else {
        let (bx_in, by_in): (u32, u32) = (
            pos.first().context("need <base_x> or --bbox")?.parse()?,
            pos.get(1).context("need <base_y>")?.parse()?,
        );
        let bn: u32 = match pos.get(2) {
            Some(s) => s.parse()?,
            None => 4,
        };
        if bn == 0 {
            bail!("block size must be >= 1");
        }
        // Snap to the grid the bbox/CPU runners batch on, so a dev block's shared
        // halo matches theirs (else diffing vs an aligned baseline drifts spuriously).
        let (base_x, base_y) = ((bx_in / bn) * bn, (by_in / bn) * bn);
        if (base_x, base_y) != (bx_in, by_in) {
            eprintln!(
                "note: snapped block origin {bx_in}/{by_in} → {base_x}/{base_y} (grid-aligned)"
            );
        }
        for dy in 0..bn {
            for dx in 0..bn {
                if let Some(r4) = tile_centre_r4(z, base_x + dx, base_y + dy) {
                    regions
                        .entry(r4)
                        .or_default()
                        .push((base_x + dx, base_y + dy));
                }
            }
        }
        (bn, format!("block {base_x}/{base_y} n={bn}"))
    };
    if regions.is_empty() {
        bail!("no tiles to build (no valid z{z} tiles in range)");
    }
    let n_targets: usize = regions.values().map(Vec::len).sum();
    let layer_names: Vec<&str> = layers.iter().map(|l| l.dir()).collect();
    eprintln!(
        "{mode} | {} region(s), {n_targets} tile(s), layers={:?}, halo={halo_m:.0} m, batch={blk_n}",
        regions.len(),
        layer_names,
    );

    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(Ptx::from_src(SCATTER_PTX), "s", &["line_binned_fused"])
        .expect("ptx");
    let f = dev.get_func("s", "line_binned_fused").expect("fn");

    let cfg = Cfg {
        z,
        batch_n: blk_n,
        halo_m,
        h3r4,
        baseline,
        output: output.clone(),
    };
    let mut stats: BTreeMap<&'static str, LayerStat> = BTreeMap::new();
    let mut prog = Progress {
        done: 0,
        total: n_targets * layers.len(),
        last_beat: Instant::now(),
    };
    let rasters = RealRasters::new(Path::new(&prepared));
    let t_all = Instant::now();
    for (&r4, region_tiles) in &regions {
        // Load every requested layer's rows ONCE for this region (grid_disk(1)).
        let cell = CellIndex::try_from(r4)?;
        let ring: Vec<u64> = cell
            .grid_disk::<Vec<_>>(1)
            .into_iter()
            .map(u64::from)
            .collect();
        let mut region_rows: Vec<(LineLayer, Vec<LineRow>)> = Vec::with_capacity(layers.len());
        for &layer in &layers {
            let tl = Instant::now();
            let r = layer.load_rows(&cfg.h3r4, &ring, cell)?;
            stats.entry(layer.dir()).or_default().t_load += tl.elapsed().as_secs_f64();
            region_rows.push((layer, r));
        }
        // Upload each layer's sources to the GPU ONCE for this region; every block
        // and tile reuses them (was re-uploaded per tile → ~30× redundant PCIe/CPU).
        let src_dev: Vec<LayerSrc> = region_rows
            .iter()
            .map(|(layer, rows)| {
                let s = pack_sources(rows);
                (
                    *layer,
                    (
                        dev.htod_copy(s.seg).expect("seg"),
                        dev.htod_copy(s.sp).expect("sp"),
                        dev.htod_copy(s.semis).expect("semis"),
                    ),
                )
            })
            .collect();
        // Batch the region's tiles into grid-aligned blocks (one shared halo each).
        let mut blocks: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
        for &(tx, ty) in region_tiles {
            blocks
                .entry(((tx / blk_n) * blk_n, (ty / blk_n) * blk_n))
                .or_default()
                .push((tx, ty));
        }
        for (&(bx, by), block_tiles) in &blocks {
            process_block(
                &dev,
                &f,
                &rasters,
                &cfg,
                bx,
                by,
                block_tiles,
                &region_rows,
                &src_dev,
                &mut stats,
                &mut prog,
            )?;
        }
    }
    let wall = t_all.elapsed().as_secs_f64();

    eprintln!(
        "=== {n_targets} tile(s) × {} layer(s) in {wall:.2}s ===",
        layers.len()
    );
    for (name, s) in &stats {
        // gpu = the GPU-phase wall (upload + launch + sync); prep = bin + pack. The
        // pipeline OVERLAPS prep(N+1) with gpu(N), so wall < gpu + prep — the
        // top-line wall is the real cost, these are diagnostic, not additive.
        eprintln!(
            "  [{name}] {} tiles | gpu {:.0} ms | prep {:.0} ms | load {:.0} ms | written {} (gpu∥prep)",
            s.n_tiles,
            s.t_kernel * 1e3,
            s.t_bins * 1e3,
            s.t_load * 1e3,
            s.n_written,
        );
        if s.n_baseline > 0 {
            let denom = s.n_cmp.max(1) as f64;
            eprintln!(
                "          vs baseline: {} tiles, max {}B ({:.1} dB), {} cells differ | ≤1B {:.3}% ≤3B {:.3}% of {} cmp",
                s.n_baseline,
                s.max_diff,
                s.max_diff as f64 * 0.5,
                s.n_diff,
                100.0 * s.n_le1 as f64 / denom,
                100.0 * s.n_le3 as f64 / denom,
                s.n_cmp,
            );
        }
    }
    if let Some(root) = &output {
        eprintln!("  → HM3 under {root}/{{{}}}/{z}", layer_names.join(","));
    }
    Ok(())
}
