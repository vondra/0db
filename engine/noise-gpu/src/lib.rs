//! Shared host-side helpers for the GPU surface scatter (used by the e2-full
//! validator and the gpu-surface production batch runner).

/// Region-resident GPU airborne scatter, shared by the `e2-airborne` validator and the
/// `gpu-airborne` production builder (cudarc-backed, so gated on the `gpu` feature).
#[cfg(feature = "gpu")]
pub mod airborne;

use noise_compute::emission::aircraft::{Installation, SegmentPrepared, M_PER_DEG_LAT};
use noise_compute::types::Barrier;
use raster_reader::fused_tile_z13::{FusedTileZ13, TILE_PX};
use tile_painter::source_line::LineRow;

fn inst_code(inst: Installation) -> i32 {
    match inst {
        Installation::Wing => 0,
        Installation::Fuselage => 1,
        Installation::Propeller => 2,
    }
}

/// Pack a tile's receiver lattice (rll = lat|lon|m_per_deg_lon, rxa = elevation) —
/// uploaded ONCE; near and every far level index into the same lattice.
pub fn pack_airborne_receivers(tile: &FusedTileZ13) -> (Vec<f64>, Vec<f32>) {
    let n = TILE_PX;
    let mut rll = Vec::with_capacity(3 * n);
    rll.extend_from_slice(&tile.rx_lat); // [0..n] rx lat
    rll.extend_from_slice(&tile.rx_lon); // [n..2n] rx lon
    for py in 0..n {
        // Mirror airborne.rs:175 — m_per_deg_lon per receiver row.
        rll.push(M_PER_DEG_LAT * tile.rx_lat[py].to_radians().cos().max(0.2));
    }
    (rll, tile.rx_alt_m.clone())
}

/// Concatenate a block's tiles' receiver lattices for the M3 batched kernels: `rll`
/// is per-tile `[lat | lon | m_per_deg_lon]` (3·TPX each), `rxa` is per-tile elevation
/// (TPX·TPX each), tile `ti` at stride `ti·3·TPX` / `ti·TPX·TPX`. Same per-tile content
/// as `pack_airborne_receivers`, just concatenated so one launch covers the block.
pub fn pack_airborne_receivers_batch(tiles: &[&FusedTileZ13]) -> (Vec<f64>, Vec<f32>) {
    let n = TILE_PX;
    let mut rll = Vec::with_capacity(3 * n * tiles.len());
    let mut rxa = Vec::with_capacity(n * n * tiles.len());
    for tile in tiles {
        rll.extend_from_slice(&tile.rx_lat);
        rll.extend_from_slice(&tile.rx_lon);
        for py in 0..n {
            rll.push(M_PER_DEG_LAT * tile.rx_lat[py].to_radians().cos().max(0.2));
        }
        rxa.extend_from_slice(&tile.rx_alt_m);
    }
    (rll, rxa)
}

/// Pack a sub-seg list into the per-seg device SoA (sll, sf, si) — shared by the
/// near launch and each far level (receivers reused, segs per level).
pub fn pack_airborne_segs(segs: &[(SegmentPrepared, u8)]) -> (Vec<f64>, Vec<f32>, Vec<i32>) {
    let nseg = segs.len();
    let mut sll = vec![0.0f64; 2 * nseg];
    let mut sf = Vec::with_capacity(12 * nseg);
    let mut si = Vec::with_capacity(4 * nseg);
    for (s, (p, period)) in segs.iter().enumerate() {
        sll[s] = p.start_lat;
        sll[nseg + s] = p.start_lon;
        sf.extend_from_slice(&[
            p.start_alt_m as f32,
            p.d_lon as f32,
            p.sdy as f32,
            p.sdz as f32,
            p.dv as f32,
            p.d_bar_m as f32,
            p.di_a as f32,
            p.di_b as f32,
            p.di_c as f32,
            p.reach_sq as f32,
            p.terrain_start_cut_m as f32,
            p.terrain_end_cut_m as f32,
        ]);
        si.extend_from_slice(&[
            inst_code(p.inst),
            p.class_idx as i32,
            p.is_departure as i32,
            (*period).min(2) as i32,
        ]);
    }
    (sll, sf, si)
}

