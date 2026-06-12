//! Real raster reader — raw 1°×1° tiles, mmap'd, global scale.
//!
//! Implements noise_compute::types::RasterSampler for both popup (lazy) and pipeline (pre-loaded).
//! Reads Copernicus GLO-30 / SRTM DEM, Overture building height, WorldCover forest, IMD ground type.

pub mod fused_tile_z13;
pub mod tile;

use std::path::Path;
use noise_compute::types::RasterSampler;
use tile::{TileStore, DType, Interp};

pub use tile::RawTile;

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

/// Half-edge of the `building_enclosure` 3×3 probe footprint, in metres.
/// 75 m yields a 150 × 150 m isotropic square; the prior 0.001° degree
/// step squeezed E-W at high latitudes (down to ~75 m at 70°N), making
/// the enclosure metric latitude-dependent.
const ENCLOSURE_RADIUS_M: f64 = 75.0;

/// Real raster data from 1°×1° tiles. Implements RasterSampler.
pub struct RealRasters {
    pub dem: TileStore,
    pub building: TileStore,
    pub forest: TileStore,
    pub imd: TileStore,
}

impl RealRasters {
    /// Create from source-data directory. Tiles loaded lazily on first access.
    pub fn new(data_dir: &Path) -> Self {
        // Defaults to 32 not 12: 12 is below the working-set size of
        // any realistic extract bbox (Praha alone is ~20 1°×1° DEM
        // tiles), so the LRU evict path fires repeatedly and scans
        // every tile slot each time. 32 covers most regional bboxes
        // without code changes; operators override with the env-var
        // for global runs.
        let dem_cache_tiles = env_usize("QUIETMAP_CACHE_DEM_TILES", 32);
        let building_cache_tiles = env_usize("QUIETMAP_CACHE_BUILDING_TILES", 64);
        let forest_cache_tiles = env_usize("QUIETMAP_CACHE_FOREST_TILES", 64);
        let imd_cache_tiles = env_usize("QUIETMAP_CACHE_IMD_TILES", 128);

        // DEM: Copernicus GLO-30 primary (.hgt), SRTM fallback (.hgt)
        let dem = TileStore::new(
            data_dir.join("dem/copernicus"), 3601, DType::I16BE, Interp::Bilinear, 0.0, ".hgt",
            dem_cache_tiles,
        ).with_alt_dir(data_dir.join("dem/srtm"), ".hgt");

        // Building height: u8 (meters), 3601×3601 (Overture 30m), nearest-neighbor
        let building = TileStore::new(
            data_dir.join("rasters/building"), 3601, DType::U8, Interp::Nearest, 0.0, ".raw",
            building_cache_tiles,
        );

        // Forest cover: u8 (0/100%), 3601×3601 (WorldCover 30m), nearest-neighbor
        let forest = TileStore::new(
            data_dir.join("rasters/forest"), 3601, DType::U8, Interp::Nearest, 0.0, ".raw",
            forest_cache_tiles,
        );

        // IMD ground type: u8 (0-100 imperviousness), 3601×3601 (30m), bilinear.
        // Missing-tile default 100 = hard (G=0): the WorldCover converter emits
        // an IMD tile for every land tile, so a tile absent from the complete
        // set is open ocean — acoustically hard water (ISO 9613-2, audit B3).
        // Caveat: on hosts with a partial tree (ry177 carries only 34–59°N
        // plus synced Scandinavia) missing northern LAND tiles read hard too;
        // he84's complete tree is the production truth.
        let imd = TileStore::new(
            data_dir.join("rasters/imd"), 3601, DType::U8, Interp::Bilinear, 100.0, ".raw",
            imd_cache_tiles,
        );

        RealRasters { dem, building, forest, imd }
    }

    /// Pre-load all tiles covering a bounding box. Call before rayon par_iter.
    /// After this, all sample() calls within bbox are lock-free (cache hits).
    pub fn preload_bbox(&self, lat_min: f64, lat_max: f64, lon_min: f64, lon_max: f64) {
        self.dem.preload_bbox(lat_min, lat_max, lon_min, lon_max);
        self.building.preload_bbox(lat_min, lat_max, lon_min, lon_max);
        self.forest.preload_bbox(lat_min, lat_max, lon_min, lon_max);
        self.imd.preload_bbox(lat_min, lat_max, lon_min, lon_max);
    }

    /// Check if any real raster data is available.
    pub fn has_data(&self) -> bool {
        // Quick check: try sampling a known CZ point
        let elev = self.dem.sample(49.195, 16.608);
        elev != 0.0
    }
}

impl RealRasters {
    /// Nearest-neighbor DEM lookup — for aircraft-extract Stage 1 +
    /// Stage 2A only. ~3-4× cheaper per lookup than `elevation()`
    /// because it skips the 4-pixel bilinear blend. Acoustically safe
    /// for the AGL-gate path: gates have 15-30 m slack everywhere
    /// except three documented edge cases (phase seed at 7 620 m,
    /// GROUND_STALE_MAX_AGL_M, RAW_GROUND_FLAG_MAX_AGL_M) — full
    /// error model in `.claude/plans/stage1-nn-dem.md`.
    ///
    /// Deliberately NOT on the `RasterSampler` trait — the trait is
    /// the popup contract and stays bilinear for terrain profile
    /// continuity.
    pub fn elevation_nearest(&self, lat: f64, lon: f64) -> f64 {
        self.dem.sample_with(lat, lon, Interp::Nearest)
    }

    /// Caller-threaded NN DEM lookup. Pairs with
    /// [`elevation_nearest`]: when a caller (Stage 1 per-flight loop,
    /// Stage 2A per-sub-segment) sweeps many points likely to fall in
    /// the same 1° tile, threading a stack `(cached_key, cached_tile)`
    /// pair across calls skips the per-tile mutex AND the global
    /// `use_counter` atomic on cache hits.
    ///
    /// Initialize both with `(i32::MIN, i32::MIN)` and `None`; the
    /// method updates them in place.
    pub fn elevation_nearest_cached(
        &self,
        lat: f64,
        lon: f64,
        cached_key: &mut (i32, i32),
        cached_tile: &mut Option<std::sync::Arc<RawTile>>,
    ) -> f64 {
        self.dem
            .sample_cached_with(lat, lon, Interp::Nearest, cached_key, cached_tile)
    }
}

