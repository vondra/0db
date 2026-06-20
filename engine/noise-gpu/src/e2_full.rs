//! E2c step 2 — validate the FULL surface path port WITH the energy-budget skip:
//! the `rail` kernel now mirrors scatter_band exactly. Two checks:
//!   (1) GPU vs a CPU reference that reuses the real engine path-effect fns
//!       (terrain/screening/veg/ground) AND the same per-pixel skip, f32 energy
//!       accumulation (matching TileAccumulator) — byte-exact isolates the port.
//!   (2) GPU energy → collapse_lden_surface_u8 → diff vs the production baseline
//!       tile (/root/baseline/rail/13/x/y.bin), the true scatter_tile output.
//!
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared NOISE_GPU_BASELINE=/root/baseline \
//!   NOISE_GPU_HALO_M=10000 e2-full <tile_x> <tile_y>
use std::f64::consts::{LN_10, PI};
use std::path::Path;

use anyhow::{Context, Result};
use cudarc::driver::{CudaDevice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::TileAccumulator;
use heatmap_aircraft::region_runner::tile_centre_r4;
use heatmap_aircraft::source_loader_rail::RailData;
use heatmap_aircraft::wire_hm3::{collapse_lden_surface_u8, read_tile};
use noise_compute::constants::{ALPHA_ATM, A_WEIGHTING, GROUND_CF};
use noise_compute::propagation::geo::{finite_line_correction, point_to_segment_full};
use noise_compute::propagation::iso9613::fast_exp_f64;
use noise_compute::propagation::path_effects;
use noise_compute::propagation::PathProfile;
use noise_compute::types::{Barrier, RasterSampler};
use noise_gpu::{BIN_W, N_BINS};
use raster_reader::fused_tile_z13::{default_batch_size, TileBatch};
use raster_reader::RealRasters;

const SCATTER_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/scatter.ptx"));
const TILE_PX: usize = 256;
const NO_DATA: u8 = 255;
/// Lden period weights = scatter_line::LDEN_WEIGHTS (12/4/8h × 0/5/10 dB).
const LDEN_WEIGHTS: [f64; 3] = [12.0, 4.0 * 3.1622776601683795, 80.0];
/// scatter_line::UB_SAFETY — inflate the skip upper bound past fast_exp wobble.
const UB_SAFETY: f64 = 1.0001;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let (x, y): (u32, u32) = (a[1].parse()?, a[2].parse()?);
    let z = 13u8;
    let prepared = env("NOISE_GPU_PREPARED", "/dev/shm/qmap/prepared");
    let baseline = env("NOISE_GPU_BASELINE", "/root/baseline");
    let year = env("DATA_YEAR", "2026");
    let halo_m: f64 = env("NOISE_GPU_HALO_M", "10000").parse()?;
    // Matches scatter_line::budget_eta(): default 0.40, clamped to [0, 0.40].
    let eta: f64 = env("SURFACE_BUDGET_ETA", "0.40")
        .parse::<f64>()
        .unwrap_or(0.40)
        .clamp(0.0, 0.40);
    // Skip the (slow) CPU reference — keep only GPU kernel timing + the GPU→u8
    // baseline diff. For fast fp32 drift/perf iteration, where byte-exact-vs-CPU
    // is moot anyway.
    let gpu_only = std::env::var("NOISE_GPU_ONLY").is_ok();
    // Swizzle tile width (must divide 256): the cache-blocking knob. 8×8 measured
    // best on the 4060 (rays overlap most in a ~96 m tile).
    let tw: f64 = env("NOISE_GPU_TW", "8").parse::<f64>().unwrap_or(8.0);
    let h3r4 = format!("{prepared}/{year}/h3r4");

    let r4 = tile_centre_r4(z, x, y).context("tile centre")?;
    let cell = CellIndex::try_from(r4)?;
    let ring: Vec<u64> = cell.grid_disk::<Vec<_>>(1).into_iter().map(u64::from).collect();
    let rasters = RealRasters::new(Path::new(&prepared));
    // C1 rail per-region period split needs the admin table. The bench loads rail
    // directly (no surface binary in the loop), so init it here too — else the
    // reference run resolves Admin::UNKNOWN → world split and drifts vs a
    // real-admin production tile (Codex delta 1).
    let _ = noise_compute::admin::init_admin_table(&noise_compute::admin::default_admin_path(
        Path::new(&h3r4),
    ));
    let ll = h3o::LatLng::from(cell);
    let admin = noise_compute::admin::admin_for_latlng(ll.lat(), ll.lng());
    let rail = RailData::load_for_r4s(Path::new(&h3r4), &ring, admin)?.into_rows();
    let bn = default_batch_size();
    let (bx, by) = ((x / bn) * bn, (y / bn) * bn);
    let batch = TileBatch::build(z, bx, by, bn, halo_m, &rasters);
    let tile = &batch.tiles[((y - by) * bn + (x - bx)) as usize];
    let halo = &tile.halo;
    let (lat_min, lon_min, inv, rows, cols) = halo.geom();
    let nsrc = rail.len();
    eprintln!("tile {x}/{y} R4 {r4:015x} | rail rows {nsrc} | halo {rows}×{cols}");

    // ---- packed device buffers ----
    let n = TILE_PX * TILE_PX;
    let meta: Vec<f64> = vec![
        rows as f64,
        cols as f64,
        lat_min,
        lon_min,
        inv,
        tile.bbox.north_lat,
        tile.bbox.south_lat,
        tile.bbox.west_lon,
        tile.bbox.east_lon,
        eta,
        tw,
        0.0, // nbarr — the e2 CPU reference below is barrier-free (`no_barriers`)
    ];
    // sp = 12/source: length/reach/height/bridge ++ 8 host-precomputed Lden band
    // weights (Σ_p LDEN_W[p]·emission_lin[p][i]) — mirrors pack_sources so the shared
    // `line`/`line_binned_fused` kernels read sp[4+i] for the energy-budget UB.
    const LDEN_W: [f64; 3] = [12.0, 12.649110640673518, 80.0];
    let mut seg = Vec::with_capacity(nsrc * 4);
    let mut sp = Vec::with_capacity(nsrc * 12);
    let mut semis = Vec::with_capacity(nsrc * 24);
    for r in &rail {
        seg.extend_from_slice(&[r.start_lat, r.start_lon, r.end_lat, r.end_lon]);
        sp.extend_from_slice(&[
            r.length_m as f64,
            r.max_distance_m,
            r.source_height_m,
            if r.bridge { 1.0 } else { 0.0 },
        ]);
        for i in 0..8 {
            sp.push(
                LDEN_W[0] * r.emission_lin[0][i] as f64
                    + LDEN_W[1] * r.emission_lin[1][i] as f64
                    + LDEN_W[2] * r.emission_lin[2][i] as f64,
            );
        }
        for p in 0..3 {
            for i in 0..8 {
                semis.push(r.emission_lin[p][i]);
            }
        }
    }
    let mut rxll = Vec::with_capacity(512);
    rxll.extend_from_slice(&tile.rx_lat);
    rxll.extend_from_slice(&tile.rx_lon);
    let mut rxar = Vec::with_capacity(n * 2);
    for i in 0..n {
        rxar.push(tile.rx_alt_m[i]);
        rxar.push(tile.rx_refl_db[i]);
    }
    let elev: Vec<f32> = halo.pixels().iter().map(|p| p.elevation).collect();
    let inner: Vec<f32> = tile.inner_elev_m.clone();
    // cover = halo [building, forest, imd] per cell, interleaved
    let mut cover = Vec::with_capacity(rows * cols * 3);
    for p in halo.pixels() {
        cover.push(p.building);
        cover.push(p.forest);
        cover.push(p.imd);
    }

    // ---- CPU reference: full scatter_band (incl. skip), via real engine fns.
    // Skipped entirely under NOISE_GPU_ONLY (the GPU→u8 baseline diff stands alone).
    let mut cpu = vec![0f32; n * 3];
    let mut prof = PathProfile::new();
    let no_barriers: &[Barrier] = &[];
    for py in (0..TILE_PX).filter(|_| !gpu_only) {
        let rlat = tile.rx_lat[py];
        for px in 0..TILE_PX {
            let pix = py * TILE_PX + px;
            let (rlon, ralt, refl) = (
                tile.rx_lon[px],
                tile.rx_alt_m[pix] as f64,
                tile.rx_refl_db[pix] as f64,
            );
            let mut energy = [0f32; 3];
            let (mut kept, mut skipped) = (0f64, 0f64);
            for r in &rail {
                let pts = point_to_segment_full(
                    rlat,
                    rlon,
                    r.start_lat,
                    r.start_lon,
                    r.end_lat,
                    r.end_lon,
                );
                if pts.d_endpoint_m > r.max_distance_m {
                    continue;
                }
                let salt = tile.elevation(pts.cp_lat, pts.cp_lon) + r.source_height_m;
                let dslant = (pts.d_endpoint_m.powi(2) + (salt - ralt).powi(2))
                    .sqrt()
                    .max(1.0);
                let flc = finite_line_correction(
                    r.length_m as f64,
                    pts.d_endpoint_m,
                    pts.fraction.clamp(0.0, 1.0),
                );
                let base = refl + flc - 10.0 * (2.0 * PI * dslant).log10();
                let atm_km = dslant / 1000.0;

                // energy-budget skip: best-case Lden (no terrain/screen/veg, max
                // ground gain) is a provable upper bound — drop if within η of kept.
                let mut ub = 0.0;
                for i in 0..8 {
                    let gg_ub = (-GROUND_CF[i]).max(0.0);
                    let em_lden = LDEN_WEIGHTS[0] * r.emission_lin[0][i] as f64
                        + LDEN_WEIGHTS[1] * r.emission_lin[1][i] as f64
                        + LDEN_WEIGHTS[2] * r.emission_lin[2][i] as f64;
                    ub += em_lden
                        * fast_exp_f64(
                            (base - ALPHA_ATM[i] * atm_km + gg_ub + A_WEIGHTING[i]) * LN_10 * 0.1,
                        );
                }
                ub *= UB_SAFETY;
                if skipped + ub <= eta * kept {
                    skipped += ub;
                    continue;
                }

                tile.build_path_profile(
                    pts.cp_lat,
                    pts.cp_lon,
                    rlat,
                    rlon,
                    pts.d_endpoint_m,
                    &mut prof,
                );
                let ground_g = if r.bridge {
                    0.0
                } else {
                    path_effects::ground_g_from_profile(&prof)
                };
                let terrain = path_effects::terrain_attenuation(&mut prof, salt, ralt);
                let screening = path_effects::screening_attenuation(
                    &mut prof,
                    no_barriers,
                    salt,
                    ralt,
                    0.0,
                    &terrain,
                );
                let veg = path_effects::vegetation_attenuation_path(&prof);
                let mut pf = [0.0f64; 8];
                for (i, pf_i) in pf.iter_mut().enumerate() {
                    let a_gr = GROUND_CF[i] * ground_g;
                    let a_bar = terrain[i] + screening[i];
                    let gob = if a_bar > 0.0 { a_gr.max(a_bar) } else { a_gr };
                    *pf_i = fast_exp_f64(
                        (base - ALPHA_ATM[i] * atm_km - gob - veg[i] + A_WEIGHTING[i])
                            * LN_10
                            * 0.1,
                    );
                }
                let mut kept_add = 0.0;
                for p in 0..3 {
                    let mut power = 0.0;
                    for (i, &pf_i) in pf.iter().enumerate() {
                        power += r.emission_lin[p][i] as f64 * pf_i;
                    }
                    if power.is_finite() && power > 0.0 {
                        energy[p] += power as f32;
                        kept_add += power * LDEN_WEIGHTS[p];
                    }
                }
                kept += kept_add;
            }
            cpu[pix * 3] = energy[0];
            cpu[pix * 3 + 1] = energy[1];
            cpu[pix * 3 + 2] = energy[2];
        }
    }

    // ---- GPU ----
    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(Ptx::from_src(SCATTER_PTX), "s", &["line", "line_binned_fused"])
        .expect("ptx");
    // NOISE_GPU_KERNEL: line (scan-all, default) | line_binned_fused (GPU-side binning).
    // line_binned_fused uses the 1024×64 binned launch; line is pixel-major. The two must
    // agree byte-for-byte — the conservative-cull + ordered-replay parity check.
    let mode = env("NOISE_GPU_KERNEL", "line");
    let binned_launch = mode == "line_binned_fused";
    let f = dev
        .get_func("s", if binned_launch { "line_binned_fused" } else { "line" })
        .expect("fn");
    let d_elev = dev.htod_copy(elev).expect("elev");
    let d_inner = dev.htod_copy(inner).expect("inner");
    let d_cover = dev.htod_copy(cover).expect("cover");
    let d_meta = dev.htod_copy(meta).expect("meta");
    let d_seg = dev.htod_copy(seg).expect("seg");
    let d_sp = dev.htod_copy(sp).expect("sp");
    let d_semis = dev.htod_copy(semis).expect("semis");
    let d_rxll = dev.htod_copy(rxll).expect("rxll");
    let d_rxar = dev.htod_copy(rxar).expect("rxar");
    // One zero row — meta nbarr = 0, the kernel never reads it (cuMemAlloc
    // rejects 0-byte buffers).
    let d_barr = dev.htod_copy(vec![0.0f64; 4]).expect("barr");
    let mut d_out = dev.alloc_zeros::<f32>(n * 3).expect("out");
    let block: u32 = env("NOISE_GPU_BLOCK", "128").parse().unwrap_or(128);
    let cfg = LaunchConfig {
        grid_dim: if binned_launch {
            (N_BINS as u32, 1, 1)
        } else {
            ((n as u32).div_ceil(block), 1, 1)
        },
        block_dim: (
            if binned_launch {
                (BIN_W * BIN_W) as u32
            } else {
                block
            },
            1,
            1,
        ),
        shared_mem_bytes: 0,
    };
    let t = std::time::Instant::now();
    unsafe {
        // line (pixel-major) and line_binned_fused (binned) share the ARG tuple
        // (…, barr, nsrc, out); only the launch GEOMETRY differs (binned_launch above).
        f.launch(
            cfg,
            (
                &d_elev, &d_inner, &d_cover, &d_meta, &d_seg, &d_sp, &d_semis, &d_rxll, &d_rxar,
                &d_barr, nsrc as i32, &mut d_out,
            ),
        )
        .expect("launch");
    }
    dev.synchronize().expect("sync");
    let gpu_ms = t.elapsed().as_secs_f64() * 1e3;
    let gpu = dev.dtoh_sync_copy(&d_out).expect("dtoh");
    eprintln!("GPU kernel {gpu_ms:.1} ms");

    // ---- compare vs CPU ref (skipped under NOISE_GPU_ONLY): exact f32 inequality +
    // zero-sided mismatches + both-positive dB.
    if !gpu_only {
        let (mut maxdb, mut nover, mut nbit, mut nzero) = (0f64, 0usize, 0usize, 0usize);
        for i in 0..n * 3 {
            let (g, c) = (gpu[i], cpu[i]);
            if g != c {
                nbit += 1;
            }
            if (g > 0.0) != (c > 0.0) {
                nzero += 1;
            }
            if g > 0.0 && c > 0.0 {
                let d = (10.0 * (g as f64 / c as f64).log10()).abs();
                if d > maxdb {
                    maxdb = d;
                }
                if d > 0.5 {
                    nover += 1;
                }
            }
        }
        eprintln!(
            "GPU vs CPU ref: {nbit}/{} f32-unequal, {nzero} zero-sided, max {maxdb:.4} dB, {nover} >0.5 dB",
            n * 3
        );
        if nbit == 0 {
            eprintln!("✓ full path + budget skip port BYTE-EXACT vs CPU ref");
        } else if maxdb < 0.5 && nzero == 0 {
            eprintln!("✓ port within 0.5 dB ({nbit} sub-0.5 dB f32 drifts, 0 zero-sided)");
        }
    }

    // ---- (2) GPU energy → collapse → u8, diff vs the production baseline ----
    // gpu is pix*3+period, the exact TileAccumulator.energy layout.
    let mut accum = TileAccumulator::new();
    accum.energy.copy_from_slice(&gpu);
    let cells = collapse_lden_surface_u8(&accum);
    let base_path = Path::new(&baseline)
        .join("rail/13")
        .join(x.to_string())
        .join(format!("{y}.bin"));
    if base_path.exists() {
        let b = read_tile(&base_path)?;
        let (mut maxb, mut nd, mut presence) = (0i32, 0usize, 0usize);
        for i in 0..cells.len().min(b.len()) {
            let (c, bb) = (cells[i], b[i]);
            if c == NO_DATA && bb == NO_DATA {
                continue;
            }
            if (c == NO_DATA) != (bb == NO_DATA) {
                presence += 1;
                continue;
            }
            let d = (c as i32 - bb as i32).abs();
            maxb = maxb.max(d);
            if d > 0 {
                nd += 1;
            }
        }
        eprintln!(
            "GPU→u8 vs production baseline: max {maxb}B ({:.1} dB), {nd} differ, {presence} presence-changed",
            maxb as f64 * 0.5
        );
    } else {
        eprintln!("(no baseline tile at {base_path:?} — skipping u8 parity)");
    }
    Ok(())
}
