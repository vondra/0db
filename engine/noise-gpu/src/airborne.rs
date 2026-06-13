//! Shared region-resident GPU airborne scatter — the compute path used by BOTH the
//! `e2-airborne` validator and the `gpu-airborne` production builder, so the two are
//! byte-identical and the measured parity (LKPR 0.0090 dB, LOWI 0.0065 dB vs the CPU
//! `airborne::scatter_tile`, 0 zero-sided) holds for production by construction.
//!
//! Lifecycle, mirroring `airborne::scatter_tile`'s adaptive near/far split but on the GPU:
//!   1. [`AirborneGpu::new`] — load the PTX + upload the NPD LUTs ONCE (device-global).
//!   2. [`AirborneGpu::load_region`] — `prepare_segment`'d candidates → device SoA, ONCE per R4.
//!   3. [`AirborneGpu::scatter_tile`] — per tile: cheap classify → near (exact) + far (coarse
//!      lattice) kernels → host bilinear expand → one `TileAccumulator`.

use std::sync::Arc;

use cudarc::driver::{CudaDevice, CudaFunction, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::Ptx;
use h3o::CellIndex;
use heatmap_aircraft::accumulator::{CoarseLattice, TileAccumulator, COARSE_LEVELS_N};
use noise_compute::compute::aircraft_v6::AirborneRowView;
use noise_compute::emission::aircraft::{
    self, is_ground_stale_with_terrain, prepare_segment, NpdLuts, SegmentPrepared, SegmentTerrain,
    AIRCRAFT_MAX_HORIZONTAL_REACH_M, GROUND_CONTEXT_NONE, GROUND_OPS_KIND_NONE, M_PER_DEG_LAT,
};
use noise_compute::types::AircraftSegment;
use raster_reader::fused_tile_z13::{tile_pixel_size_m, FusedTileZ13, TILE_PX};

use crate::{pack_airborne_receivers, pack_airborne_segs};

const AIRBORNE_PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/airborne.ptx"));
const NEAR_SLANT_SQ: f64 = 500.0 * 500.0; // NEAR_SLANT_M² (airborne.rs:48)
const COARSE_BAND_M: [f64; 2] = [2_000.0, 8_000.0]; // airborne.rs:96

/// Region-prep (ONCE per R4): every candidate sub-seg in the region's admit envelope,
/// ground-stale filtered, with `prepare_segment` applied — the expensive CPU work, done
/// region-wide. The per-tile near/far slant gate is deferred to [`classify_tile`].
///
/// The envelope is the R4 hexagon's vertex bbox (a superset of every region tile's centre —
/// `region_tiles` keeps only centre-in-hexagon tiles) padded by the per-tile admit reach:
/// `scatter_tile` admits a sub-seg up to `AIRCRAFT_MAX_HORIZONTAL_REACH_M + half_diag` from a
/// tile centre. Deriving it from the actual R4 geometry — not a fixed radius around one tile —
/// is exact at any latitude: near the equator z13 tiles widen, so the worst R4 spans ~52 km
/// centre-to-centre and a 70 km radius around a corner tile dropped opposite-edge contributors
/// (Codex /gg 2026-06-07).
pub fn region_candidates(
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

/// GPU handle: the device, the two airborne kernels, the NPD LUTs, and the
/// GA 365-day hybrid per-class weight LUT (all uploaded once, device-global).
/// Construct once per build; reuse across every region and tile.
pub struct AirborneGpu {
    dev: Arc<CudaDevice>,
    f_near: CudaFunction,
    f_coarse: CudaFunction,
    d_npd: CudaSlice<f32>,
    /// `NUM_CLASSES`-length GA hybrid weight LUT (f32). The kernel scales
    /// each sub-seg's energy by `d_w[class]` (`ga-365d-hybrid-plan.md` §2).
    d_w: CudaSlice<f32>,
}

/// One R4's candidate sub-segs, resident on the device (the expensive `prepare_segment` +
/// pack + upload done once). `region` is kept host-side for the per-tile [`classify_tile`].
pub struct RegionResident {
    region: Vec<(SegmentPrepared, u8)>,
    d_sll: CudaSlice<f64>,
    d_sf: CudaSlice<f32>,
    d_si: CudaSlice<i32>,
    nreg: usize,
}

impl RegionResident {
    /// Number of resident candidate sub-segs (the classify indexes into these).
    pub fn len(&self) -> usize {
        self.nreg
    }
    pub fn is_empty(&self) -> bool {
        self.nreg == 0
    }
}

// No `Default`: `new()` opens a CUDA device, compiles/loads the PTX, and uploads the NPD LUTs —
// a `Default::default()` would silently hide all that I/O.
#[allow(clippy::new_without_default)]
impl AirborneGpu {
    /// Open CUDA device 0, load the airborne PTX, and upload the NPD LUTs + the GA 365-day
    /// hybrid per-class weight LUT once. CUDA failures `expect`-panic (the codebase convention
    /// — see `gpu_surface`): a dead device or missing kernel is fatal to the whole build, so
    /// the worker dies loudly and the chunk re-dispatches. `class_weights` is build-wide
    /// (resolved from the source arrows' `sample_days_by_class`); the weight LUT is constant
    /// across every region + tile, so it uploads here, not per-tile.
    pub fn new(class_weights: &aircraft::ClassWeights) -> Self {
        // `new_with_stream` (not `new`): every alloc/copy/launch/synchronize then runs on
        // THIS instance's OWN stream, not the shared default/null stream. The world builder
        // makes one AirborneGpu per rayon worker, so per-worker streams let the workers' GPU
        // launches + copies overlap instead of serializing device-wide on the null stream
        // (gg C1). Each worker holds its own CudaDevice instance ⇒ no shared-event hazard.
        let dev = CudaDevice::new_with_stream(0).expect("open cuda device 0");
        dev.load_ptx(
            Ptx::from_src(AIRBORNE_PTX),
            "air",
            &["airborne_exact", "airborne_coarse"],
        )
        .expect("load airborne ptx");
        let f_near = dev.get_func("air", "airborne_exact").expect("fn near");
        let f_coarse = dev.get_func("air", "airborne_coarse").expect("fn coarse");
        let d_npd = dev
            .htod_copy(NpdLuts::shared().sel_luts_flat_f32())
            .expect("upload npd");
        let d_w = dev
            .htod_copy(class_weights.as_array().iter().map(|&x| x as f32).collect::<Vec<f32>>())
            .expect("upload class weights");
        dev.synchronize().expect("npd + weights upload sync");
        Self {
            dev,
            f_near,
            f_coarse,
            d_npd,
            d_w,
        }
    }

    /// Pack + upload a region's candidate sub-segs to the device (ONCE per R4). The returned
    /// handle is reused by every [`scatter_tile`] of that region.
    pub fn load_region(&self, region: Vec<(SegmentPrepared, u8)>) -> RegionResident {
        let (sll, sf, si) = pack_airborne_segs(&region);
        let nreg = region.len();
        let d_sll = self.dev.htod_copy(sll).expect("upload sll");
        let d_sf = self.dev.htod_copy(sf).expect("upload sf");
        let d_si = self.dev.htod_copy(si).expect("upload si");
        self.dev.synchronize().expect("region upload sync");
        RegionResident {
            region,
            d_sll,
            d_sf,
            d_si,
            nreg,
        }
    }

    /// Scatter one tile against the resident region: classify into near/far[3] index lists,
    /// launch the near (exact per-pixel) + far (coarse lattice) kernels, bilinear-expand each
    /// far level on the host, and return the fused `TileAccumulator` (3 periods × 256² cells).
    pub fn scatter_tile(&self, region: &RegionResident, tile: &FusedTileZ13) -> TileAccumulator {
        // Empty region → silent tile; skip all device work (common for rural R4s at world scale).
        if region.nreg == 0 {
            return TileAccumulator::new();
        }
        let n = TILE_PX * TILE_PX;
        let block: u32 = 256;
        let nreg_i = region.nreg as i32;

        let (near_idx, far_idx) = classify_tile(tile, &region.region);
        let near_len = near_idx.len();
        let (rll, rxa) = pack_airborne_receivers(tile);
        let d_rll = self.dev.htod_copy(rll).expect("upload rll");
        let d_rxa = self.dev.htod_copy(rxa).expect("upload rxa");
        let d_nidx = self.dev.htod_copy(near_idx).expect("upload near idx");
        let mut d_near = self.dev.alloc_zeros::<f32>(n * 3).expect("alloc near out");
        // (far index list, nidx, lattice side n, coarse out) per level.
        let mut fardev: Vec<(CudaSlice<i32>, usize, usize, CudaSlice<f32>)> =
            Vec::with_capacity(far_idx.len());
        for (lvl, idxs) in far_idx.into_iter().enumerate() {
            let nn = COARSE_LEVELS_N[lvl];
            let nidx = idxs.len();
            fardev.push((
                self.dev.htod_copy(idxs).expect("upload far idx"),
                nidx,
                nn,
                self.dev
                    .alloc_zeros::<f32>(nn * nn * 3)
                    .expect("alloc coarse"),
            ));
        }

        let cfg_near = LaunchConfig {
            grid_dim: ((n as u32).div_ceil(block), 1, 1),
            block_dim: (block, 1, 1),
            shared_mem_bytes: 0,
        };
        unsafe {
            self.f_near
                .clone()
                .launch(
                    cfg_near,
                    (
                        &d_rll,
                        &d_rxa,
                        &region.d_sll,
                        &region.d_sf,
                        &region.d_si,
                        &self.d_npd,
                        &self.d_w,
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
                self.f_coarse
                    .clone()
                    .launch(
                        cfg,
                        (
                            &d_rll,
                            &d_rxa,
                            &region.d_sll,
                            &region.d_sf,
                            &region.d_si,
                            &self.d_npd,
                            &self.d_w,
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
        self.dev.synchronize().expect("kernel sync");

        let gpu_near = self.dev.dtoh_sync_copy(&d_near).expect("dtoh near");
        let mut fine = TileAccumulator::new();
        fine.energy.copy_from_slice(&gpu_near);
        for (_, nidx, nn, d_coarse) in fardev.iter() {
            if *nidx == 0 {
                continue;
            }
            let coarse = self.dev.dtoh_sync_copy(d_coarse).expect("dtoh coarse");
            CoarseLattice::from_energy(*nn, coarse).expand_into(&mut fine);
        }
        fine
    }
}