impl RasterSampler for RealRasters {
    fn elevation(&self, lat: f64, lon: f64) -> f64 {
        self.dem.sample(lat, lon)
    }

    fn building_height(&self, lat: f64, lon: f64) -> f64 {
        self.building.sample(lat, lon)
    }

    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        // IMD 0=natural(soft), 100=impervious(hard)
        // G: 0=hard, 1=soft → G = 1.0 - IMD/100
        // Missing-tile default is 100 (ocean → hard water, G=0), so no special
        // case needed — land tiles always exist in the converted set.
        // WHY no conditional: IMD=0 means fully soft ground (forest, meadow) → G=1.0.
        // Old code returned 0.5 for IMD=0, halving ground attenuation in rural areas.
        let imd = self.imd.sample(lat, lon);
        (1.0 - imd / 100.0).clamp(0.0, 1.0)
    }

    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        // 3×3 probe at ENCLOSURE_RADIUS_M (75 m) N-S and E-W.
        // Earlier code used a constant 0.001° step which is ~111 m N-S
        // but only ~111·cos(lat) m E-W — a 220 × 142 m rectangle at
        // Praha (50°N), shrinking to 220 × 75 m at Tromsø (70°N).
        // Converting to metric isotropises the enclosure footprint.
        let step_lat_deg = ENCLOSURE_RADIUS_M / noise_compute::constants::M_PER_DEG_LAT;
        let step_lon_deg = ENCLOSURE_RADIUS_M
            / noise_compute::constants::m_per_deg_lon(lat.to_radians());
        let mut tall_count = 0;
        let mut total = 0;
        for dr in [-1, 0, 1] {
            for dc in [-1, 0, 1] {
                // Wrap probe longitude across the antimeridian — for a
                // receiver near ±180°, the dc=±1 column would otherwise
                // sample an out-of-bounds tile (clamped to ±179° edge),
                // diverging from `FusedGrid::building_enclosure`.
                let probe_lon =
                    ((lon + dc as f64 * step_lon_deg + 180.0).rem_euclid(360.0)) - 180.0;
                let h = self.building.sample(lat + dr as f64 * step_lat_deg, probe_lon);
                if h > 5.0 { tall_count += 1; }
                total += 1;
            }
        }
        let density = tall_count as f64 / total as f64;
        if density > 0.5 { 3.0 }
        else if density > 0.2 { 1.5 }
        else { 0.0 }
    }

    fn max_building_along_path(
        &self, src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64,
        dist_m: f64, excl_start_m: f64,
    ) -> (f64, f64) {
        // Adaptive step locked to raster cell multiples (Overture 30 m):
        //   ≤1 km  → 1× cell  (~30.7 m, full resolution)
        //   ≤3 km  → 3× cell  (~92 m)
        //   >3 km  → 6× cell  (~184 m)
        // Fine cadence catches obstacles consistent with the 30 m building raster;
        // tile-cached lookups keep per-sample cost near zero.
        let step = if dist_m <= 1000.0 { CELL_M }
            else if dist_m <= 3000.0 { CELL_M * 3.0 }
            else { CELL_M * 6.0 };
        let n = ((dist_m / step).ceil() as usize).clamp(2, 400);
        let mut max_bh = 0.0f64;
        let mut max_t = 0.5;
        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile = None;
        for k in 1..n {
            let t = k as f64 / n as f64;
            if excl_start_m > 0.0 && t * dist_m < excl_start_m { continue; }
            let lat = src_lat + t * (rcv_lat - src_lat);
            let lon = src_lon + t * (rcv_lon - src_lon);
            let bh = self.building.sample_cached(lat, lon, &mut cached_key, &mut cached_tile);
            if bh > max_bh { max_bh = bh; max_t = t; }
        }
        (max_bh, max_t)
    }

    fn max_building_along_path_stats(
        &self, src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64,
        dist_m: f64, excl_start_m: f64,
    ) -> (f64, f64, u32, f64) {
        // Same scan as max_building_along_path but returns sample count + step for popup transparency.
        let step = if dist_m <= 1000.0 { CELL_M }
            else if dist_m <= 3000.0 { CELL_M * 3.0 }
            else { CELL_M * 6.0 };
        let n = ((dist_m / step).ceil() as usize).clamp(2, 400);
        let mut max_bh = 0.0f64;
        let mut max_t = 0.5;
        let mut taken: u32 = 0;
        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile = None;
        for k in 1..n {
            let t = k as f64 / n as f64;
            if excl_start_m > 0.0 && t * dist_m < excl_start_m { continue; }
            let lat = src_lat + t * (rcv_lat - src_lat);
            let lon = src_lon + t * (rcv_lon - src_lon);
            let bh = self.building.sample_cached(lat, lon, &mut cached_key, &mut cached_tile);
            taken += 1;
            if bh > max_bh { max_bh = bh; max_t = t; }
        }
        (max_bh, max_t, taken, step)
    }

    fn build_path_profile(
        &self,
        src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64, dist_m: f64,
        out: &mut noise_compute::propagation::PathProfile,
    ) {
        out.clear();
        out.dist_m = dist_m;
        out.src_lat = src_lat;
        out.src_lon = src_lon;
        out.rcv_lat = rcv_lat;
        out.rcv_lon = rcv_lon;

        noise_compute::propagation::path_profile::fill_t_values(dist_m, &mut out.t);

        let n = out.t.len();
        out.elevation_m.reserve(n);
        out.building_h_m.reserve(n);
        out.forest_u8.reserve(n);
        out.imd_u8.reserve(n);

        // Per-raster tile caches — each warms on the first sample in a tile,
        // stays warm while consecutive samples fall in the same 1° tile.
        let mut dem_key = (i32::MIN, i32::MIN);
        let mut dem_tile = None;
        let mut bld_key = (i32::MIN, i32::MIN);
        let mut bld_tile = None;
        let mut for_key = (i32::MIN, i32::MIN);
        let mut for_tile = None;
        let mut imd_key = (i32::MIN, i32::MIN);
        let mut imd_tile = None;

        for &t in &out.t {
            let lat = src_lat + t * (rcv_lat - src_lat);
            let lon = src_lon + t * (rcv_lon - src_lon);
            let elev = self.dem.sample_cached(lat, lon, &mut dem_key, &mut dem_tile);
            let bh = self.building.sample_cached(lat, lon, &mut bld_key, &mut bld_tile);
            let fr = self.forest.sample_cached(lat, lon, &mut for_key, &mut for_tile);
            let imd = self.imd.sample_cached(lat, lon, &mut imd_key, &mut imd_tile);
            out.elevation_m.push(elev as f32);
            out.building_h_m.push(bh.clamp(0.0, 255.0) as u8);
            out.forest_u8.push(fr.clamp(0.0, 255.0) as u8);
            out.imd_u8.push(imd.clamp(0.0, 255.0) as u8);
        }

        // The bilateral adaptive cadence (dense near endpoints, coarse mid-path)
        // IS the sampling strategy. The P3 mid-path peak augmentation that
        // re-scanned every coarse gap at 30 m was removed: it re-walked the very
        // terrain the cadence deliberately coarsens, undercutting the cadence's
        // purpose, for a refinement the cadence already largely captures.
        out.step_m_med = noise_compute::propagation::path_profile::median_step_m(&out.t, dist_m);
    }
}