/// Pixel-bin edge: a 16×16 receiver patch = one CUDA block in `line_binned`.
pub const BIN_W: usize = 16;
/// Bins per axis (an internal step for `N_BINS`; not part of the public binning API like `BIN_W`).
const BIN_TILES: usize = TILE_PX / BIN_W;
/// Bins per tile (BIN_TILES², 1024 at 512 px) — `line_binned`'s grid dim.
pub const N_BINS: usize = BIN_TILES * BIN_TILES;

/// Per-tile non-halo buffers packed for the `line`/`line_binned_fused` kernels (the halo
/// elev/cover are uploaded once per batch and shared; the line SOURCES are uploaded
/// once per layer — see [`SourceBuffers`]). `meta` carries the SHARED halo geom +
/// this tile's bbox + eta + swizzle width + barrier count. `barr` is the tile's
/// vector noise-wall slice, nbarr×4 `{lat, lon, height_m, dist_m}` in
/// `BarrierData::for_tile` order (dist_m a conservative lower bound, sorted
/// ascending — the kernel's early-break key).
pub struct TileBuffers {
    pub inner: Vec<f32>,
    pub meta: Vec<f64>,
    pub rxll: Vec<f64>,
    pub rxar: Vec<f32>,
    pub barr: Vec<f64>,
}

/// A layer's line sources, packed ONCE per (region, layer) and uploaded once; the
/// per-tile bins (`PixelBins.indices`) index into these arrays, so they are tile-
/// invariant. Previously re-packed and re-uploaded per tile — ~160 MB/tile on a
/// dense (LKPR-class) layer, ~30× redundant PCIe + CPU work across a region.
pub struct SourceBuffers {
    pub seg: Vec<f64>,
    pub sp: Vec<f64>,
    pub semis: Vec<f32>,
}

