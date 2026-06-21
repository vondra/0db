//! Shared host-side helpers for the GPU surface scatter (used by the e2-full
//! validator and the gpu-surface production batch runner).

/// Region-resident GPU airborne scatter, shared by the `e2-airborne` validator and the
/// `gpu-airborne` production builder (cudarc-backed, so gated on the `gpu` feature).
#[cfg(feature = "gpu")]
pub mod airborne;

use heatmap_aircraft::source_line::LineRow;
use noise_compute::emission::aircraft::{Installation, SegmentPrepared, M_PER_DEG_LAT};
use noise_compute::types::Barrier;
use raster_reader::fused_tile_z13::{FusedTileZ13, TILE_PX};

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
/// Bins per tile (256) — `line_binned`'s grid dim.
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
) -> TileBuffers {
    let (lat_min, lon_min, inv, rows, cols) = halo_geom;
    let n = TILE_PX * TILE_PX;
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
