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
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
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
use heatmap_aircraft::source_loader_barrier::BarrierData;
use heatmap_aircraft::source_loader_rail::RailData;
use heatmap_aircraft::source_loader_road::RoadData;
use heatmap_aircraft::wire_hm3::{
    collapse_lden_surface_u8, read_tile, write_tile, SOURCE_ID_RAIL, SOURCE_ID_ROAD,
};
use noise_compute::admin;
use noise_compute::constants::RAILWAY_REACH_CEILING;
use noise_gpu::{pack_sources, pack_tile, TileBuffers, BIN_W, N_BINS};
use raster_reader::fused_tile_z13::{default_batch_size, TileBatch, TILE_PX};
use raster_reader::RealRasters;
use rayon::prelude::*;

const SCATTER_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/scatter.ptx"));
const NO_DATA: u8 = 255;
const ROAD_HALO_M: f64 = 10_000.0; // motorway-class reach (matches build_heatmap_surface)
const ETA: f64 = 0.40; // energy-budget skip threshold (production default)
const TW: f64 = 8.0; // pack_tile swizzle width — the binned kernel ignores it (only
                     // the un-binned `rail` bench kernel in e2-full swizzles by it)

thread_local! {
    /// One `RealRasters` per rayon worker, REUSED across every region/cell — vs the old
    /// per-region `map_init` that rebuilt it each region, dropping the mmap-LRU cache cold (the
    /// "no cross-cell raster reuse" the rewrite flagged). TileStore caches are per-thread (no
    /// shared-cache race); persisting them keeps a Morton-adjacent cell's shared 1° DEM / raster
    /// tiles mmap-warm, and a cell overflowing into a neighbour's tile mmaps it once for the next.
    /// LRU-bounded (raster-reader), so it never grows over a multi-day --stream run.
    static RASTERS: RefCell<Option<RealRasters>> = const { RefCell::new(None) };
}

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
    /// Per-layer halo reach; the kernel still culls each source at its own
    /// per-row `max_distance_m` (the rail loader bakes each segment's solved
    /// 25 dB reach), so a block's shared halo can use the widest of these
    /// without changing a shorter-reach layer's output. Rail uses the per-row
    /// reach CEILING so a row extended to the clamp still ray-marches terrain
    /// along its whole path.
    fn halo_m(self) -> f64 {
        match self {
            Self::Road => ROAD_HALO_M,
            Self::Rail => RAILWAY_REACH_CEILING,
        }
    }
    /// Load this layer's `grid_disk(1)` line rows for a region. Road resolves the
    /// admin area for its default-AADT fallback; rail for the C1 per-region period
    /// split (EU freight ~55 % at night). The admin lookup is hoisted OUT of the
    /// match so it reaches `RailData::load_for_r4s` too (Gemini delta 5).
    fn load_rows(self, h3r4: &Path, ring: &[u64], cell: CellIndex) -> Result<Vec<LineRow>> {
        let ll = LatLng::from(cell);
        let admin = admin::admin_for_latlng(ll.lat(), ll.lng());
        Ok(match self {
            Self::Road => RoadData::load_for_r4s(h3r4, ring, admin)
                .context("load roads")?
                .into_rows(),
            Self::Rail => RailData::load_for_r4s(h3r4, ring, admin)
                .context("load rail")?
                .into_rows(),
        })
    }
}

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// CUDA device + scatter PTX, created once — shared by the batch path and --stream (the warm
/// context the cluster used to re-pay on every chunk spawn).
fn warm_device() -> (Arc<CudaDevice>, CudaFunction) {
    warm_device_on(false)
}

