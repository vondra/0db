//! GPU surface heatmap batch runner (rail) — the production wiring of the binned
//! kernel. Builds one tile block's shared halo once, then for each tile loads its
//! rail, bins the sources, runs `rail_binned`, collapses to Lden u8, and (if a
//! baseline exists) diffs it. Reports end-to-end throughput + the kernel/binning/
//! rail-load breakdown — the real-world, sparse-dominated number.
//!
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared NOISE_GPU_BASELINE=/root/baseline \
//!   NOISE_GPU_HALO_M=10000 DATA_YEAR=2026 gpu-surface <base_x> <base_y> [batch_n]
use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use cudarc::driver::{CudaDevice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::TileAccumulator;
use heatmap_aircraft::region_runner::tile_centre_r4;
use heatmap_aircraft::source_loader_rail::RailData;
use heatmap_aircraft::wire_hm3::{collapse_lden_surface_u8, read_tile, write_tile, SOURCE_ID_RAIL};
use noise_gpu::{build_pixel_bins, pack_tile, BIN_W, N_BINS};
use raster_reader::fused_tile_z13::{TileBatch, TILE_PX};
use raster_reader::RealRasters;

const SCATTER_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/scatter.ptx"));
const NO_DATA: u8 = 255;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pos: Vec<&String> = args.iter().filter(|s| !s.starts_with("--")).collect();
    let (base_x, base_y): (u32, u32) = (pos[0].parse()?, pos[1].parse()?);
    let batch_n: u32 = pos.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    // --output <heatmap-v3 root> → write HM3 rail tiles to {root}/rail/13/x/y.bin.
    let output = args
        .iter()
        .position(|s| s == "--output")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let z = 13u8;
    let prepared = env("NOISE_GPU_PREPARED", "/dev/shm/qmap/prepared");
    let baseline = env("NOISE_GPU_BASELINE", "/root/baseline");
    let year = env("DATA_YEAR", "2026");
    let halo_m: f64 = env("NOISE_GPU_HALO_M", "10000").parse()?;
    let (eta, tw) = (0.40_f64, 8.0_f64); // production defaults
    let h3r4 = format!("{prepared}/{year}/h3r4");

    let rasters = RealRasters::new(Path::new(&prepared));
    let batch = TileBatch::build(z, base_x, base_y, batch_n, halo_m, &rasters);
    let halo = &batch.tiles[0].halo; // shared across the whole batch
    let halo_geom = halo.geom();
    let (_, _, _, rows, cols) = halo_geom;
    eprintln!("batch {base_x}/{base_y} n={batch_n} | shared halo {rows}×{cols}");

    // ---- GPU device + shared halo upload (ONCE for the whole block) ----
    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(Ptx::from_src(SCATTER_PTX), "s", &["rail_binned"])
        .expect("ptx");
    let f = dev.get_func("s", "rail_binned").expect("fn");
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

    // ---- per-tile loop ----
    let (mut t_kernel, mut t_bins, mut t_rail) = (0f64, 0f64, 0f64);
    let (mut max_diff, mut n_diff, mut n_baseline, mut n_written) = (0i32, 0usize, 0usize, 0usize);
    let t_all = Instant::now();
    for dy in 0..batch_n {
        for dx in 0..batch_n {
            let (tx, ty) = (base_x + dx, base_y + dy);
            let tile = &batch.tiles[(dy * batch_n + dx) as usize];

            let tr = Instant::now();
            let r4 = tile_centre_r4(z, tx, ty).context("tile centre")?;
            let ring: Vec<u64> = CellIndex::try_from(r4)?
                .grid_disk::<Vec<_>>(1)
                .into_iter()
                .map(u64::from)
                .collect();
            let rail = RailData::load_for_r4s(Path::new(&h3r4), &ring)?.into_rows();
            t_rail += tr.elapsed().as_secs_f64();

            let tb = Instant::now();
            let bins = build_pixel_bins(tile, &rail);
            t_bins += tb.elapsed().as_secs_f64();

            let bufs = pack_tile(tile, &rail, halo_geom, eta, tw);
            let d_inner = dev.htod_copy(bufs.inner).expect("inner");
            let d_meta = dev.htod_copy(bufs.meta).expect("meta");
            let d_seg = dev.htod_copy(bufs.seg).expect("seg");
            let d_sp = dev.htod_copy(bufs.sp).expect("sp");
            let d_semis = dev.htod_copy(bufs.semis).expect("semis");
            let d_rxll = dev.htod_copy(bufs.rxll).expect("rxll");
            let d_rxar = dev.htod_copy(bufs.rxar).expect("rxar");
            let d_off = dev.htod_copy(bins.offsets).expect("off");
            let d_idx = dev.htod_copy(bins.indices).expect("idx");
            let cfg = LaunchConfig {
                grid_dim: (N_BINS as u32, 1, 1),
                block_dim: ((BIN_W * BIN_W) as u32, 1, 1),
                shared_mem_bytes: 0,
            };
            let tk = Instant::now();
            unsafe {
                f.clone()
                    .launch(
                        cfg,
                        (
                            &d_elev, &d_inner, &d_cover, &d_meta, &d_seg, &d_sp, &d_semis, &d_rxll,
                            &d_rxar, &d_off, &d_idx, &mut d_out,
                        ),
                    )
                    .expect("launch");
            }
            dev.synchronize().expect("sync");
            t_kernel += tk.elapsed().as_secs_f64();
            let gpu = dev.dtoh_sync_copy(&d_out).expect("dtoh");

            let mut accum = TileAccumulator::new();
            accum.energy.copy_from_slice(&gpu);
            let cells = collapse_lden_surface_u8(&accum);

            if let Some(root) = &output {
                let out = Path::new(root)
                    .join("rail/13")
                    .join(tx.to_string())
                    .join(format!("{ty}.bin"));
                if write_tile(&out, &cells, SOURCE_ID_RAIL, true)? > 0 {
                    n_written += 1;
                }
            }

            let bp = Path::new(&baseline)
                .join("rail/13")
                .join(tx.to_string())
                .join(format!("{ty}.bin"));
            if bp.exists() {
                let b = read_tile(&bp)?;
                let mut md = 0i32;
                for i in 0..cells.len().min(b.len()) {
                    let (c, bb) = (cells[i], b[i]);
                    if (c == NO_DATA) == (bb == NO_DATA) && c != NO_DATA {
                        let d = (c as i32 - bb as i32).abs();
                        md = md.max(d);
                        if d > 0 {
                            n_diff += 1;
                        }
                    } else if c != bb {
                        n_diff += 1;
                    }
                }
                max_diff = max_diff.max(md);
                n_baseline += 1;
            }
        }
    }
    let wall = t_all.elapsed().as_secs_f64();
    let nt = (batch_n * batch_n) as f64;
    eprintln!(
        "=== {0}×{0} = {1} tiles in {wall:.2}s ({2:.0} ms/tile) ===",
        batch_n,
        (batch_n * batch_n),
        wall / nt * 1e3
    );
    eprintln!(
        "  GPU kernel {:.0} ms | binning {:.0} ms | rail-load {:.0} ms (rest = halo build + upload + collapse)",
        t_kernel * 1e3,
        t_bins * 1e3,
        t_rail * 1e3
    );
    if n_baseline > 0 {
        eprintln!(
            "  vs production baseline: {n_baseline} tiles, max {max_diff}B ({:.1} dB), {n_diff} cells differ",
            max_diff as f64 * 0.5
        );
    }
    if let Some(root) = &output {
        eprintln!("  wrote {n_written} non-empty HM3 rail tiles under {root}/rail/13");
    }
    Ok(())
}