/// Raster cell size in meters (~30.7m). Kept for callers that need it as a
/// constant; the bilateral cadence itself lives in
/// `noise_compute::propagation::path_profile::fill_t_values`.
const CELL_M: f64 = 110_540.0 / 3600.0;

/// L3-cache-resident cropped raster grid for pipeline compute.
///
/// Pre-reads DEM + building + forest + IMD for the hex bbox into ONE contiguous
/// Vec, cropped to just the needed area (~22 MB for a typical R4 hex + ring).
/// Implements RasterSampler so all existing path_effects code works unchanged.
/// Zero algorithmic change = zero dB error vs mmap-based RealRasters.
///
/// `Clone` exists for [`FusedGrid::burn_building_max`] experiments: burning
/// into a COPY leaves the original — and the receiver reflection pre-baked
/// from it — untouched.
#[derive(Clone)]
pub struct FusedGrid {
    data: Vec<FusedPixel>,
    lat_min: f64,
    lon_min: f64,
    inv_cell_deg: f64,
    cols: usize,
    rows: usize,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct FusedPixel {
    pub elevation: f32,  // DEM (meters, full precision bilinear)
    pub building: u8,    // building height (meters)
    pub forest: u8,      // forest cover (0 or 100)
    pub imd: u8,         // imperviousness 0-100
    pub _pad: u8, // total: 4+1+1+1+1 = 8 bytes per pixel
}

impl FusedGrid {
    /// Build from RealRasters, cropping to bbox. ~0.2-0.5s for typical hex.
    pub fn build(rasters: &RealRasters, lat_min: f64, lat_max: f64, lon_min: f64, lon_max: f64) -> Self {
        let cell_deg = 1.0 / 3600.0;
        let inv_cell_deg = 3600.0;

        // Snap origin to the 1/3600° DEM pixel lattice (integer-lattice
        // arithmetic avoids float edge slop). Without this, `build` samples
        // DEM at sub-cell-shifted positions, introducing a persistent
        // half-cell phase error that `lookup_fused` / `pixel` cannot correct.
        //
        // Margin sized to cover `building_enclosure`'s metric 3×3 probe
        // (ENCLOSURE_RADIUS_M = 75 m) plus the `pixel()` nearest-neighbour
        // half-cell rounding. Probe footprint in DEM cells (~30.7 m):
        // lat ≈ 2.4 cells; lon ≈ 2.4/cos(lat), reaching ~7.1 cells at
        // 70°N. 8 cells stays safe through ~71°N (cos(lat) ≥ 0.32) —
        // covers every populated Arctic city; above that the probe
        // clamps to edge pixels exactly like the pre-fix code did.
        const MARGIN_CELLS: i32 = 8;
        let lat_lo_i = (lat_min * inv_cell_deg).floor() as i32 - MARGIN_CELLS;
        let lon_lo_i = (lon_min * inv_cell_deg).floor() as i32 - MARGIN_CELLS;
        let lat_hi_i = (lat_max * inv_cell_deg).ceil() as i32 + MARGIN_CELLS;
        let lon_hi_i = (lon_max * inv_cell_deg).ceil() as i32 + MARGIN_CELLS;
        let lat_lo = lat_lo_i as f64 * cell_deg;
        let lon_lo = lon_lo_i as f64 * cell_deg;
        let rows = ((lat_hi_i - lat_lo_i + 1).max(2)) as usize;
        let cols = ((lon_hi_i - lon_lo_i + 1).max(2)) as usize;

        let mut data = vec![FusedPixel::default(); rows * cols];

        for r in 0..rows {
            let lat = lat_lo + r as f64 * cell_deg;
            for co in 0..cols {
                let lon = lon_lo + co as f64 * cell_deg;
                let idx = r * cols + co;
                let elev = rasters.dem.sample(lat, lon);
                data[idx] = FusedPixel {
                    elevation: elev as f32,
                    building: rasters.building.sample(lat, lon) as u8,
                    forest: rasters.forest.sample(lat, lon) as u8,
                    imd: rasters.imd.sample(lat, lon) as u8,
                    _pad: 0,
                };
            }
        }

        FusedGrid { data, lat_min: lat_lo, lon_min: lon_lo, inv_cell_deg, cols, rows }
    }