/// `with_stream` ⇒ `CudaDevice::new_with_stream` (own stream, shared primary context) so the N
/// --stream workers OVERLAP on the GPU (the gpu_airborne pattern, airborne.rs:252); `false` ⇒ the
/// null-stream device the serial batch path uses. Each call gets its own scatter-PTX module load.
fn warm_device_on(with_stream: bool) -> (Arc<CudaDevice>, CudaFunction) {
    let dev = if with_stream {
        CudaDevice::new_with_stream(0).expect("cuda")
    } else {
        CudaDevice::new(0).expect("cuda")
    };
    dev.load_ptx(Ptx::from_src(SCATTER_PTX), "s", &["line_binned_fused"])
        .expect("ptx");
    let f = dev.get_func("s", "line_binned_fused").expect("fn");
    (dev, f)
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
    /// `QM_GPU_BARRIERS=1` — upload each region's `barriers.arrow` walls so the
    /// kernel screens them on the GPU (the vector projection-and-snap in
    /// `line_source`; mean 0.002 / max 1.5 dB vs the CPU vector path).
    /// PRODUCTION runs this ON: the cluster (cluster-build-chunk.sh) forces
    /// `QM_GPU_BARRIERS=1` (owner-directed 2026-06-13), so every GPU surface build
    /// screens its own barriers and the C9 CPU-routing gate is a no-op. The
    /// BINARY's own env default is OFF (a bare `gpu-surface` is barrier-blind:
    /// every tile packs an empty slice, `nbarr == 0`, the kernel barrier loop
    /// no-ops, byte-identical to the barrier-blind lane) — that OFF baseline is
    /// the reference `tests/barrier_screening.rs` compares ON against. So:
    /// cluster default ON, bare-binary default OFF. See the spike record
    /// (.claude/plans/heatmap-orchestrator-audit/).
    barriers_enabled: bool,
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
            if self.total > 0 {
                eprintln!(
                    "  … {}/{} tile-layers ({:.0}%)",
                    self.done,
                    self.total,
                    self.done as f64 / self.total as f64 * 100.0
                );
            } else {
                eprintln!("  … {} tile-layers built (stream)", self.done);
            }
            self.last_beat = Instant::now();
        }
    }
}

/// A layer's GPU-resident source buffers (`seg`, `sp`, `semis`), uploaded once per
/// region (by the caller) and shared across every block/tile of that region.
type LayerSrc = (LineLayer, (CudaSlice<f64>, CudaSlice<f64>, CudaSlice<f32>));

