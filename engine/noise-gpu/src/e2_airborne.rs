//! E2/E3/E4 — validate + benchmark the fp32 airborne GPU kernels.
//! Reference = the REAL `airborne::scatter_tile` (near per-pixel + far CoarseLevels).
//!
//!   E2: kernel correct (brute) — max 0.0003 dB, 0 zero-sided.
//!   E3: GPU near only — 60× on near, but found FAR is 94% of the cost.
//!   E4 (this): GPU near (airborne_exact) + GPU far CoarseLevels (airborne_coarse,
//!       3 levels) → host bilinear-expand → full GPU airborne, vs CPU-prod.
//!
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared DATA_YEAR=2026 e2-airborne <x> <y>
use std::f64::consts::SQRT_2;
use std::path::Path;

use anyhow::{Context, Result};
use cudarc::driver::{CudaDevice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::{CoarseLattice, TileAccumulator, COARSE_LEVELS_N};
use heatmap_aircraft::airborne::scatter_tile;
use heatmap_aircraft::region_runner::tile_centre_r4;
use heatmap_aircraft::source_loader_airborne::AirborneData;
use noise_compute::compute::aircraft_v6::AirborneRowView;
use noise_compute::emission::aircraft::{
    self, is_ground_stale_with_terrain, prepare_segment, NpdLuts, SegmentPrepared, SegmentTerrain,
    AIRCRAFT_MAX_HORIZONTAL_REACH_M, GROUND_CONTEXT_NONE, GROUND_OPS_KIND_NONE, M_PER_DEG_LAT,
};
use noise_compute::types::AircraftSegment;
use noise_gpu::{pack_airborne_receivers, pack_airborne_segs};
use raster_reader::fused_tile_z13::{default_batch_size, tile_pixel_size_m, FusedTileZ13, TileBatch};
use raster_reader::RealRasters;

const AIRBORNE_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/airborne.ptx"));
const TILE_PX: usize = 256;
const COARSE_BAND_M: [f64; 2] = [2_000.0, 8_000.0]; // airborne.rs:96

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// Mirror of `airborne::scatter_tile`'s admit + near/far split: envelope +
/// ground-stale + slant-reach, then near (`best_slant < 500 m`) vs the 3 far
/// CoarseLevels bands (airborne.rs:335,368). Returns (near, [far_L0, far_L1, far_L2]).
type AdmitSplit = (Vec<(SegmentPrepared, u8)>, [Vec<(SegmentPrepared, u8)>; 3]);
fn admitted_segments(tile: &FusedTileZ13, views: &[AirborneRowView<'_>]) -> AdmitSplit {
    const NEAR_SLANT_SQ: f64 = 500.0 * 500.0; // NEAR_SLANT_M² (airborne.rs:48)
    let b = &tile.bbox;
    let centre_lat = (b.north_lat + b.south_lat) * 0.5;
    let centre_lon = (b.east_lon + b.west_lon) * 0.5;
    let px_m = tile_pixel_size_m(tile.zoom, centre_lat);
    let half_diag = (TILE_PX as f64) * px_m * SQRT_2 * 0.5;
    let reach_env = AIRCRAFT_MAX_HORIZONTAL_REACH_M + half_diag;
    let radius_lat = aircraft::meters_to_lat_deg(reach_env);
    let radius_lon = aircraft::meters_to_lon_deg(centre_lat, reach_env);
    let env_min_lat = (centre_lat - radius_lat) as f32;
    let env_max_lat = (centre_lat + radius_lat) as f32;
    let env_min_lon_raw = centre_lon - radius_lon;
    let env_max_lon_raw = centre_lon + radius_lon;
    let lon_prune = env_min_lon_raw >= -180.0 && env_max_lon_raw <= 180.0;
    let env_min_lon = env_min_lon_raw as f32;
    let env_max_lon = env_max_lon_raw as f32;
    let m_per_deg_lon = M_PER_DEG_LAT * centre_lat.to_radians().cos().max(0.2);
    let prune_radius_sq = reach_env * reach_env;
    let tile_max_rx_alt = tile.rx_alt_m.iter().copied().fold(f32::NEG_INFINITY, f32::max) as f64;

    let mut near = Vec::new();
    let mut far: [Vec<(SegmentPrepared, u8)>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for v in views {
        let bb = &v.bbox;
        if bb.max_lat < env_min_lat || bb.min_lat > env_max_lat {
            continue;
        }
        if lon_prune && (bb.max_lon < env_min_lon || bb.min_lon > env_max_lon) {
            continue;
        }
        let ss = &v.sub_segments;
        for i in 0..ss.start_lat.len() {
            let is_departure = ss.flags[i] & 0b001 != 0;
            let start_lat = ss.start_lat[i] as f64;
            let start_lon = ss.start_lon[i] as f64;
            let end_lat = ss.end_lat[i] as f64;
            let end_lon = ss.end_lon[i] as f64;

            let x1 = (start_lon - centre_lon) * m_per_deg_lon;
            let y1 = (start_lat - centre_lat) * M_PER_DEG_LAT;
            let x2 = (end_lon - centre_lon) * m_per_deg_lon;
            let y2 = (end_lat - centre_lat) * M_PER_DEG_LAT;
            let dx = x2 - x1;
            let dy = y2 - y1;
            let len_sq = dx * dx + dy * dy;
            let min_d_sq = if len_sq < 1.0 {
                x1 * x1 + y1 * y1
            } else {
                let t_num = -(x1 * dx + y1 * dy);
                if t_num <= 0.0 {
                    x1 * x1 + y1 * y1
                } else if t_num >= len_sq {
                    x2 * x2 + y2 * y2
                } else {
                    let cross = dx * y1 - dy * x1;
                    (cross * cross) / len_sq
                }
            };
            if min_d_sq > prune_radius_sq {
                continue;
            }

            let seg = AircraftSegment {
                flight_id: v.flight_id,
                profile_idx: v.profile_idx,
                is_departure,
                on_ground: false,
                period: ss.period[i],
                date_id: ss.date_id[i],
                start_lat,
                start_lon,
                start_alt_m: ss.start_alt_m[i],
                end_lat,
                end_lon,
                end_alt_m: ss.end_alt_m[i],
                speed_kt: ss.speed_kt[i],
                segment_length_m: ss.length_m[i],
                count_weight: 1.0,
                surface_model: false,
                ground_context: GROUND_CONTEXT_NONE,
                ground_ops_kind: GROUND_OPS_KIND_NONE,
                source_id: v.source_id as u16,
            };
            let start_elev = ss.terrain_start_elev_m[i] as f64;
            let end_elev = ss.terrain_end_elev_m[i] as f64;
            let terrain = SegmentTerrain {
                start_elev,
                q1_elev: 0.0,
                mid_elev: 0.0,
                q3_elev: 0.0,
                end_elev,
            };
            if is_ground_stale_with_terrain(&seg, &terrain) {
                continue;
            }
            let prepared = prepare_segment(&seg, start_elev - 30.0, end_elev - 30.0);

            let horiz = (min_d_sq.sqrt() - half_diag).max(0.0);
            let seg_min_alt = prepared.start_alt_m.min(prepared.start_alt_m + prepared.sdz);
            let rel_alt = (seg_min_alt - tile_max_rx_alt).max(0.0);
            let best_slant_sq = horiz * horiz + rel_alt * rel_alt;
            if best_slant_sq > prepared.reach_sq {
                continue;
            }
            let entry = (prepared, seg.period); // clamped to [0,2] once in pack_airborne_segs
            if best_slant_sq < NEAR_SLANT_SQ {
                near.push(entry);
            } else {
                let best_slant = best_slant_sq.sqrt();
                let lvl = if best_slant < COARSE_BAND_M[0] {
                    0
                } else if best_slant < COARSE_BAND_M[1] {
                    1
                } else {
                    2
                };
                far[lvl].push(entry);
            }
        }
    }
    (near, far)
}

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let (x, y): (u32, u32) = (a[1].parse()?, a[2].parse()?);
    let z = 13u8;
    let prepared = env("NOISE_GPU_PREPARED", "/dev/shm/qmap/prepared");
    let year = env("DATA_YEAR", "2026");
    let h3r4 = format!("{prepared}/{year}/h3r4");

    let r4 = tile_centre_r4(z, x, y).context("tile centre R4")?;
    let ring: Vec<u64> = CellIndex::try_from(r4)?
        .grid_disk::<Vec<_>>(1)
        .into_iter()
        .map(u64::from)
        .collect();
    let rasters = RealRasters::new(Path::new(&prepared));
    let air = AirborneData::load_for_r4s(Path::new(&h3r4), &ring)?;
    let views = air.views();

    let bn = default_batch_size();
    let (bx, by) = ((x / bn) * bn, (y / bn) * bn);
    let batch = TileBatch::build(z, bx, by, bn, 0.0, &rasters); // halo=0
    let tile = &batch.tiles[((y - by) * bn + (x - bx)) as usize];

    // ---- CPU production baseline (adaptive near/far) = the real CPU result + cost ----
    std::env::remove_var("QM_AIRBORNE_FORCE_EXACT");
    let mut accum_prod = TileAccumulator::new();
    let tcp = std::time::Instant::now();
    let _ = scatter_tile(tile, &views, &mut accum_prod);
    let t_cpu_prod = tcp.elapsed().as_secs_f64() * 1e3;

    // Classify/prune (envelope + ground-stale + prepare_segment + near/far split) — part of
    // the honest GPU per-box cost (region-resident E5 amortises prepare_segment region-wide).
    let t_classify = std::time::Instant::now();
    let (near, far) = admitted_segments(tile, &views);
    let t_classify_ms = t_classify.elapsed().as_secs_f64() * 1e3;

    // ---- GPU: near (airborne_exact) + 3 far levels (airborne_coarse) ----
    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(
        Ptx::from_src(AIRBORNE_PTX),
        "air",
        &["airborne_exact", "airborne_coarse"],
    )
    .expect("ptx");
    let f_near = dev.get_func("air", "airborne_exact").expect("fn near");
    let f_coarse = dev.get_func("air", "airborne_coarse").expect("fn coarse");

    let n = TILE_PX * TILE_PX;
    // --- pack (CPU): build the device-SoA Vecs (this is what region-resident E5 amortises) ---
    let t_pack = std::time::Instant::now();
    let (rll, rxa) = pack_airborne_receivers(tile);
    let npd_flat = NpdLuts::shared().sel_luts_flat_f32();
    let (snll, snf, sni) = pack_airborne_segs(&near);
    let far_packed: Vec<(Vec<f64>, Vec<f32>, Vec<i32>)> =
        far.iter().map(|s| pack_airborne_segs(s)).collect();
    let t_pack_ms = t_pack.elapsed().as_secs_f64() * 1e3;

    // --- htod (PCIe transfer) ---
    let t_htod = std::time::Instant::now();
    let d_rll = dev.htod_copy(rll).expect("rll");
    let d_rxa = dev.htod_copy(rxa).expect("rxa");
    let d_npd = dev.htod_copy(npd_flat).expect("npd");
    let d_snll = dev.htod_copy(snll).expect("snll");
    let d_snf = dev.htod_copy(snf).expect("snf");
    let d_sni = dev.htod_copy(sni).expect("sni");
    let mut d_near = dev.alloc_zeros::<f32>(n * 3).expect("near out");

    // (d_sll, d_sf, d_si, nseg, n_nodes, d_coarse) per far level
    let mut fardev = Vec::new();
    for ((lvl, seglist), (sll, sf, si)) in far.iter().enumerate().zip(far_packed) {
        let nn = COARSE_LEVELS_N[lvl];
        fardev.push((
            dev.htod_copy(sll).expect("f sll"),
            dev.htod_copy(sf).expect("f sf"),
            dev.htod_copy(si).expect("f si"),
            seglist.len(),
            nn,
            dev.alloc_zeros::<f32>(nn * nn * 3).expect("coarse out"),
        ));
    }
    // Sync so t_htod measures real H→D completion — cudarc htod_copy is async-queued
    // (gg/codex); without it the "upload" is just enqueue time and leaks into the kernel.
    dev.synchronize().expect("upload sync");
    let t_htod_ms = t_htod.elapsed().as_secs_f64() * 1e3;
    let t_upload = t_pack_ms + t_htod_ms;

    let block: u32 = 256;
    let t = std::time::Instant::now();
    let cfg_near = LaunchConfig {
        grid_dim: ((n as u32).div_ceil(block), 1, 1),
        block_dim: (block, 1, 1),
        shared_mem_bytes: 0,
    };
    unsafe {
        f_near
            .launch(cfg_near, (&d_rll, &d_rxa, &d_snll, &d_snf, &d_sni, &d_npd, near.len() as i32, &mut d_near))
            .expect("launch near");
    }
    for (d_sll, d_sf, d_si, nseg, nn, d_coarse) in fardev.iter_mut() {
        if *nseg == 0 {
            continue;
        }
        let cfg = LaunchConfig {
            grid_dim: ((*nseg as u32).div_ceil(block), 1, 1),
            block_dim: (block, 1, 1),
            shared_mem_bytes: 0,
        };
        unsafe {
            f_coarse
                .clone() // launch consumes the fn handle; clone is a cheap handle copy
                .launch(cfg, (&d_rll, &d_rxa, &*d_sll, &*d_sf, &*d_si, &d_npd, *nseg as i32, *nn as i32, &mut *d_coarse))
                .expect("launch coarse");
        }
    }
    dev.synchronize().expect("sync");
    let t_gpu_kernels = t.elapsed().as_secs_f64() * 1e3;

    // ---- host: GPU near + bilinear-expand each far level → full GPU result ----
    let gpu_near = dev.dtoh_sync_copy(&d_near).expect("dtoh near");
    let mut fine = TileAccumulator::new();
    fine.energy.copy_from_slice(&gpu_near);
    for (_, _, _, nseg, nn, d_coarse) in fardev.iter() {
        if *nseg == 0 {
            continue;
        }
        let coarse = dev.dtoh_sync_copy(d_coarse).expect("dtoh coarse");
        CoarseLattice::from_energy(*nn, coarse).expand_into(&mut fine);
    }
    let t_gpu_path = t.elapsed().as_secs_f64() * 1e3; // kernels + dtoh + expand

    // ---- parity: full GPU airborne vs CPU-prod ----
    let cpu = &accum_prod.energy;
    let (mut maxdb, mut nzero, mut nover, mut nboth) = (0f64, 0usize, 0usize, 0usize);
    for i in 0..n * 3 {
        let (g, c) = (fine.energy[i], cpu[i]);
        if (g > 0.0) != (c > 0.0) {
            nzero += 1;
        }
        if g > 0.0 && c > 0.0 {
            nboth += 1;
            let d = (10.0 * (g as f64 / c as f64).log10()).abs();
            maxdb = maxdb.max(d);
            if d > 0.5 {
                nover += 1;
            }
        }
    }

    let nfar: usize = far.iter().map(Vec::len).sum();
    eprintln!(
        "tile {x}/{y} R4 {r4:015x} (LKPR) | views {} | near {} | far {} ({}/{}/{})",
        views.len(),
        near.len(),
        nfar,
        far[0].len(),
        far[1].len(),
        far[2].len(),
    );
    eprintln!("parity GPU-full vs CPU-prod: {nboth} both-positive, max {maxdb:.4} dB, {nover} >0.5 dB, {nzero} zero-sided");
    if maxdb < 0.5 && nzero == 0 {
        eprintln!("✓ full GPU airborne (near + far) within 0.5 dB, 0 zero-sided");
    } else {
        eprintln!("✗ parity gate FAILED (max {maxdb:.3} dB, {nzero} zero-sided, {nover} cells >0.5 dB)");
    }
    eprintln!("--- TIMING (same box, one LKPR tile) ---");
    eprintln!("  CPU prod (adaptive)   {t_cpu_prod:7.0} ms");
    let t_full = t_classify_ms + t_upload + t_gpu_path;
    eprintln!(
        "  GPU per-box {t_full:.0} ms = classify {t_classify_ms:.0} + pack {t_pack_ms:.0} + htod {t_htod_ms:.0} + kernels {t_gpu_kernels:.1} + dtoh/expand {:.0}",
        t_gpu_path - t_gpu_kernels,
    );
    eprintln!(
        "  → speedup: {:.0}× (kernels only) | {:.1}× (full per-box) — E5 region-resident amortises classify+pack+htod",
        t_cpu_prod / t_gpu_kernels.max(0.001),
        t_cpu_prod / t_full.max(0.001),
    );
    Ok(())
}