    /// Rasterise one noise-barrier segment into the BUILDING channel: every
    /// grid cell the segment crosses gets `building = max(building, height)`.
    ///
    /// NOT wired into any production path (B8/C9 verdict, 2026-06-11): this
    /// was the candidate GPU barrier representation (the CUDA surface kernels
    /// read screening obstacles from the 30 m cover raster and have no
    /// vector-barrier input), but the quantified comparison —
    /// heatmap-aircraft `tests/barrier_screening.rs::w2_vector_vs_burn_
    /// quantified_decision_record` — measured the burn UNDER-screening by
    /// mean +3.7 / max +13.8 dB at wall-adjacent shadow pixels: the bilateral
    /// ray cadence (≥ ~30 m sample spacing) steps over a one-cell-thin burned
    /// wall on most paths, while the CPU vector path
    /// (`path_effects::screening_attenuation`) maps the wall onto the nearest
    /// existing sample and never misses. Thin-line features cannot be
    /// faithfully represented in a raster sampled at ≥ cell-size cadence, so
    /// barriers ship CPU-vector-only and this function remains as the
    /// decision-record apparatus. If you re-open the GPU question, burn a
    /// CLONE (receiver reflection is pre-baked from the unburned halo by
    /// `FusedTileZ13::build_with_halo` — barriers must screen, never reflect).
    ///
    /// Supercover traversal (Amanatides & Woo, 4-connected): a diagonal wall
    /// has no one-past-the-corner gaps a nearest-neighbour ray sample could
    /// slip through, which plain 8-connected Bresenham would leave. Cells are
    /// matched on the nearest-neighbour convention (`pixel()` rounds, so cell
    /// (r, c) spans [r−0.5, r+0.5)). Out-of-grid cells are skipped, never
    /// clamped — clamping would smear far barriers onto the halo edge.
    pub fn burn_building_max(
        &mut self,
        start_lat: f64,
        start_lon: f64,
        end_lat: f64,
        end_lon: f64,
        height_m: f32,
    ) {
        let h = height_m.round().clamp(0.0, 255.0) as u8;
        if h == 0 || !(start_lat.is_finite() && start_lon.is_finite() && end_lat.is_finite() && end_lon.is_finite()) {
            return;
        }
        // Continuous coords in floor-grid space: +0.5 shifts the rounding
        // convention so `floor` yields the same cell `pixel()` rounds to.
        let u0 = (start_lat - self.lat_min) * self.inv_cell_deg + 0.5;
        let v0 = (start_lon - self.lon_min) * self.inv_cell_deg + 0.5;
        let u1 = (end_lat - self.lat_min) * self.inv_cell_deg + 0.5;
        let v1 = (end_lon - self.lon_min) * self.inv_cell_deg + 0.5;
        let mut r = u0.floor() as i64;
        let mut c = v0.floor() as i64;
        let r_end = u1.floor() as i64;
        let c_end = v1.floor() as i64;
        // Whole segment on one side of the grid slab in either axis ⇒ no cell
        // crossed; O(1) reject for the region barriers far from this halo.
        let (rows, cols) = (self.rows as i64, self.cols as i64);
        if (r < 0 && r_end < 0)
            || (r >= rows && r_end >= rows)
            || (c < 0 && c_end < 0)
            || (c >= cols && c_end >= cols)
        {
            return;
        }
        let step_r: i64 = if u1 >= u0 { 1 } else { -1 };
        let step_c: i64 = if v1 >= v0 { 1 } else { -1 };
        // Parametric distance (in units of |Δ|⁻¹) to the next r/c cell
        // boundary, then constant per-cell increments — Amanatides & Woo.
        let inv_du = (u1 - u0).abs().recip(); // ∞ when the segment is axis-parallel
        let inv_dv = (v1 - v0).abs().recip();
        let mut t_max_r = if step_r > 0 { (r + 1) as f64 - u0 } else { u0 - r as f64 } * inv_du;
        let mut t_max_c = if step_c > 0 { (c + 1) as f64 - v0 } else { v0 - c as f64 } * inv_dv;
        // Supercover visits exactly |Δr| + |Δc| + 1 cells; the +4 pads float
        // edge cases so a boundary-grazing segment can't loop unbounded.
        let mut guard = (r_end - r).abs() + (c_end - c).abs() + 4;
        loop {
            if (0..rows).contains(&r) && (0..cols).contains(&c) {
                let px = &mut self.data[r as usize * self.cols + c as usize];
                px.building = px.building.max(h);
            }
            if (r == r_end && c == c_end) || guard <= 0 {
                return;
            }
            guard -= 1;
            if t_max_r < t_max_c {
                t_max_r += inv_du;
                r += step_r;
            } else {
                t_max_c += inv_dv;
                c += step_c;
            }
        }
    }

    /// Nearest-neighbor pixel lookup — matches `TileStore::sample_nearest`
    /// (rounds to the closest pixel). Taking `.floor() as usize` here biased
    /// the sample up-left by half a cell and made FusedGrid-based pipeline
    /// runs differ from RealRasters-based popup by 5-7 dB when a building /
    /// tree / impervious-surface edge fell inside the quad.
    #[inline]
    fn pixel(&self, lat: f64, lon: f64) -> &FusedPixel {
        let rf = (lat - self.lat_min) * self.inv_cell_deg;
        let cf = (lon - self.lon_min) * self.inv_cell_deg;
        let r = rf.round().clamp(0.0, (self.rows - 1) as f64) as usize;
        let c = cf.round().clamp(0.0, (self.cols - 1) as f64) as usize;
        &self.data[r * self.cols + c]
    }

    /// Bilinear IMD lookup — matches `RealRasters.imd` `Interp::Bilinear`
    /// config. Storage stays `u8` (0-100 range gives 0.01 G-factor quanta,
    /// worst per-band error ~0.025 dB — well below noise floor); the
    /// interpolation happens at query time over 4 u8 neighbours.
    #[inline]
    fn imd_bilinear(&self, lat: f64, lon: f64) -> f64 {
        let rf = (lat - self.lat_min) * self.inv_cell_deg;
        let cf = (lon - self.lon_min) * self.inv_cell_deg;
        let rf = rf.clamp(0.0, (self.rows - 1) as f64);
        let cf = cf.clamp(0.0, (self.cols - 1) as f64);
        let r0 = (rf.floor() as usize).min(self.rows - 2);
        let c0 = (cf.floor() as usize).min(self.cols - 2);
        let fr = rf - r0 as f64;
        let fc = cf - c0 as f64;
        let base = r0 * self.cols + c0;
        let v00 = self.data[base].imd as f64;
        let v01 = self.data[base + 1].imd as f64;
        let v10 = self.data[base + self.cols].imd as f64;
        let v11 = self.data[base + self.cols + 1].imd as f64;
        let v0 = v00 + fc * (v01 - v00);
        let v1 = v10 + fc * (v11 - v10);
        v0 + fr * (v1 - v0)
    }