/// Pack a layer's line sources (tile-invariant): `seg` (4 coords), `sp` (12 =
/// length/reach/height/bridge ++ 8 host-precomputed Lden band weights), `semis`
/// (3 periods × 8 emission bands). The 8 `sp[4+i]` = `Σ_p LDEN_W[p]·emission_lin[p][i]`
/// — the energy-budget-skip UB loop's per-band Lden weight, hoisted off the GPU
/// (was 24 f64 mul-adds + casts per source×receiver inside `line_source`; the kernel
/// now reads `sp[4+i]`). Byte-identical: same f64 FMA, just evaluated once on the host.
const LDEN_W: [f64; 3] = [12.0, 12.649110640673518, 80.0]; // 4·√10 (mirror scatter.cu LDEN_W)
pub fn pack_sources(lines: &[LineRow]) -> SourceBuffers {
    let (mut seg, mut sp, mut semis) = (
        Vec::with_capacity(lines.len() * 4),
        Vec::with_capacity(lines.len() * 12),
        Vec::with_capacity(lines.len() * 24),
    );
    for r in lines {
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
    SourceBuffers { seg, sp, semis }
}

/// Pack one tile's per-tile device buffers (inner DEM + meta + receivers +
/// barriers). The line sources are NOT here — they are layer-invariant (see
/// [`pack_sources`]). `halo_geom` = (lat_min, lon_min, inv, rows, cols) of the
/// SHARED batch halo. `barriers` is this tile's `BarrierData::for_tile` slice;
/// an empty slice packs one zero row (cuMemAlloc rejects 0 bytes) with
/// `meta[11] = 0` so the kernel never reads it.
pub fn pack_tile(
    tile: &FusedTileZ13,
    halo_geom: (f64, f64, f64, usize, usize),
    eta: f64,
    tw: f64,
    barriers: &[Barrier],
    nsrc: usize,
) -> TileBuffers {
    let (lat_min, lon_min, inv, rows, cols) = halo_geom;
    let n = TILE_PX * TILE_PX;
    // meta[12] = nsrc: the kernel reads the source count from meta because
    // the freed launch-arg slot carries the obstacle pointer table (cudarc's
    // tuple launch caps at 12 args).
    let meta = vec![
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
        barriers.len() as f64,
        nsrc as f64,
    ];
    let mut rxll = Vec::with_capacity(2 * TILE_PX);
    rxll.extend_from_slice(&tile.rx_lat);
    rxll.extend_from_slice(&tile.rx_lon);
    let mut rxar = Vec::with_capacity(n * 2);
    for i in 0..n {
        rxar.push(tile.rx_alt_m[i]);
        rxar.push(tile.rx_refl_db[i]);
    }
    let mut barr = Vec::with_capacity(barriers.len().max(1) * 4);
    for b in barriers {
        barr.extend_from_slice(&[b.lat, b.lon, b.height_m as f64, b.dist_m]);
    }
    if barr.is_empty() {
        barr.extend_from_slice(&[0.0; 4]);
    }
    TileBuffers {
        inner: tile.inner_elev_m.clone(),
        meta,
        rxll,
        rxar,
        barr,
    }
}

/// Host-flat obstacle store for the CUDA lane (geodata-v2 1.6): every
/// per-cell [`ObstacleIndex`] of a region's [`ObstacleSet`] flattened into
/// four uploadable arrays. Per index, `metas` carries 12 f64:
/// `[origin_lat, origin_lon, m_per_deg_lon, cell_m, min_x, min_y, cols,
/// rows, starts_off, refs_off, edges_off, n_refs_cells]` where the offsets
/// index the SHARED `starts`/`refs`/`edges` arrays (edges stride 5:
/// x0,y0,x1,y1,height — `GpuGridView` order). The kernel DDA mirrors
/// `ObstacleIndex::crossings` per index; e2-full is the parity gate.
pub struct ObstacleFlat {
    pub n_indexes: usize,
    pub metas: Vec<f64>,
    pub starts: Vec<u32>,
    pub refs: Vec<u32>,
    pub edges: Vec<f32>,
}

pub fn flatten_obstacles(
    set: &noise_compute::propagation::obstacle_index::ObstacleSet,
) -> ObstacleFlat {
    let mut flat = ObstacleFlat {
        n_indexes: set.indexes.len(),
        metas: Vec::with_capacity(set.indexes.len() * 12),
        starts: Vec::new(),
        refs: Vec::new(),
        edges: Vec::new(),
    };
    for idx in &set.indexes {
        let v = idx.gpu_view();
        flat.metas.extend_from_slice(&[
            v.origin_lat,
            v.origin_lon,
            v.m_per_deg_lon,
            v.cell_m,
            v.min_x,
            v.min_y,
            v.cols as f64,
            v.rows as f64,
            flat.starts.len() as f64,
            flat.refs.len() as f64,
            (flat.edges.len() / 5) as f64,
            // slot 11: this index's starts extent — the kernel never reads
            // it (its walk is bounded by cols×rows), but the flatten test
            // proves the shared arrays tile exactly with it.
            v.cell_starts.len() as f64,
        ]);
        flat.starts.extend_from_slice(v.cell_starts);
        flat.refs.extend_from_slice(v.edge_refs);
        flat.edges.extend_from_slice(&v.edges_xyxyh);
    }
    flat
}

#[cfg(test)]
mod obstacle_flat_tests {
    /// Offsets must tile the shared arrays exactly — a mis-offset walks a
    /// neighbouring cell-index's edges (silent physics corruption).
    #[test]
    fn flatten_offsets_are_consistent() {
        use noise_compute::propagation::obstacle_index::{
            ObstacleIndex, ObstacleKind, ObstacleSet,
        };
        let mut sets = Vec::new();
        for (olat, olon) in [(50.0, 14.0), (50.5, 14.5)] {
            let mut b = ObstacleIndex::builder(olat, olon);
            let ring: Vec<(f64, f64)> = [(0.0, 0.0), (0.001, 0.0), (0.001, 0.001), (0.0, 0.001)]
                .iter()
                .map(|(dlat, dlon)| (olat + dlat, olon + dlon))
                .collect();
            b.add_ring(&ring, 10.0, ObstacleKind::Building, 0);
            sets.push(std::sync::Arc::new(b.build()));
        }
        let set = ObstacleSet { indexes: sets };
        let flat = super::flatten_obstacles(&set);
        assert_eq!(flat.n_indexes, 2);
        assert_eq!(flat.metas.len(), 24);
        // Second index's offsets start exactly where the first index ends,
        // and its extents tile the shared arrays completely.
        let (starts_off2, refs_off2, edges_off2, n_cells2) = (
            flat.metas[12 + 8] as usize,
            flat.metas[12 + 9] as usize,
            flat.metas[12 + 10] as usize,
            flat.metas[12 + 11] as usize,
        );
        assert_eq!(flat.metas[11] as usize, starts_off2, "starts contiguous");
        assert_eq!(starts_off2 + n_cells2, flat.starts.len(), "starts tiled");
        assert_eq!(edges_off2, 4, "first ring = 4 edges");
        assert_eq!((edges_off2 + 4) * 5, flat.edges.len(), "edges tiled");
        // per-index refs extent = its last cell_start (CSR total)
        assert_eq!(
            refs_off2 + *flat.starts.last().unwrap() as usize,
            flat.refs.len(),
            "refs tiled"
        );
        assert!(flat.edges.len() % 5 == 0 && !flat.refs.is_empty());
    }
}

// ---- Vector-obstacle GPU upload (geodata-v2 1.6) — shared by gpu-surface
// and the e2-full validator, so it lives here behind the gpu feature.
#[cfg(feature = "gpu")]
mod obstacle_upload {
    use anyhow::{Context, Result};
    use cudarc::driver::{CudaDevice, CudaSlice};
    use std::sync::Arc;

    /// The region's vector obstacles resident on the GPU. `table` is the 5-slot
    /// pointer table the kernel dereferences ({n, metas, starts, refs, edges});
    /// the four `_`-prefixed slices only exist to keep those device allocations
    /// alive for as long as the table can be launched with. Raster mode = a
    /// 1-element `[0]` table.
    pub struct ObstDev {
        pub table: CudaSlice<u64>,
        _metas: Option<CudaSlice<f64>>,
        _starts: Option<CudaSlice<u32>>,
        _refs: Option<CudaSlice<u32>>,
        _edges: Option<CudaSlice<f32>>,
    }

    pub fn upload_obstacles(
        dev: &Arc<CudaDevice>,
        set: Option<&noise_compute::propagation::obstacle_index::ObstacleSet>,
    ) -> Result<ObstDev> {
        use cudarc::driver::DevicePtr;
        let Some(set) = set else {
            return Ok(ObstDev {
                table: dev.htod_copy(vec![0u64]).context("obst off-table")?,
                _metas: None,
                _starts: None,
                _refs: None,
                _edges: None,
            });
        };
        let flat = crate::flatten_obstacles(set);
        let metas = dev.htod_copy(flat.metas).context("obst metas")?;
        let starts = dev.htod_copy(flat.starts).context("obst starts")?;
        let refs = dev.htod_copy(flat.refs).context("obst refs")?;
        let edges = dev.htod_copy(flat.edges).context("obst edges")?;
        let table = dev
            .htod_copy(vec![
                flat.n_indexes as u64,
                *metas.device_ptr(),
                *starts.device_ptr(),
                *refs.device_ptr(),
                *edges.device_ptr(),
            ])
            .context("obst table")?;
        Ok(ObstDev {
            table,
            _metas: Some(metas),
            _starts: Some(starts),
            _refs: Some(refs),
            _edges: Some(edges),
        })
    }
}
#[cfg(feature = "gpu")]
pub use obstacle_upload::{upload_obstacles, ObstDev};
