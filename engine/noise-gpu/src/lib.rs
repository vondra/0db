//! Shared host-side helpers for the GPU surface scatter (used by the e2-full
//! validator and the gpu-surface production batch runner).

use heatmap_aircraft::source_line::LineRow;
use noise_compute::propagation::geo::point_to_segment_full;
use noise_compute::propagation::path_profile::path_dist_m;
use raster_reader::fused_tile_z13::{FusedTileZ13, TILE_PX};

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
            lines.iter()
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
/// elev/cover are uploaded once per batch and shared). `meta` carries the SHARED
/// halo geom + this tile's bbox + eta + swizzle width.
pub struct TileBuffers {
    pub inner: Vec<f32>,
    pub meta: Vec<f64>,
    pub seg: Vec<f64>,
    pub sp: Vec<f64>,
    pub semis: Vec<f32>,
    pub rxll: Vec<f64>,
    pub rxar: Vec<f32>,
}

/// Pack one tile's device buffers. `halo_geom` = (lat_min, lon_min, inv, rows, cols)
/// of the SHARED batch halo (from `FusedGrid::geom`).
pub fn pack_tile(
    tile: &FusedTileZ13,
    lines: &[LineRow],
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
        seg,
        sp,
        semis,
        rxll,
        rxar,
    }
}