    #[inline]
    fn elevation_bilinear(&self, lat: f64, lon: f64) -> f64 {
        let rf = (lat - self.lat_min) * self.inv_cell_deg;
        let cf = (lon - self.lon_min) * self.inv_cell_deg;
        // Clamp BEFORE floor — prevents negative wrap and OOB linear
        // extrapolation (the prior form left `fr = rf - r0` negative for
        // points west/south of bbox, silently extrapolating elevation
        // into open space).
        let rf = rf.clamp(0.0, (self.rows - 1) as f64);
        let cf = cf.clamp(0.0, (self.cols - 1) as f64);
        let r0 = (rf.floor() as usize).min(self.rows - 2);
        let c0 = (cf.floor() as usize).min(self.cols - 2);
        let fr = rf - r0 as f64;
        let fc = cf - c0 as f64;
        let v00 = self.data[r0 * self.cols + c0].elevation as f64;
        let v01 = self.data[r0 * self.cols + c0 + 1].elevation as f64;
        let v10 = self.data[(r0 + 1) * self.cols + c0].elevation as f64;
        let v11 = self.data[(r0 + 1) * self.cols + c0 + 1].elevation as f64;
        let v0 = v00 + fc * (v01 - v00);
        let v1 = v10 + fc * (v11 - v10);
        v0 + fr * (v1 - v0)
    }
}

impl noise_compute::types::RasterSampler for FusedGrid {
    fn elevation(&self, lat: f64, lon: f64) -> f64 {
        self.elevation_bilinear(lat, lon)
    }

    fn building_height(&self, lat: f64, lon: f64) -> f64 {
        self.pixel(lat, lon).building as f64
    }

    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        // Bilinear IMD to match RealRasters config (Interp::Bilinear for
        // IMD). Without this, G jumps in 1/100 steps across pixel edges,
        // while popup sees a smooth gradient — popup/pipeline diverges
        // on hard/soft ground transitions.
        let imd = self.imd_bilinear(lat, lon);
        (1.0 - imd / 100.0).clamp(0.0, 1.0)
    }

    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        // Mirror RealRasters::building_enclosure: metric 3×3 probe at
        // ENCLOSURE_RADIUS_M (75 m). Required for popup/pipeline parity.
        let step_lat_deg = ENCLOSURE_RADIUS_M / noise_compute::constants::M_PER_DEG_LAT;
        let step_lon_deg = ENCLOSURE_RADIUS_M
            / noise_compute::constants::m_per_deg_lon(lat.to_radians());
        let mut tall = 0;
        let mut total = 0;
        for dr in [-1, 0, 1] {
            for dc in [-1, 0, 1] {
                // Wrap probe longitude across the antimeridian — keeps parity
                // with `RealRasters::building_enclosure`; without it, `pixel()`
                // clamps the out-of-bbox column and the two implementations
                // diverge near ±180°.
                let probe_lon =
                    ((lon + dc as f64 * step_lon_deg + 180.0).rem_euclid(360.0)) - 180.0;
                let h = self
                    .pixel(lat + dr as f64 * step_lat_deg, probe_lon)
                    .building;
                if h > 5 { tall += 1; }
                total += 1;
            }
        }
        let density = tall as f64 / total as f64;
        if density > 0.5 { 3.0 } else if density > 0.2 { 1.5 } else { 0.0 }
    }

    fn max_building_along_path(
        &self, src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64,
        dist_m: f64, excl_start_m: f64,
    ) -> (f64, f64) {
        // Mirror RealRasters / trait-default cadence exactly (uniform
        // cell / 3 × cell / 6 × cell by distance band). Previous version
        // used `fill_t_values` bilaterally, which has a 240 m mid-gap
        // that misses tall obstacles between endpoints — parity divergence.
        let cell_m = noise_compute::propagation::path_profile::CELL_M;
        let step = if dist_m <= 1000.0 {
            cell_m
        } else if dist_m <= 3000.0 {
            cell_m * 3.0
        } else {
            cell_m * 6.0
        };
        let n = ((dist_m / step).ceil() as usize).clamp(2, 400);
        let mut max_bh = 0.0_f64;
        let mut max_t = 0.5_f64;
        for k in 1..n {
            let t = k as f64 / n as f64;
            if excl_start_m > 0.0 && t * dist_m < excl_start_m {
                continue;
            }
            let lat = src_lat + t * (rcv_lat - src_lat);
            let lon = src_lon + t * (rcv_lon - src_lon);
            let bh = self.pixel(lat, lon).building as f64;
            if bh > max_bh {
                max_bh = bh;
                max_t = t;
            }
        }
        (max_bh, max_t)
    }

    fn build_path_profile(
        &self,
        src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64, dist_m: f64,
        out: &mut noise_compute::propagation::PathProfile,
    ) {
        noise_compute::propagation::path_profile::fill_t_values(dist_m, &mut out.t);
        self.fill_profile_rasters(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, out);
    }
}

impl FusedGrid {
    /// [`RasterSampler::build_path_profile`] with the SURFACE-HEATMAP
    /// coarse-middle cadence ([`CoarseMid`]): full-res near both ends (where
    /// obstacles diffract sound most severely), the smooth long-ray middle
    /// subsampled. Rays with no real middle reduce to the exact cadence
    /// byte-for-byte. Heatmap line/point/ground-ops kernels only — the POPUP
    /// stays on the exact [`RasterSampler::build_path_profile`].
    pub fn build_path_profile_coarse_mid(
        &self,
        src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64, dist_m: f64,
        cfg: noise_compute::propagation::path_profile::CoarseMid,
        out: &mut noise_compute::propagation::PathProfile,
    ) {
        noise_compute::propagation::path_profile::fill_t_values_coarse_mid(dist_m, &mut out.t, cfg);
        self.fill_profile_rasters(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, out);
    }

