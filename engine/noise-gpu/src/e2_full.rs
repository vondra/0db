//! E2c step 1 — validate the FULL surface path port (free-field + terrain +
//! building screening + ground effect + vegetation, combined as
//! max(A_ground, A_terrain+A_screen)) in the `rail` kernel, minus the budget
//! skip. The CPU reference is scatter_band's body without the skip, reusing the
//! real engine functions (build_path_profile, terrain_attenuation,
//! screening_attenuation, vegetation_attenuation_path, ground_g_from_profile,
//! tile.elevation). Diffs GPU vs CPU.
//!
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared e2-full <tile_x> <tile_y>
use std::f64::consts::{LN_10, PI};
use std::path::Path;

use anyhow::{Context, Result};
use cudarc::driver::{CudaDevice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::region_runner::tile_centre_r4;
use heatmap_aircraft::source_loader_rail::RailData;
use noise_compute::constants::{ALPHA_ATM, A_WEIGHTING, GROUND_CF};
use noise_compute::propagation::geo::{finite_line_correction, point_to_segment_full};
use noise_compute::propagation::iso9613::fast_exp_f64;
use noise_compute::propagation::path_effects;
use noise_compute::propagation::PathProfile;
use noise_compute::types::{Barrier, RasterSampler};
use raster_reader::fused_tile_z13::{default_batch_size, TileBatch};
use raster_reader::RealRasters;

const SCATTER_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/scatter.ptx"));
const TILE_PX: usize = 256;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let (x, y): (u32, u32) = (a[1].parse()?, a[2].parse()?);
    let z = 13u8;
    let prepared = env("NOISE_GPU_PREPARED", "/dev/shm/qmap/prepared");
    let year = env("DATA_YEAR", "2026");
    let halo_m: f64 = env("NOISE_GPU_HALO_M", "10000").parse()?;
    let h3r4 = format!("{prepared}/{year}/h3r4");

    let r4 = tile_centre_r4(z, x, y).context("tile centre")?;
    let ring: Vec<u64> = CellIndex::try_from(r4)?
        .grid_disk::<Vec<_>>(1)
        .into_iter()
        .map(u64::from)
        .collect();
    let rasters = RealRasters::new(Path::new(&prepared));
    let rail = RailData::load_for_r4s(Path::new(&h3r4), &ring)?.into_rows();
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
    ];
    let mut seg = Vec::with_capacity(nsrc * 4);
    let mut sp = Vec::with_capacity(nsrc * 4);
    let mut semis = Vec::with_capacity(nsrc * 24);
    for r in &rail {
        seg.extend_from_slice(&[r.start_lat, r.start_lon, r.end_lat, r.end_lon]);
        sp.extend_from_slice(&[
            r.length_m as f64,
            r.max_distance_m,
            r.source_height_m,
            if r.bridge { 1.0 } else { 0.0 },
        ]);
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

    // ---- CPU reference: scatter_band minus the budget skip, via real engine ----
    let mut cpu = vec![0f32; n * 3];
    let mut prof = PathProfile::new();
    let no_barriers: &[Barrier] = &[];
    for py in 0..TILE_PX {
        let rlat = tile.rx_lat[py];
        for px in 0..TILE_PX {
            let pix = py * TILE_PX + px;
            let (rlon, ralt, refl) = (
                tile.rx_lon[px],
                tile.rx_alt_m[pix] as f64,
                tile.rx_refl_db[pix] as f64,
            );
            let (mut e0, mut e1, mut e2) = (0f64, 0f64, 0f64);
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
                for i in 0..8 {
                    let a_gr = GROUND_CF[i] * ground_g;
                    let a_bar = terrain[i] + screening[i];
                    let gob = if a_bar > 0.0 { a_gr.max(a_bar) } else { a_gr };
                    let path_db = base - ALPHA_ATM[i] * atm_km - gob - veg[i];
                    let pf = fast_exp_f64((path_db + A_WEIGHTING[i]) * LN_10 * 0.1);
                    e0 += r.emission_lin[0][i] as f64 * pf;
                    e1 += r.emission_lin[1][i] as f64 * pf;
                    e2 += r.emission_lin[2][i] as f64 * pf;
                }
            }
            cpu[pix * 3] = e0 as f32;
            cpu[pix * 3 + 1] = e1 as f32;
            cpu[pix * 3 + 2] = e2 as f32;
        }
    }

    // ---- GPU ----
    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(Ptx::from_src(SCATTER_PTX), "s", &["rail"])
        .expect("ptx");
    let f = dev.get_func("s", "rail").expect("fn");
    let d_elev = dev.htod_copy(elev).expect("elev");
    let d_inner = dev.htod_copy(inner).expect("inner");
    let d_cover = dev.htod_copy(cover).expect("cover");
    let d_meta = dev.htod_copy(meta).expect("meta");
    let d_seg = dev.htod_copy(seg).expect("seg");
    let d_sp = dev.htod_copy(sp).expect("sp");
    let d_semis = dev.htod_copy(semis).expect("semis");
    let d_rxll = dev.htod_copy(rxll).expect("rxll");
    let d_rxar = dev.htod_copy(rxar).expect("rxar");
    let mut d_out = dev.alloc_zeros::<f32>(n * 3).expect("out");
    let block = 128u32;
    let cfg = LaunchConfig {
        grid_dim: ((n as u32).div_ceil(block), 1, 1),
        block_dim: (block, 1, 1),
        shared_mem_bytes: 0,
    };
    let t = std::time::Instant::now();
    unsafe {
        f.launch(
            cfg,
            (
                &d_elev,
                &d_inner,
                &d_cover,
                &d_meta,
                &d_seg,
                &d_sp,
                &d_semis,
                &d_rxll,
                &d_rxar,
                nsrc as i32,
                &mut d_out,
            ),
        )
        .expect("launch");
    }
    dev.synchronize().expect("sync");
    let gpu_ms = t.elapsed().as_secs_f64() * 1e3;
    let gpu = dev.dtoh_sync_copy(&d_out).expect("dtoh");

    // ---- compare in dB ----
    let (mut maxdb, mut nover) = (0f64, 0usize);
    for i in 0..n * 3 {
        let (g, c) = (gpu[i] as f64, cpu[i] as f64);
        if g > 0.0 && c > 0.0 {
            let d = (10.0 * (g / c).log10()).abs();
            if d > maxdb {
                maxdb = d;
            }
            if d > 0.5 {
                nover += 1;
            }
        }
    }
    eprintln!(
        "GPU rail (FULL path) vs CPU ref: max {maxdb:.4} dB, {nover}/{} cells >0.5 dB | GPU kernel {gpu_ms:.1} ms",
        n * 3
    );
    if maxdb < 0.5 {
        eprintln!("✓ full surface path port validated (<0.5 dB)");
    }
    Ok(())
}
