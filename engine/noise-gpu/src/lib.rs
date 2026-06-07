//! Shared host-side helpers for the GPU surface scatter (used by the e2-full
//! validator and the gpu-surface production batch runner).

/// Region-resident GPU airborne scatter, shared by the `e2-airborne` validator and the
/// `gpu-airborne` production builder (cudarc-backed, so gated on the `gpu` feature).
#[cfg(feature = "gpu")]
pub mod airborne;

use heatmap_aircraft::source_line::LineRow;
use noise_compute::emission::aircraft::{Installation, SegmentPrepared, M_PER_DEG_LAT};
use noise_compute::propagation::geo::point_to_segment_full;
use noise_compute::propagation::path_profile::path_dist_m;
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

/// Pixel-bin edge: an 8×8 receiver patch = one CUDA block in `line_binned`.
pub const BIN_W: usize = 8;
/// Bins per axis (32) and total bins per tile (1024).
pub const BIN_TILES: usize = TILE_PX / BIN_W;
pub const N_BINS: usize = BIN_TILES * BIN_TILES;

/// CSR source bins for `line_binned`: per 8×8 pixel block, the line-source indices
/// whose reach can intersect that block — conservative (the exact per-pixel cull
/// still runs on the GPU), in ORIGINAL source order (budget-skip parity). The
/// GPU's pixel-major analogue of the CPU's per-source reach-box: it avoids
/// scanning all sources per pixel (~4400 candidates/dense block, ~2/rural).
pub struct PixelBins {
    pub offsets: Vec<i32>,
    pub indices: Vec<i32>,
    pub avg_sources: f64,
    pub max_sources: usize,
}

/// Build the per-8×8-block source bins for one tile. Serial O(nsrc × N_BINS)
/// point-to-segment; the cost is pipelinable with the GPU (bin tile N+1 while the
/// GPU runs N) and parallelizable.
pub fn build_pixel_bins(tile: &FusedTileZ13, lines: &[LineRow]) -> PixelBins {
    // Block centre + radius (centre→furthest corner) for each 8×8 patch.
    let mut centres = Vec::with_capacity(N_BINS);
    for by in 0..BIN_TILES {
        for bx in 0..BIN_TILES {
            let (py0, py1) = (by * BIN_W, by * BIN_W + BIN_W - 1);
            let (px0, px1) = (bx * BIN_W, bx * BIN_W + BIN_W - 1);
            let lat = 0.5 * (tile.rx_lat[py0] + tile.rx_lat[py1]);
            let lon = 0.5 * (tile.rx_lon[px0] + tile.rx_lon[px1]);
            let radius = [
                (tile.rx_lat[py0], tile.rx_lon[px0]),
                (tile.rx_lat[py0], tile.rx_lon[px1]),
                (tile.rx_lat[py1], tile.rx_lon[px0]),
                (tile.rx_lat[py1], tile.rx_lon[px1]),
            ]
            .into_iter()
            .map(|(clat, clon)| path_dist_m(lat, lon, clat, clon))
            .fold(0.0, f64::max);
            centres.push((lat, lon, radius));
        }
    }
    // A source lands in a bin if its distance to the block centre ≤ reach + radius
    // (so it could reach SOME pixel in the block). Conservative ⇒ correct. Parallel
    // over bins (all cores); each bin scans sources in order ⇒ original order kept.
    // This is the rural-tile bottleneck (kernel ~18 ms vs serial binning ~250 ms).
    use rayon::prelude::*;
    let bins: Vec<Vec<i32>> = centres
        .par_iter()
        .map(|&(lat, lon, radius)| {
            lines
                .iter()
                .enumerate()
                .filter_map(|(si, r)| {
                    let pts = point_to_segment_full(
                        lat,
                        lon,
                        r.start_lat,
                        r.start_lon,
                        r.end_lat,
                        r.end_lon,
                    );
                    (pts.d_endpoint_m <= r.max_distance_m + radius).then_some(si as i32)
                })
                .collect()
        })
        .collect();
    let (mut offsets, mut indices) = (Vec::with_capacity(N_BINS + 1), Vec::new());
    let (mut total, mut max_sources) = (0usize, 0usize);
    offsets.push(0);
    for bin in bins {
        total += bin.len();
        max_sources = max_sources.max(bin.len());
        indices.extend_from_slice(&bin);
        offsets.push(indices.len() as i32);
    }
    PixelBins {
        offsets,
        indices,
        avg_sources: total as f64 / N_BINS as f64,
        max_sources,
    }
}

/// Per-tile non-halo buffers packed for the `line`/`line_binned` kernels (the halo
/// elev/cover are uploaded once per batch and shared; the line SOURCES are uploaded
/// once per layer — see [`SourceBuffers`]). `meta` carries the SHARED halo geom +
/// this tile's bbox + eta + swizzle width.
pub struct TileBuffers {
    pub inner: Vec<f32>,
    pub meta: Vec<f64>,
    pub rxll: Vec<f64>,
    pub rxar: Vec<f32>,
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

/// Pack a layer's line sources (tile-invariant): `seg` (4 coords), `sp`
/// (length/reach/height/bridge), `semis` (3 periods × 8 emission bands).
pub fn pack_sources(lines: &[LineRow]) -> SourceBuffers {
    let (mut seg, mut sp, mut semis) = (
        Vec::with_capacity(lines.len() * 4),
        Vec::with_capacity(lines.len() * 4),
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
        for p in 0..3 {
            for i in 0..8 {
                semis.push(r.emission_lin[p][i]);
            }
        }
    }
    SourceBuffers { seg, sp, semis }
}

/// Pack one tile's per-tile device buffers (inner DEM + meta + receivers). The line
/// sources are NOT here — they are layer-invariant (see [`pack_sources`]).
/// `halo_geom` = (lat_min, lon_min, inv, rows, cols) of the SHARED batch halo.
pub fn pack_tile(
    tile: &FusedTileZ13,
    halo_geom: (f64, f64, f64, usize, usize),
    eta: f64,
    tw: f64,
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
    ];
    let mut rxll = Vec::with_capacity(2 * TILE_PX);
    rxll.extend_from_slice(&tile.rx_lat);
    rxll.extend_from_slice(&tile.rx_lon);
    let mut rxar = Vec::with_capacity(n * 2);
    for i in 0..n {
        rxar.push(tile.rx_alt_m[i]);
        rxar.push(tile.rx_refl_db[i]);
    }
    TileBuffers {
        inner: tile.inner_elev_m.clone(),
        meta,
        rxll,
        rxar,
    }
}