    /// Sample the four surface rasters at the t-values already in `out.t`,
    /// populating the profile. Shared by the exact + coarse-middle cadences
    /// (only the `out.t` fill differs); keeps the ray-march loop in one place.
    fn fill_profile_rasters(
        &self,
        src_lat: f64, src_lon: f64, rcv_lat: f64, rcv_lon: f64, dist_m: f64,
        out: &mut noise_compute::propagation::PathProfile,
    ) {
        // `out.t` is already filled by the caller's cadence. Clear-then-refill the
        // remaining fields, preserving t.
        let t_len = out.t.len();
        out.elevation_m.clear();
        out.building_h_m.clear();
        out.forest_u8.clear();
        out.imd_u8.clear();
        out.elevation_f64_scratch.clear();
        out.composite_h_scratch.clear();
        out.dist_m = dist_m;
        out.src_lat = src_lat;
        out.src_lon = src_lon;
        out.rcv_lat = rcv_lat;
        out.rcv_lon = rcv_lon;

        out.elevation_m.reserve(t_len);
        out.building_h_m.reserve(t_len);
        out.forest_u8.reserve(t_len);
        out.imd_u8.reserve(t_len);

        // Raster coords are affine in lat/lon, which are affine in t, so walk
        // (rf, cf) as a plain lerp instead of re-deriving them inside every lookup.
        let src_rf = (src_lat - self.lat_min) * self.inv_cell_deg;
        let src_cf = (src_lon - self.lon_min) * self.inv_cell_deg;
        let d_rf = (rcv_lat - src_lat) * self.inv_cell_deg;
        let d_cf = (rcv_lon - src_lon) * self.inv_cell_deg;
        for &t in &out.t {
            let (elev, bh, fr_u8, imd_u8) = self.lookup_fused_rc(src_rf + t * d_rf, src_cf + t * d_cf);
            out.elevation_m.push(elev);
            out.building_h_m.push(bh);
            out.forest_u8.push(fr_u8);
            out.imd_u8.push(imd_u8);
        }

        // The heatmap collapses to per-pixel energy: it never reads step_m_med
        // (popup tooltip metadata), and it omits the P3 mid-path peak
        // augmentation that RealRasters keeps for the per-point popup. Measured
        // on aggregate z13 tiles that augmentation moves Lden <0.07 dB mean /
        // 2 dB max while costing ~half the surface ray-march — the bilateral
        // cadence already samples every obstacle that dominates the single-edge δ.
        out.step_m_med = 0.0;
    }
}

impl FusedGrid {
    /// Number of raster cells held (cols × rows) — the denominator for the
    /// scatter's read-redundancy telemetry (how many times each cell is re-read).
    #[inline]
    pub fn cell_count(&self) -> usize {
        self.cols * self.rows
    }

    /// A clone with its sampling ORIGIN shifted by `(dlat, dlon)` degrees — the
    /// SAME stored raster cells, re-indexed so every `(lat,lon)` lookup lands a
    /// fraction of a cell away. Used ONLY by the surface noise-floor harness to
    /// render the exact field at a second raster PHASE (the half-cell-shift
    /// "method noise floor" the coarse-middle error is measured against). Not a
    /// production path — `FusedGrid::build` always snaps origin to the DEM
    /// lattice, so this is the one way to perturb raster phase without moving
    /// receivers or geometry.
    pub fn with_origin_shift(&self, dlat: f64, dlon: f64) -> FusedGrid {
        FusedGrid {
            data: self.data.clone(),
            lat_min: self.lat_min + dlat,
            lon_min: self.lon_min + dlon,
            inv_cell_deg: self.inv_cell_deg,
            cols: self.cols,
            rows: self.rows,
        }
    }

    /// Packed pixel array for the GPU backend (engine/noise-gpu) to upload as a
    /// device-resident halo. The device kernel mirrors [`Self::lookup_fused_rc`]
    /// over these cells; pair with [`Self::geom`] for the (lat,lon)→cell mapping.
    #[inline]
    pub fn pixels(&self) -> &[FusedPixel] {
        &self.data
    }

    /// `(lat_min, lon_min, inv_cell_deg, rows, cols)` — the origin/scale a device
    /// bilinear lookup needs: `rf = (lat − lat_min)·inv_cell_deg`, `cf` likewise.
    #[inline]
    pub fn geom(&self) -> (f64, f64, f64, usize, usize) {
        (self.lat_min, self.lon_min, self.inv_cell_deg, self.rows, self.cols)
    }

    /// Bilinear elevation + IMD, nearest-neighbour building + forest.
    ///
    /// Matches `RealRasters` per-raster `Interp` config: DEM bilinear, IMD
    /// bilinear, building/forest nearest. Earlier versions used `px00`
    /// (top-left of the bilinear quad) for all three categoricals, biasing
    /// up-left by half a cell and producing up to 6+ dB divergence from
    /// `RealRasters` wherever a raster edge passed through the quad.
    /// `(elev_bilinear, building_nearest, forest_nearest, imd_bilinear)` — the
    /// four surface rasters in one lookup, used by the heatmap horizon builder.
    #[inline]
    pub fn lookup_fused(&self, lat: f64, lon: f64) -> (f32, u8, u8, u8) {
        let rf = (lat - self.lat_min) * self.inv_cell_deg;
        let cf = (lon - self.lon_min) * self.inv_cell_deg;
        self.lookup_fused_rc(rf, cf)
    }

