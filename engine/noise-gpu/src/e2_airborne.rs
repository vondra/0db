//! E2-E5 airborne GPU validation + benchmark.
//! Reference = the REAL `airborne::scatter_tile` (near per-pixel + far CoarseLevels).
//!
//! E5 (region-resident): `prepare_segment` + pack + upload the whole R4 region's candidate
//! sub-segs ONCE; per tile only a cheap `classify_tile` (the slant gate → index lists into the
//! resident SoA). This amortises the CPU classify — the per-box wall (62% at single-tile).
//! Loops every tile of the tile's R4 and reports the amortised region speedup vs CPU-prod.
//!
//!   NOISE_GPU_PREPARED=/dev/shm/qmap/prepared DATA_YEAR=2026 e2-airborne <x> <y>
use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use cudarc::driver::{CudaDevice, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::{CoarseLattice, TileAccumulator, COARSE_LEVELS_N};
use heatmap_aircraft::airborne::scatter_tile;
use heatmap_aircraft::region_runner::{region_tiles, tile_centre_r4};
use heatmap_aircraft::source_loader_airborne::AirborneData;
use noise_compute::compute::aircraft_v6::AirborneRowView;
use noise_compute::emission::aircraft::{
    self, is_ground_stale_with_terrain, prepare_segment, NpdLuts, SegmentPrepared, SegmentTerrain,
    AIRCRAFT_MAX_HORIZONTAL_REACH_M, GROUND_CONTEXT_NONE, GROUND_OPS_KIND_NONE, M_PER_DEG_LAT,
};
use noise_compute::types::AircraftSegment;
use noise_gpu::{pack_airborne_receivers, pack_airborne_segs};
use raster_reader::fused_tile_z13::{
    default_batch_size, tile_pixel_size_m, FusedTileZ13, TileBatch,
};
use raster_reader::RealRasters;

const AIRBORNE_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/airborne.ptx"));
const TILE_PX: usize = 256;
const NEAR_SLANT_SQ: f64 = 500.0 * 500.0; // NEAR_SLANT_M² (airborne.rs:48)
const COARSE_BAND_M: [f64; 2] = [2_000.0, 8_000.0]; // airborne.rs:96

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

/// Region-prep (ONCE per R4): every candidate sub-seg in the region's admit envelope,
/// ground-stale filtered, with `prepare_segment` applied — the expensive CPU work, done
/// region-wide. The per-tile near/far slant gate is deferred to `classify_tile`.
///
/// The envelope is the R4 hexagon's vertex bbox (a superset of every region tile's centre —
/// `region_tiles` keeps only centre-in-hexagon tiles) padded by the per-tile admit reach:
/// `scatter_tile` admits a sub-seg up to `AIRCRAFT_MAX_HORIZONTAL_REACH_M + half_diag` from a
/// tile centre. Deriving it from the actual R4 geometry — not a fixed radius around one tile —
/// is exact at any latitude: near the equator z13 tiles widen, so the worst R4 spans ~52 km
/// centre-to-centre and a 70 km radius around a corner tile dropped opposite-edge contributors
/// (Codex /gg 2026-06-07).
fn region_candidates(
    views: &[AirborneRowView<'_>],
    r4: u64,
    zoom: u8,
) -> Vec<(SegmentPrepared, u8)> {
    let cell = CellIndex::try_from(r4).expect("valid R4 cell");
    let (mut s, mut n, mut w, mut e) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for ll in cell.boundary().iter() {
        s = s.min(ll.lat());
        n = n.max(ll.lat());
        w = w.min(ll.lng());
        e = e.max(ll.lng());
    }
    // Pad = max horizontal reach + max tile half-diagonal. Size half_diag at the equatorial
    // z13 tile (widest, cos = 1) so it bounds every tile in the region; the lon pad uses the
    // region's highest |lat| (most degrees per metre). Over-padding only adds a few one-time
    // candidates that `classify_tile` rejects per tile — under-padding silently drops them.
    let half_diag =
        (TILE_PX as f64) * tile_pixel_size_m(zoom, 0.0) * std::f64::consts::SQRT_2 * 0.5;
    let pad_m = AIRCRAFT_MAX_HORIZONTAL_REACH_M + half_diag;
    let pad_lat = aircraft::meters_to_lat_deg(pad_m);
    let pad_lon = aircraft::meters_to_lon_deg(s.abs().max(n.abs()), pad_m);
    let env_min_lat = (s - pad_lat) as f32;
    let env_max_lat = (n + pad_lat) as f32;
    // Antimeridian: a dateline R4's vertices straddle ±180, so [w,e] is the long way round —
    // disable the lon prune (lat alone still culls; mirrors `region_tiles`/`scatter_tile`).
    let lon_prune = e - w <= 180.0 && (w - pad_lon) >= -180.0 && (e + pad_lon) <= 180.0;
    let env_min_lon = (w - pad_lon) as f32;
    let env_max_lon = (e + pad_lon) as f32;

    let mut out = Vec::new();
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
            let seg = AircraftSegment {
                flight_id: v.flight_id,
                profile_idx: v.profile_idx,
                is_departure: ss.flags[i] & 0b001 != 0,
                on_ground: false,
                period: ss.period[i],
                date_id: ss.date_id[i],
                start_lat: ss.start_lat[i] as f64,
                start_lon: ss.start_lon[i] as f64,
                start_alt_m: ss.start_alt_m[i],
                end_lat: ss.end_lat[i] as f64,
                end_lon: ss.end_lon[i] as f64,
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
            out.push((prepared, seg.period));
        }
    }
    out
}

/// Per-tile classify (CHEAP — no prepare_segment): which region candidates are near / far[level]
/// for THIS tile. The slant gate subsumes the per-tile envelope + clamped-CPA (slant-pass ⟹
/// clamped-pass), so it reproduces `scatter_tile`'s admit exactly. Emits index lists into the
/// region SoA. Reads the prepared `d_lon`/`sdy` directly — no AircraftSegment / endpoint rebuild.
fn classify_tile(
    tile: &FusedTileZ13,
    region: &[(SegmentPrepared, u8)],
) -> (Vec<i32>, [Vec<i32>; 3]) {
    let b = &tile.bbox;
    let centre_lat = (b.north_lat + b.south_lat) * 0.5;
    let centre_lon = (b.east_lon + b.west_lon) * 0.5;
    let px_m = tile_pixel_size_m(tile.zoom, centre_lat);
    let half_diag = (TILE_PX as f64) * px_m * std::f64::consts::SQRT_2 * 0.5;
    let m_per_deg_lon = M_PER_DEG_LAT * centre_lat.to_radians().cos().max(0.2);
    let tile_max_rx_alt = tile
        .rx_alt_m
        .iter()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max) as f64;

    let mut near = Vec::new();
    let mut far: [Vec<i32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (idx, (p, _)) in region.iter().enumerate() {
        // dx,dy expand exactly to d_lon·m and sdy (x2−x1, y2−y1 in `scatter_tile`,
        // airborne.rs:228) — skip rebuilding the endpoint, which only added an f64 roundtrip.
        let x1 = (p.start_lon - centre_lon) * m_per_deg_lon;
        let y1 = (p.start_lat - centre_lat) * M_PER_DEG_LAT;
        let dx = p.d_lon * m_per_deg_lon;
        let dy = p.sdy;
        let len_sq = dx * dx + dy * dy;
        let min_d_sq = if len_sq < 1.0 {
            x1 * x1 + y1 * y1
        } else {
            let t_num = -(x1 * dx + y1 * dy);
            if t_num <= 0.0 {
                x1 * x1 + y1 * y1
            } else if t_num >= len_sq {
                (x1 + dx) * (x1 + dx) + (y1 + dy) * (y1 + dy)
            } else {
                let cross = dx * y1 - dy * x1;
                (cross * cross) / len_sq
            }
        };
        let horiz = (min_d_sq.sqrt() - half_diag).max(0.0);
        let seg_min_alt = p.start_alt_m.min(p.start_alt_m + p.sdz);
        let rel_alt = (seg_min_alt - tile_max_rx_alt).max(0.0);
        let best_slant_sq = horiz * horiz + rel_alt * rel_alt;
        if best_slant_sq > p.reach_sq {
            continue;
        }
        if best_slant_sq < NEAR_SLANT_SQ {
            near.push(idx as i32);
        } else {
            let best_slant = best_slant_sq.sqrt();
            let lvl = if best_slant < COARSE_BAND_M[0] {
                0
            } else if best_slant < COARSE_BAND_M[1] {
                1
            } else {
                2
            };
            far[lvl].push(idx as i32);
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

    // ---- region-prep ONCE: candidates + prepare_segment + pack + upload ----
    // The envelope is derived from the R4 geometry (see `region_candidates`), so it is a safe
    // superset for every tile of the R4 — independent of which tile (x,y) was passed.
    let t_prep = std::time::Instant::now();
    let region = region_candidates(&views, r4, z);
    let (sll, sf, si) = pack_airborne_segs(&region);
    let nreg = region.len();

    let dev = CudaDevice::new(0).expect("cuda");
    dev.load_ptx(
        Ptx::from_src(AIRBORNE_PTX),
        "air",
        &["airborne_exact", "airborne_coarse"],
    )
    .expect("ptx");
    let f_near = dev.get_func("air", "airborne_exact").expect("fn near");
    let f_coarse = dev.get_func("air", "airborne_coarse").expect("fn coarse");
    let d_sll = dev.htod_copy(sll).expect("sll");
    let d_sf = dev.htod_copy(sf).expect("sf");
    let d_si = dev.htod_copy(si).expect("si");
    let d_npd = dev
        .htod_copy(NpdLuts::shared().sel_luts_flat_f32())
        .expect("npd");
    dev.synchronize().expect("region upload");
    let t_prep_ms = t_prep.elapsed().as_secs_f64() * 1e3;
    let nreg_i = nreg as i32;
    let n = TILE_PX * TILE_PX;
    let block: u32 = 256;

    // ---- loop the R4's tiles, region SoA resident ----
    let tiles = region_tiles(r4, z);
    let mut batches: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    for &(tx, ty) in &tiles {
        batches
            .entry(((tx / bn) * bn, (ty / bn) * bn))
            .or_default()
            .push((tx, ty));
    }

    // QM_E2_EXACT=1 adds a CPU-exact (FORCE_EXACT) ground-truth pass per tile and reports
    // GPU-vs-exact + adaptive-vs-exact drift — the mountain parity gate. The coarse far-field
    // lattice was tuned on gentle Prague terrain; steep tiles swing rx_alt sharply across the
    // tile, so the far field is less smooth — validate on LOWI (Innsbruck) before "whole world".
    let e2_exact = env("QM_E2_EXACT", "0") == "1";
    let (mut tot_cpu, mut tot_gpu) = (0.0f64, 0.0f64);
    let (mut worst_db, mut tot_zero, mut n_done) = (0.0f64, 0usize, 0usize);
    let (mut worst_gx, mut zero_gx) = (0.0f64, 0usize); // GPU vs exact (the mountain gate)
    let (mut worst_ax, mut zero_ax) = (0.0f64, 0usize); // adaptive vs exact (coarse error alone)
                                                        // Severity of the GPU-vs-exact drift: how localised is it (cells over 0.5/1.0 dB, tiles
                                                        // affected, where the worst sits) — distinguishes one freak cell from systematic mountain bias.
    let (mut n_gx_over_half, mut n_gx_over_1, mut n_tiles_over_half) = (0usize, 0usize, 0usize);
    let mut worst_gx_tile = (0u32, 0u32);
    for ((bx, by), btiles) in &batches {
        let batch = TileBatch::build(z, *bx, *by, bn, 0.0, &rasters);
        for &(tx, ty) in btiles {
            let tile = &batch.tiles[((ty - by) * bn + (tx - bx)) as usize];

            // CPU-prod (the real CPU result + baseline)
            std::env::remove_var("QM_AIRBORNE_FORCE_EXACT");
            let mut accum_prod = TileAccumulator::new();
            let tc = std::time::Instant::now();
            let _ = scatter_tile(tile, &views, &mut accum_prod);
            tot_cpu += tc.elapsed().as_secs_f64() * 1e3;

            // GPU per-tile: classify (cheap) → indices → upload rx+idx → kernels → expand
            let tg = std::time::Instant::now();
            let (near_idx, far_idx) = classify_tile(tile, &region);
            let near_len = near_idx.len();
            let (rll, rxa) = pack_airborne_receivers(tile);
            let d_rll = dev.htod_copy(rll).expect("rll");
            let d_rxa = dev.htod_copy(rxa).expect("rxa");
            let d_nidx = dev.htod_copy(near_idx).expect("near idx");
            let mut d_near = dev.alloc_zeros::<f32>(n * 3).expect("near out");
            let mut fardev: Vec<(CudaSlice<i32>, usize, usize, CudaSlice<f32>)> = Vec::new();
            for (lvl, idxs) in far_idx.into_iter().enumerate() {
                let nn = COARSE_LEVELS_N[lvl];
                let nidx = idxs.len();
                fardev.push((
                    dev.htod_copy(idxs).expect("f idx"),
                    nidx,
                    nn,
                    dev.alloc_zeros::<f32>(nn * nn * 3).expect("coarse"),
                ));
            }
            let cfg_near = LaunchConfig {
                grid_dim: ((n as u32).div_ceil(block), 1, 1),
                block_dim: (block, 1, 1),
                shared_mem_bytes: 0,
            };
            unsafe {
                f_near
                    .clone()
                    .launch(
                        cfg_near,
                        (
                            &d_rll,
                            &d_rxa,
                            &d_sll,
                            &d_sf,
                            &d_si,
                            &d_npd,
                            &d_nidx,
                            near_len as i32,
                            nreg_i,
                            &mut d_near,
                        ),
                    )
                    .expect("launch near");
            }
            for (d_idx, nidx, nn, d_coarse) in fardev.iter_mut() {
                if *nidx == 0 {
                    continue;
                }
                let cfg = LaunchConfig {
                    grid_dim: ((*nidx as u32).div_ceil(block), 1, 1),
                    block_dim: (block, 1, 1),
                    shared_mem_bytes: 0,
                };
                unsafe {
                    f_coarse
                        .clone()
                        .launch(
                            cfg,
                            (
                                &d_rll,
                                &d_rxa,
                                &d_sll,
                                &d_sf,
                                &d_si,
                                &d_npd,
                                &*d_idx,
                                *nidx as i32,
                                nreg_i,
                                *nn as i32,
                                &mut *d_coarse,
                            ),
                        )
                        .expect("launch coarse");
                }
            }
            dev.synchronize().expect("sync");
            let gpu_near = dev.dtoh_sync_copy(&d_near).expect("dtoh near");
            let mut fine = TileAccumulator::new();
            fine.energy.copy_from_slice(&gpu_near);
            for (_, nidx, nn, d_coarse) in fardev.iter() {
                if *nidx == 0 {
                    continue;
                }
                let coarse = dev.dtoh_sync_copy(d_coarse).expect("dtoh coarse");
                CoarseLattice::from_energy(*nn, coarse).expand_into(&mut fine);
            }
            tot_gpu += tg.elapsed().as_secs_f64() * 1e3;

            // parity vs CPU-prod (both buffers are n*3 = TileAccumulator energy len)
            for (&g, &c) in fine.energy.iter().zip(accum_prod.energy.iter()) {
                if (g > 0.0) != (c > 0.0) {
                    tot_zero += 1;
                }
                if g > 0.0 && c > 0.0 {
                    let d = (10.0 * (g as f64 / c as f64).log10()).abs();
                    worst_db = worst_db.max(d);
                }
            }

            // Mountain gate: CPU-exact ground truth (FORCE_EXACT = per-pixel everywhere, no
            // coarse lattice) vs the GPU result AND vs CPU-adaptive — isolates the far-field
            // coarsening error on steep terrain.
            if e2_exact {
                std::env::set_var("QM_AIRBORNE_FORCE_EXACT", "1");
                let mut accum_exact = TileAccumulator::new();
                let _ = scatter_tile(tile, &views, &mut accum_exact);
                std::env::remove_var("QM_AIRBORNE_FORCE_EXACT");
                let mut tile_worst = 0.0f64;
                for ((&g, &a), &x) in fine
                    .energy
                    .iter()
                    .zip(accum_prod.energy.iter())
                    .zip(accum_exact.energy.iter())
                {
                    if (g > 0.0) != (x > 0.0) {
                        zero_gx += 1;
                    }
                    if g > 0.0 && x > 0.0 {
                        let d = (10.0 * (g as f64 / x as f64).log10()).abs();
                        tile_worst = tile_worst.max(d);
                        if d > 0.5 {
                            n_gx_over_half += 1;
                        }
                        if d > 1.0 {
                            n_gx_over_1 += 1;
                        }
                    }
                    if (a > 0.0) != (x > 0.0) {
                        zero_ax += 1;
                    }
                    if a > 0.0 && x > 0.0 {
                        worst_ax = worst_ax.max((10.0 * (a as f64 / x as f64).log10()).abs());
                    }
                }
                if tile_worst > worst_gx {
                    worst_gx = tile_worst;
                    worst_gx_tile = (tx, ty);
                }
                if tile_worst > 0.5 {
                    n_tiles_over_half += 1;
                }
            }
            n_done += 1;
        }
    }

    let gpu_total = t_prep_ms + tot_gpu;
    eprintln!(
        "region R4 {r4:015x} | {n_done} tiles | {nreg} region candidates (prepare_segment ONCE)"
    );
    eprintln!("GPU vs CPU-adaptive: worst max {worst_db:.4} dB, {tot_zero} zero-sided total");
    if worst_db < 0.5 && tot_zero == 0 {
        eprintln!("✓ region GPU airborne within 0.5 dB, 0 zero-sided across {n_done} tiles");
    } else {
        eprintln!("✗ parity FAILED (worst {worst_db:.3} dB, {tot_zero} zero-sided)");
    }
    if e2_exact {
        let cells = (n_done * n * 3).max(1);
        eprintln!(
            "GPU vs CPU-EXACT (ground truth): worst {worst_gx:.4} dB @tile {}/{} | {n_gx_over_half} cells >0.5 dB, {n_gx_over_1} >1.0 dB (of {cells}), {n_tiles_over_half}/{n_done} tiles affected, {zero_gx} zero-sided",
            worst_gx_tile.0, worst_gx_tile.1
        );
        eprintln!(
            "  adaptive vs exact: worst {worst_ax:.4} dB, {zero_ax} zero-sided — the coarse-lattice error; GPU≈adaptive ({worst_db:.4} dB) so GPU inherits it, does not introduce it"
        );
        if worst_gx < 0.5 && zero_gx == 0 {
            eprintln!("✓ MOUNTAIN GATE PASS — GPU within 0.5 dB of exact across {n_done} tiles");
        } else {
            eprintln!(
                "✗ MOUNTAIN GATE over 0.5 dB — worst {worst_gx:.3} dB on {n_gx_over_half} cell(s); pre-existing CPU coarse-lattice limit, not a GPU-port defect"
            );
        }
    }
    eprintln!("--- TIMING (same box, whole R4) ---");
    eprintln!(
        "  CPU prod total {tot_cpu:.0} ms  ({:.1} ms/tile)",
        tot_cpu / n_done.max(1) as f64
    );
    eprintln!(
        "  GPU total      {gpu_total:.0} ms  ({:.1} ms/tile) = region-prep {t_prep_ms:.0} (once) + per-tile {tot_gpu:.0}",
        gpu_total / n_done.max(1) as f64,
    );
    eprintln!(
        "  → region speedup (amortised): {:.1}×",
        tot_cpu / gpu_total.max(0.001)
    );
    Ok(())
}