/// Compute every `(tile, layer)` in `block_tiles` on the GPU, using the caller-built
/// shared halo (`batch`, cropped in parallel across the region's blocks), the region's
/// pre-loaded rows, and pre-uploaded sources (`src_dev`) — all built/uploaded once per
/// centre-R4 region by the caller, not re-read or re-uploaded per block or tile.
#[allow(clippy::too_many_arguments)]
fn process_block(
    dev: &Arc<CudaDevice>,
    f: &CudaFunction,
    batch: &TileBatch,
    cfg: &Cfg,
    bx: u32,
    by: u32,
    block_tiles: &[(u32, u32)],
    region_rows: &[(LineLayer, Vec<LineRow>)],
    src_dev: &[LayerSrc],
    barriers: &BarrierData,
    stats: &mut BTreeMap<&'static str, LayerStat>,
    prog: &mut Progress,
) -> Result<()> {
    let halo = &batch.tiles[0].halo;
    let halo_geom = halo.geom();
    let (_, _, _, rows, cols) = halo_geom;

    let elev: Vec<f32> = halo.pixels().iter().map(|p| p.elevation).collect();
    // Noise barriers reach the kernel as the VECTOR per-tile `for_tile` slice
    // (projection-and-snap inside line_source), never as a raster burn —
    // `FusedGrid::burn_building_max` was measured acoustically unsound (the ray
    // cadence steps over a one-cell-thin wall on most paths; mean +3.7 / max
    // +13.8 dB under-screening; decision record: heatmap-aircraft
    // tests/barrier_screening.rs).
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
    // prep-bound bottleneck). t_bins now measures only pack_tile (sub-ms). The
    // per-tile barrier slice rides along: reach-culled + sorted by for_tile, so
    // the kernel's early-break scans only the walls a path can actually reach.
    let prep = |it: (u32, u32, LineLayer)| -> TileBuffers {
        let (tx, ty, _layer) = it;
        let tile = &batch.tiles[((ty - by) * cfg.batch_n + (tx - bx)) as usize];
        let tile_barriers = barriers.for_tile(&tile.bbox, cfg.halo_m);
        pack_tile(tile, halo_geom, ETA, TW, &tile_barriers)
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
        let d_barr = dev.htod_copy(bufs.barr).expect("barr");
        unsafe {
            f.clone()
                .launch(
                    launch_cfg,
                    (
                        &d_elev, &d_inner, &d_cover, &d_meta, d_seg, d_sp, d_semis, &d_rxll,
                        &d_rxar, &d_barr, nsrc, &mut d_out,
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

/// Build one centre-R4 region's owned tiles for every layer — the shared body of the batch loop
/// and the --stream loop. Loads the region's grid_disk(1) rows + barriers once, uploads sources
/// once, crops blocks in parallel (reusing each worker's persistent RealRasters), then runs the
/// sequential GPU kernel loop. Returns (written, skipped) tile-layers for the `done` line.
#[allow(clippy::too_many_arguments)]
fn process_region(
    r4: u64,
    region_tiles: &[(u32, u32)],
    layers: &[LineLayer],
    cfg: &Cfg,
    dev: &Arc<CudaDevice>,
    f: &CudaFunction,
    prepared: &str,
    stats: &mut BTreeMap<&'static str, LayerStat>,
    prog: &mut Progress,
) -> Result<(usize, usize)> {
    let total = region_tiles.len() * layers.len();
    let written0: usize = stats.values().map(|s| s.n_written).sum();
    // Load every requested layer's rows ONCE for this region (grid_disk(1)).
    let cell = CellIndex::try_from(r4)?;
    let ring: Vec<u64> = cell
        .grid_disk::<Vec<_>>(1)
        .into_iter()
        .map(u64::from)
        .collect();
    let mut region_rows: Vec<(LineLayer, Vec<LineRow>)> = Vec::with_capacity(layers.len());
    for &layer in layers {
        let tl = Instant::now();
        let r = layer.load_rows(&cfg.h3r4, &ring, cell)?;
        stats.entry(layer.dir()).or_default().t_load += tl.elapsed().as_secs_f64();
        region_rows.push((layer, r));
    }
    // Skip a region whose grid_disk(1) ring holds NO line sources (every tile all-silent);
    // preserve the all-silent cleanup so a direct-to-OUTPUT rebuild drops a prior build's tiles.
    if region_rows.iter().all(|(_, rows)| rows.is_empty()) {
        if let Some(root) = &cfg.output {
            for &(tx, ty) in region_tiles {
                for l in layers {
                    let _ = std::fs::remove_file(
                        Path::new(root)
                            .join(l.dir())
                            .join(cfg.z.to_string())
                            .join(tx.to_string())
                            .join(format!("{ty}.bin")),
                    );
                }
            }
        }
        prog.done += total;
        return Ok((0, total));
    }
    let barrier_data = if cfg.barriers_enabled {
        BarrierData::load_for_r4s(&cfg.h3r4, &ring).context("load barriers")?
    } else {
        BarrierData::from_segments(Vec::new())
    };
    // Upload each layer's sources to the GPU ONCE for this region.
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
            .entry((
                (tx / cfg.batch_n) * cfg.batch_n,
                (ty / cfg.batch_n) * cfg.batch_n,
            ))
            .or_default()
            .push((tx, ty));
    }
    // Crop every block's shared halo in PARALLEL over a SHARED rayon pool, REUSING each rayon worker's
    // persistent RealRasters (RASTERS thread-local) so the mmap-LRU stays warm. With the FIXED-N=2 outer
    // --stream workers this stays bounded: both submit to the ONE global pool, so it's ≤ pool-size (≈cores)
    // RealRasters TOTAL, not per outer worker — and the crop uses all cores instead of one, which a serial
    // crop starved on a crop-bound box (the i9/2080ti: dense cells, weak GPU → crop is the bottleneck). The
    // GPU kernel loop below stays SEQUENTIAL over the SAME sorted block order, so output is byte-identical.
    let block_keys: Vec<(u32, u32)> = blocks.keys().copied().collect();
    let batches: Vec<((u32, u32), TileBatch)> = block_keys
        .par_iter()
        .map(|&(bx, by)| {
            RASTERS.with(|slot| {
                let mut slot = slot.borrow_mut();
                let rasters = slot.get_or_insert_with(|| RealRasters::new(Path::new(prepared)));
                (
                    (bx, by),
                    TileBatch::build(cfg.z, bx, by, cfg.batch_n, cfg.halo_m, rasters),
                )
            })
        })
        .collect();
    for (key, batch) in &batches {
        let (bx, by) = *key;
        process_block(
            dev,
            f,
            batch,
            cfg,
            bx,
            by,
            &blocks[key],
            &region_rows,
            &src_dev,
            &barrier_data,
            stats,
            prog,
        )?;
    }
    let written: usize = stats.values().map(|s| s.n_written).sum::<usize>() - written0;
    Ok((written, total.saturating_sub(written)))
}

/// STREAM mode (`--stream`): the persistent warm surface worker the cluster orchestrator feeds.
/// CUDA context + scatter PTX + admin table resident, and — the STEP-2 win — ONE RealRasters per
/// rayon worker reused across the whole cell stream (RASTERS thread-local), so the mmap-LRU stays
/// warm instead of being rebuilt per region. Reads output R4 cell IDs (one hex/line) from stdin,
/// builds each cell's owned tiles, and prints `done <r4hex> <written> <skipped> <ms>` (or
/// `fail <r4hex> <err>`) as it finishes — the SAME line protocol as gpu-airborne --stream, so the
/// box agent drives either worker identically.
#[allow(clippy::too_many_arguments)]
fn run_stream(
    z: u8,
    layers: &[LineLayer],
    halo_m: f64,
    batch_n: u32,
    h3r4: PathBuf,
    baseline: String,
    output: Option<String>,
    prepared: &str,
) -> Result<()> {
    use std::collections::VecDeque;
    use std::sync::{Condvar, Mutex};
    let barriers_enabled = env("QM_GPU_BARRIERS", "0") == "1";
    if barriers_enabled {
        eprintln!("QM_GPU_BARRIERS=1 — kernel vector-barrier screening ENABLED");
    }
    let cfg = Cfg {
        z,
        batch_n,
        halo_m,
        h3r4,
        baseline,
        output,
        barriers_enabled,
    };
    // FIXED N (default 2, NOT rayon thread count): each worker holds a whole region's source uploads +
    // per-tile GPU scratch on its own stream + its own RealRasters, so N is bounded by VRAM/RAM, not
    // cores (codex: a halo-only cap is unsafe). 2 fits the 12 GB cards; QM_GPU_STREAM_WORKERS overrides.
    let n_workers: usize = env("QM_GPU_STREAM_WORKERS", "2")
        .parse()
        .unwrap_or(2)
        .max(1);
    let names: Vec<&str> = layers.iter().map(|l| l.dir()).collect();
    eprintln!(
        "stream: layers={names:?}, halo={halo_m:.0}m, batch={batch_n}, {n_workers} worker(s) — reading R4 cells from stdin"
    );

    // Morton-locality streaming pool (mirrors gpu_airborne run_stream): a reader thread fills a shared
    // queue in arrival (= the orchestrator's Morton) order; each warm worker pops ONE cell per lock
    // acquire, so its serial-crop RealRasters keeps the grid_disk(1) ring-cache warm across the cells it
    // builds while every CUDA stream stays fed (no worker monopolizes a batch).
    // (queue of pending cells, stream-closed flag) + a condvar — same shape as gpu_airborne::StreamQueue.
    type Work = Arc<(Mutex<(VecDeque<u64>, bool)>, Condvar)>;
    let work: Work = Arc::new((Mutex::new((VecDeque::new(), false)), Condvar::new()));
    let out = Arc::new(Mutex::new(std::io::stdout()));

    let reader_work = Arc::clone(&work);
    // DETACHED (not joined): on a broken-pipe abort the workers exit while this thread may still be
    // blocked in stdin.lines() with stdin open — joining it would deadlock main (gg-gemini CRITICAL).
    // On normal EOF it sets closed + returns; either way the OS reaps it when main returns.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let hex = line.trim();
            if hex.is_empty() {
                continue;
            }
            match u64::from_str_radix(hex, 16) {
                Ok(r4) => {
                    let (lock, cv) = &*reader_work;
                    lock.lock().unwrap().0.push_back(r4);
                    cv.notify_one();
                }
                Err(_) => eprintln!("stream: skip non-hex line: {hex}"),
            }
        }
        let (lock, cv) = &*reader_work;
        lock.lock().unwrap().1 = true; // EOF → wake workers to drain the tail + exit
        cv.notify_all();
    });

    let cfg = &cfg;
    std::thread::scope(|scope| {
        for _ in 0..n_workers {
            let work = Arc::clone(&work);
            let out = Arc::clone(&out);
            scope.spawn(move || {
                // Warm per-worker state: own CUDA stream (overlaps on the GPU) + own RealRasters (the
                // serial crop reuses it, mmap-LRU stays warm) + own stats/prog (worker-local, gg).
                // Safe under UNIQUE centre-R4 ownership (the scheduler leases each cell once per stream):
                // each cell's output tiles are disjoint, so two workers never write the same .bin (gg-codex).
                let (dev, f) = warm_device_on(true);
                let mut stats: BTreeMap<&'static str, LayerStat> = BTreeMap::new();
                let mut prog = Progress {
                    done: 0,
                    total: 0,
                    last_beat: Instant::now(),
                };
                loop {
                    let cell: Option<u64> = {
                        let (lock, cv) = &*work;
                        let mut g = lock.lock().unwrap();
                        loop {
                            if let Some(r4) = g.0.pop_front() {
                                break Some(r4);
                            }
                            if g.1 {
                                break None; // stream closed + drained → exit
                            }
                            g = cv.wait(g).unwrap();
                        }
                    };
                    let Some(r4) = cell else { break };
                    let t = Instant::now();
                    let tiles = region_tiles(r4, z);
                    let line = match process_region(
                        r4, &tiles, layers, cfg, &dev, &f, prepared, &mut stats, &mut prog,
                    ) {
                        Ok((w, s)) => format!("done {r4:x} {w} {s} {}", t.elapsed().as_millis()),
                        Err(e) => format!("fail {r4:x} {e}"),
                    };
                    let mut o = out.lock().unwrap();
                    let ok = writeln!(o, "{line}").is_ok() && o.flush().is_ok();
                    drop(o);
                    if !ok {
                        // downstream (the box-agent) closed its read end → stop the build, exactly
                        // as the old serial path's `writeln!(…)?` did: signal EOF so every worker drains
                        // and exits, instead of spinning on a dead pipe.
                        let (lock, cv) = &*work;
                        let mut g = lock.lock().unwrap();
                        g.1 = true;
                        g.0.clear(); // drop pending cells so peers exit NOW, not after wasted builds
                        drop(g);
                        cv.notify_all();
                        break;
                    }
                }
            });
        }
    });
    Ok(())
}

fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // Index-based parse: each known flag consumes the NEXT token (which must exist
    // and not itself be a flag); everything else is a positional. Tracking by
    // position (not value) avoids dropping a positional that equals a flag's value.
    let (mut output, mut bbox, mut layers_s, mut batch_s, mut regions_file) =
        (None, None, None, None, None);
    let mut stream = false;
    let mut pos: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "--stream" => {
                stream = true;
                i += 1;
            }
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

    // Init when EITHER line layer is built: road needs default-AADT, rail needs
    // the C1 per-region period split — a rail-only run on Admin::UNKNOWN would
    // take the world split and break popup parity (Codex delta 1).
    if layers.contains(&LineLayer::Road) || layers.contains(&LineLayer::Rail) {
        let _ = admin::init_admin_table(&admin::default_admin_path(&h3r4));
    }

    if stream {
        return run_stream(
            z, &layers, halo_m, batch_n, h3r4, baseline, output, &prepared,
        );
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

    let (dev, f) = warm_device();

    // OFF by default: no production change until per-box-validated. When set, the
    // C9 gate routes barrier-bearing chunks here instead of demoting them to CPU.
    let barriers_enabled = env("QM_GPU_BARRIERS", "0") == "1";
    if barriers_enabled {
        eprintln!("QM_GPU_BARRIERS=1 — kernel vector-barrier screening ENABLED");
    }
    let cfg = Cfg {
        z,
        batch_n: blk_n,
        halo_m,
        h3r4,
        baseline,
        output: output.clone(),
        barriers_enabled,
    };
    let mut stats: BTreeMap<&'static str, LayerStat> = BTreeMap::new();
    let mut prog = Progress {
        done: 0,
        total: n_targets * layers.len(),
        last_beat: Instant::now(),
    };
    let t_all = Instant::now();
    for (&r4, region_tiles) in &regions {
        process_region(
            r4,
            region_tiles,
            &layers,
            &cfg,
            &dev,
            &f,
            &prepared,
            &mut stats,
            &mut prog,
        )?;
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