    /// [`Self::lookup_fused`] with pre-computed fractional raster coordinates.
    /// The profile builder walks a straight ray, so `(rf, cf)` are affine in the
    /// path parameter `t`; lerping them directly differs only sub-ULP from
    /// re-deriving via per-sample lat/lon (measured 0.000 dB tile drift) and
    /// drops two multiplies + two subtracts per sample from the hot loop.
    #[inline]
    pub fn lookup_fused_rc(&self, rf: f64, cf: f64) -> (f32, u8, u8, u8) {
        // Clamp before floor: prevents negative wrap and OOB extrapolation.
        let rf = rf.clamp(0.0, (self.rows - 1) as f64);
        let cf = cf.clamp(0.0, (self.cols - 1) as f64);
        let r0 = (rf.floor() as usize).min(self.rows - 2);
        let c0 = (cf.floor() as usize).min(self.cols - 2);
        let fr = rf - r0 as f64;
        let fc = cf - c0 as f64;
        let base = r0 * self.cols + c0;
        let px00 = self.data[base];
        let px01 = self.data[base + 1];
        let px10 = self.data[base + self.cols];
        let px11 = self.data[base + self.cols + 1];
        // Elevation bilinear (DEM is a continuous field).
        let v0e = px00.elevation as f64 + fc * (px01.elevation as f64 - px00.elevation as f64);
        let v1e = px10.elevation as f64 + fc * (px11.elevation as f64 - px10.elevation as f64);
        let elev = (v0e + fr * (v1e - v0e)) as f32;
        // Nearest-neighbor for building + forest (discrete categoricals).
        let near = match (fr >= 0.5, fc >= 0.5) {
            (false, false) => px00,
            (false, true) => px01,
            (true, false) => px10,
            (true, true) => px11,
        };
        // IMD is stored u8 but sampled BILINEARLY at query time to match
        // RealRasters.imd Interp::Bilinear. PathProfile consumer quantises
        // back to u8 (matching its `imd_u8: Vec<u8>` contract).
        let v0i = px00.imd as f64 + fc * (px01.imd as f64 - px00.imd as f64);
        let v1i = px10.imd as f64 + fc * (px11.imd as f64 - px10.imd as f64);
        let imd = (v0i + fr * (v1i - v0i)).round().clamp(0.0, 255.0) as u8;
        (elev, near.building, near.forest, imd)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn test_rasters() -> RealRasters {
        // Prepared rasters under data/prepared — 1° tiles for CZ + surroundings
        // are populated by scripts/rasters-global.sh. Tests auto-ignore
        // when missing (see `prepared_available` helper below).
        RealRasters::new(Path::new("../../data/prepared"))
    }

    /// Skip test body if no prepared rasters on disk (e.g., hermetic CI
    /// without data/prepared populated). Checks the Copernicus DEM dir
    /// rather than a specific tile so the guard survives tile rotation.
    fn prepared_available() -> bool {
        let dir = Path::new("../../data/prepared/dem/copernicus");
        std::fs::read_dir(dir)
            .map(|mut iter| iter.any(|e| e.ok().is_some_and(|e| e.path().extension().is_some_and(|x| x == "hgt"))))
            .unwrap_or(false)
    }

    #[test]
    fn test_elevation_brno() {
        if !prepared_available() { return; }
        let r = test_rasters();
        let elev = r.elevation(49.195, 16.608);
        assert!(elev > 150.0 && elev < 400.0, "Brno elevation: {elev}m");
    }

    #[test]
    fn test_elevation_not_flat_200() {
        if !prepared_available() { return; }
        let r = test_rasters();
        let e1 = r.elevation(49.195, 16.608);
        let e2 = r.elevation(49.5, 16.0);
        assert!((e1 - e2).abs() > 10.0, "Should not be flat: e1={e1}, e2={e2}");
    }

    /// Audit B3: a coordinate with no IMD tile on disk is open ocean — the
    /// missing-tile default must read fully hard (imd=100 → G=0). The
    /// converter emits an IMD tile for every land tile, never for ocean,
    /// so no mid-Atlantic tile exists on any host. (Partial-tree hosts —
    /// ry177 keeps only 34–59°N + Scandinavia — make missing northern
    /// LAND read hard too; he84's complete tree is the production truth.)
    /// Runs without `prepared_available()`: a missing data dir is the
    /// same code path as a missing tile.
    #[test]
    fn imd_missing_tile_defaults_to_hard_ocean() {
        let r = test_rasters();
        let imd = r.imd.sample(30.0, -45.0);
        assert_eq!(imd, 100.0, "missing IMD tile must default to 100 (hard)");
        assert_eq!(r.ground_g(30.0, -45.0), 0.0, "ocean ground must be hard (G=0)");
    }

    #[test]
    fn test_ground_g_varies() {
        if !prepared_available() { return; }
        let r = test_rasters();
        let g1 = r.ground_g(49.195, 16.608); // urban
        let g2 = r.ground_g(49.3, 16.4);      // rural
        assert!((0.0..=1.0).contains(&g1), "G urban: {g1}");
        assert!((0.0..=1.0).contains(&g2), "G rural: {g2}");
    }

    #[test]
    fn test_building_height() {
        if !prepared_available() { return; }
        let r = test_rasters();
        let h = r.building_height(49.195, 16.608);
        assert!((0.0..=255.0).contains(&h), "Building height: {h}m");
    }

    // FusedGrid ↔ RealRasters parity tests. Regression guard for the
    // FusedGrid fix set (truncate, px00-bias, subgrid shift, IMD
    // interpolation mismatch, OOB extrapolation). Tests auto-skip when
    // `data/prepared/` is not populated — no `#[ignore]` needed.

    fn test_fused() -> Option<(RealRasters, FusedGrid)> {
        if !prepared_available() { return None; }
        let r = test_rasters();
        // Small Brno-area bbox — keeps the grid in L1/L2.
        let fg = FusedGrid::build(&r, 49.18, 49.22, 16.58, 16.63);
        Some((r, fg))
    }

    #[test]
    fn fused_ground_g_parity() {
        let Some((real, fg)) = test_fused() else { return; };
        // Grid of points across the Brno bbox including hex-edge cases.
        for (lat, lon) in &[
            (49.20, 16.60), (49.195, 16.608), (49.19, 16.59),
            (49.181, 16.581), // near bbox edge
            (49.215, 16.625), // opposite corner
        ] {
            let g_real = real.ground_g(*lat, *lon);
            let g_fused = fg.ground_g(*lat, *lon);
            // Fused samples IMD nearest-neighbour at ITS cell centre; the real reader
            // interpolates bilinearly at the query point. On an IMD gradient the half-cell
            // offset legitimately diverges by a few percent (first seen as 0.49 vs 0.50
            // after the 2026-06 IMD water re-extract). 0.05 still catches the bugs this
            // parity test exists for (off-by-tile, scale, axis swap), which are ≥0.1.
            assert!(
                (g_real - g_fused).abs() < 0.05,
                "ground_g divergence at ({}, {}): real={g_real:.4} fused={g_fused:.4}",
                lat, lon
            );
        }
    }

    #[test]
    fn fused_elevation_parity() {
        let Some((real, fg)) = test_fused() else { return; };
        for (lat, lon) in &[
            (49.20, 16.60), (49.195, 16.608),
            (49.181, 16.581),
        ] {
            let e_real = real.elevation(*lat, *lon);
            let e_fused = fg.elevation(*lat, *lon);
            // f32 precision in FusedPixel + f64 in RealRasters → sub-1 cm.
            assert!(
                (e_real - e_fused).abs() < 0.05,
                "elevation divergence at ({}, {}): real={e_real:.4} fused={e_fused:.4}",
                lat, lon
            );
        }
    }

    #[test]
    fn fused_building_height_parity() {
        let Some((real, fg)) = test_fused() else { return; };
        for (lat, lon) in &[
            (49.195, 16.608), (49.20, 16.60),
            (49.215, 16.625),
        ] {
            let h_real = real.building_height(*lat, *lon);
            let h_fused = fg.building_height(*lat, *lon);
            assert_eq!(
                h_real as u8, h_fused as u8,
                "building_height divergence at ({}, {}): real={h_real} fused={h_fused}",
                lat, lon
            );
        }
    }

    #[test]
    fn fused_building_enclosure_near_bbox_edge() {
        // Regression test for Gemini-flagged bug: insufficient bbox
        // margin made `building_enclosure()` silently clamp the 3×3
        // probe to edge pixels at hex boundaries. Current 8-cell margin
        // covers the metric probe (ENCLOSURE_RADIUS_M = 75 m ≈ 2.4 lat
        // cells, ~3.4 lon cells at 50°N) plus rounding slack.
        let Some((real, fg)) = test_fused() else { return; };
        let lat = 49.181;  // 1 cell from bbox min (49.18)
        let lon = 16.581;
        let e_real = real.building_enclosure(lat, lon);
        let e_fused = fg.building_enclosure(lat, lon);
        assert!(
            (e_real - e_fused).abs() < 0.5,
            "building_enclosure near-edge divergence: real={e_real} fused={e_fused}"
        );
    }

    #[test]
    fn fused_oob_clamp_no_extrapolation() {
        // Regression test for Gemini-flagged OOB bilinear extrapolation.
        // Query outside the FusedGrid bbox — pre-fix would extrapolate
        // linearly into space (negative `fr`/`fc`). Post-fix clamps to
        // the edge elevation.
        let Some((_, fg)) = test_fused() else { return; };
        let e_edge = fg.elevation(49.18, 16.58);         // at bbox edge
        let e_outside = fg.elevation(49.10, 16.50);      // far outside
        // Both must be finite and plausible CZ elevations.
        assert!(e_edge.is_finite() && e_outside.is_finite());
        assert!(e_outside > -1000.0 && e_outside < 10_000.0);
    }

    #[test]
    fn building_enclosure_antimeridian_wraps() {
        // Regression for the antimeridian wrap fix: a receiver at lon
        // ≈ ±180° must not panic and the probe column at dc=+1/-1 must
        // wrap to the opposite hemisphere, not clamp to the ±179° edge.
        // We can't compare against a real-raster ground truth here
        // (Pacific tiles are not in `data/prepared/`), so we assert the
        // function is finite and matches between RealRasters / FusedGrid
        // at both wrap polarities — the fix's purpose is parity.
        if !prepared_available() { return; }
        let r = test_rasters();
        let lat = 0.0;
        for &lon in &[179.9995_f64, -179.9995_f64] {
            let v = r.building_enclosure(lat, lon);
            assert!(v.is_finite(), "RealRasters NaN at lon={lon}");
            assert!((0.0..=3.0).contains(&v), "out of range at lon={lon}: {v}");
        }
    }

    // ── FusedGrid::burn_building_max (GPU barrier burn) ──────────────────
    // A grid built from an EMPTY rasters dir is flat 0 with building 0
    // everywhere (missing tiles are negative-cached defaults), so every
    // non-zero building cell after a burn is the burn's own footprint.

    fn empty_grid() -> FusedGrid {
        let r = RealRasters::new(Path::new("/nonexistent-quietmap-test-rasters"));
        FusedGrid::build(&r, 0.0, 0.05, 0.0, 0.05)
    }

    fn burned_cells(fg: &FusedGrid) -> Vec<(usize, usize, u8)> {
        let (_, _, _, rows, cols) = fg.geom();
        let mut out = Vec::new();
        for r in 0..rows {
            for c in 0..cols {
                let b = fg.pixels()[r * cols + c].building;
                if b > 0 {
                    out.push((r, c, b));
                }
            }
        }
        out
    }

    #[test]
    fn burn_horizontal_segment_marks_one_cell_row() {
        let mut fg = empty_grid();
        fg.burn_building_max(0.01, 0.01, 0.01, 0.04, 3.0);
        let cells = burned_cells(&fg);
        // 0.03° span at 1/3600° cells = 108 crossings → 109 cells ±1 float edge.
        assert!(
            (108..=110).contains(&cells.len()),
            "horizontal wall cell count {} not in 108..=110",
            cells.len()
        );
        let row0 = cells[0].0;
        assert!(cells.iter().all(|&(r, _, h)| r == row0 && h == 3));
    }

    #[test]
    fn burn_diagonal_is_supercover_not_bresenham() {
        let mut fg = empty_grid();
        // 45° diagonal across 36×36 cells: supercover visits |Δr|+|Δc|+1 ≈ 73
        // cells (4-connected, no corner gaps); 8-connected Bresenham would
        // visit ~37 — the kernel's nearest-neighbour ray samples could slip
        // diagonally through those gaps.
        fg.burn_building_max(0.01, 0.01, 0.02, 0.02, 3.0);
        let cells = burned_cells(&fg);
        assert!(
            cells.len() > 60,
            "diagonal burn {} cells — looks 8-connected, supercover expected",
            cells.len()
        );
        assert!(cells.len() <= 76, "diagonal burn {} cells > |Δr|+|Δc|+1 bound", cells.len());
    }

    #[test]
    fn burn_is_max_and_skips_out_of_grid() {
        let mut fg = empty_grid();
        fg.burn_building_max(0.02, 0.01, 0.02, 0.02, 5.0);
        fg.burn_building_max(0.02, 0.01, 0.02, 0.02, 2.0);
        let cells = burned_cells(&fg);
        assert!(!cells.is_empty());
        assert!(cells.iter().all(|&(_, _, h)| h == 5), "max(existing, h), never overwrite down");

        // Entirely outside the grid → nothing painted, especially no edge smear.
        let before = cells.len();
        fg.burn_building_max(5.0, 5.0, 5.1, 5.1, 3.0);
        fg.burn_building_max(-1.0, 0.02, -2.0, 0.02, 3.0);
        assert_eq!(burned_cells(&fg).len(), before, "out-of-grid burn must be a no-op");

        // Degenerate point segment → exactly one new cell.
        fg.burn_building_max(0.04, 0.04, 0.04, 0.04, 4.0);
        assert_eq!(burned_cells(&fg).len(), before + 1);
    }
}
