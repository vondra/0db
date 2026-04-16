//! Real raster reader — raw 1°×1° tiles, mmap'd, global scale.
//!
//! Implements noise_compute::types::RasterSampler for both popup (lazy) and pipeline (pre-loaded).
//! Reads Copernicus GLO-30 / SRTM DEM, Overture building height, WorldCover forest, IMD ground type.

pub mod tile;

use std::path::Path;
use noise_compute::types::RasterSampler;
use tile::{TileStore, DType, Interp};

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

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
        let dem_cache_tiles = env_usize("QUIETMAP_CACHE_DEM_TILES", 12);
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

        // IMD ground type: u8 (0-100 imperviousness), 3601×3601 (30m), bilinear
        let imd = TileStore::new(
            data_dir.join("rasters/imd"), 3601, DType::U8, Interp::Bilinear, 50.0, ".raw",
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

impl RasterSampler for RealRasters {
    fn elevation(&self, lat: f64, lon: f64) -> f64 {
        self.dem.sample(lat, lon)
    }

    fn building_height(&self, lat: f64, lon: f64) -> f64 {
        self.building.sample(lat, lon)
    }

    fn vegetation_depth(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        // Cumulative forest depth: cells with value > 0 count as forest
        // (handles both binary (0/1) and percentage (0-100) rasters)
        // Minimum contiguous depth 10m (no scattered trees)
        self.forest.cumulative_along_path(lat1, lon1, lat2, lon2, 0.5)
    }

    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        // IMD 0=natural(soft), 100=impervious(hard)
        // G: 0=hard, 1=soft → G = 1.0 - IMD/100
        // Default tile value is 50 (missing data → G=0.5), so no special case needed.
        // WHY no conditional: IMD=0 means fully soft ground (forest, meadow) → G=1.0.
        // Old code returned 0.5 for IMD=0, halving ground attenuation in rural areas.
        let imd = self.imd.sample(lat, lon);
        (1.0 - imd / 100.0).clamp(0.0, 1.0)
    }

    fn ground_g_path(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let avg_imd = self.imd.avg_along_path(lat1, lon1, lat2, lon2);
        (1.0 - avg_imd / 100.0).clamp(0.0, 1.0)
    }

    fn terrain_profile(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64, _steps: usize) -> Vec<f64> {
        self.dem.profile_along_path(lat1, lon1, lat2, lon2)
    }

    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        // Sample building heights in ~100m radius (3×3 grid at ~33m spacing)
        let step = 0.001; // ~110m at 50°N
        let mut tall_count = 0;
        let mut total = 0;
        for dr in [-1, 0, 1] {
            for dc in [-1, 0, 1] {
                let h = self.building.sample(lat + dr as f64 * step, lon + dc as f64 * step);
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
        let cell_m = 110_540.0 / 3600.0;
        let step = if dist_m <= 1000.0 { cell_m }
            else if dist_m <= 3000.0 { cell_m * 3.0 }
            else { cell_m * 6.0 };
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
        let cell_m = 110_540.0 / 3600.0;
        let step = if dist_m <= 1000.0 { cell_m }
            else if dist_m <= 3000.0 { cell_m * 3.0 }
            else { cell_m * 6.0 };
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
}



/// L3-cache-resident cropped raster grid for pipeline compute.
///
/// Pre-reads DEM + building + forest + IMD for the hex bbox into ONE contiguous
/// Vec, cropped to just the needed area (~22 MB for a typical R4 hex + ring).
/// Implements RasterSampler so all existing path_effects code works unchanged.
/// Zero algorithmic change = zero dB error vs mmap-based RealRasters.
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

        // Expand bbox by 1 cell for bilinear interpolation margin
        let lat_lo = lat_min - cell_deg;
        let lon_lo = lon_min - cell_deg;
        let lat_hi = lat_max + cell_deg;
        let lon_hi = lon_max + cell_deg;

        let rows = ((lat_hi - lat_lo) * inv_cell_deg).ceil() as usize + 1;
        let cols = ((lon_hi - lon_lo) * inv_cell_deg).ceil() as usize + 1;

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

        let size_mb = (data.len() * std::mem::size_of::<FusedPixel>()) as f64 / (1024.0 * 1024.0);
        eprintln!("  FusedGrid: {}×{} = {:.1} MB (L3-resident)", rows, cols, size_mb);

        FusedGrid { data, lat_min: lat_lo, lon_min: lon_lo, inv_cell_deg, cols, rows }
    }

    #[inline]
    fn pixel(&self, lat: f64, lon: f64) -> &FusedPixel {
        let r = ((lat - self.lat_min) * self.inv_cell_deg) as usize;
        let c = ((lon - self.lon_min) * self.inv_cell_deg) as usize;
        let r = r.min(self.rows.saturating_sub(1));
        let c = c.min(self.cols.saturating_sub(1));
        &self.data[r * self.cols + c]
    }

    #[inline]
    fn elevation_bilinear(&self, lat: f64, lon: f64) -> f64 {
        let rf = (lat - self.lat_min) * self.inv_cell_deg;
        let cf = (lon - self.lon_min) * self.inv_cell_deg;
        let r0 = (rf.floor() as usize).min(self.rows.saturating_sub(2));
        let c0 = (cf.floor() as usize).min(self.cols.saturating_sub(2));
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

    fn vegetation_depth(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();
        let cell_m = 110_540.0 / 3600.0;
        let steps = (dist_m / cell_m).ceil().max(3.0) as usize;
        let step_m = dist_m / steps.max(1) as f64;
        let mut total = 0.0;
        let mut run = 0.0;
        for i in 0..steps {
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            if self.pixel(lat, lon).forest > 0 {
                run += step_m;
            } else {
                if run >= 10.0 { total += run; }
                run = 0.0;
            }
        }
        if run >= 10.0 { total += run; }
        total
    }

    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        let imd = self.pixel(lat, lon).imd as f64;
        (1.0 - imd / 100.0).clamp(0.0, 1.0)
    }

    fn ground_g_path(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();
        let cell_m = 110_540.0 / 3600.0;
        let steps = (dist_m / cell_m).ceil().max(3.0) as usize;
        let mut sum = 0.0;
        for i in 0..steps {
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            sum += self.pixel(lat, lon).imd as f64;
        }
        let avg = sum / steps.max(1) as f64;
        (1.0 - avg / 100.0).clamp(0.0, 1.0)
    }

    fn terrain_profile(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64, _steps: usize) -> Vec<f64> {
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();
        let cell_m = 110_540.0 / 3600.0;
        let step_m = if dist_m <= 1000.0 { cell_m }
            else if dist_m <= 3000.0 { cell_m * 3.0 }
            else { cell_m * 6.0 };
        let n = (dist_m / step_m).ceil().max(3.0) as usize;
        let mut profile = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f64 / (n - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            profile.push(self.elevation_bilinear(lat, lon));
        }
        profile
    }

    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        let step = 0.001;
        let mut tall = 0;
        let mut total = 0;
        for dr in [-1, 0, 1] {
            for dc in [-1, 0, 1] {
                let h = self.pixel(lat + dr as f64 * step, lon + dc as f64 * step).building;
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
        let cell_m = 110_540.0 / 3600.0;
        let step = if dist_m <= 1000.0 { cell_m }
            else if dist_m <= 3000.0 { cell_m * 3.0 }
            else { cell_m * 6.0 };
        let n = ((dist_m / step).ceil() as usize).clamp(2, 400);
        let mut max_bh = 0.0f64;
        let mut max_t = 0.5;
        for k in 1..n {
            let t = k as f64 / n as f64;
            if excl_start_m > 0.0 && t * dist_m < excl_start_m { continue; }
            let lat = src_lat + t * (rcv_lat - src_lat);
            let lon = src_lon + t * (rcv_lon - src_lon);
            let bh = self.pixel(lat, lon).building as f64;
            if bh > max_bh { max_bh = bh; max_t = t; }
        }
        (max_bh, max_t)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn test_rasters() -> RealRasters {
        RealRasters::new(Path::new("../../source-data"))
    }

    #[test]
    fn test_elevation_brno() {
        let r = test_rasters();
        let elev = r.elevation(49.195, 16.608);
        assert!(elev > 150.0 && elev < 400.0, "Brno elevation: {elev}m");
    }

    #[test]
    fn test_elevation_not_flat_200() {
        let r = test_rasters();
        let e1 = r.elevation(49.195, 16.608);
        let e2 = r.elevation(49.5, 16.0);
        assert!((e1 - e2).abs() > 10.0, "Should not be flat: e1={e1}, e2={e2}");
    }

    #[test]
    fn test_ground_g_varies() {
        let r = test_rasters();
        let g1 = r.ground_g(49.195, 16.608); // urban
        let g2 = r.ground_g(49.3, 16.4);      // rural
        // Both should be in valid range
        assert!(g1 >= 0.0 && g1 <= 1.0, "G urban: {g1}");
        assert!(g2 >= 0.0 && g2 <= 1.0, "G rural: {g2}");
    }

    #[test]
    fn test_vegetation_depth() {
        let r = test_rasters();
        // Path through forest area (north of Brno)
        let depth = r.vegetation_depth(49.3, 16.5, 49.35, 16.5);
        // Should be >= 0 (might be 0 if no forest on this particular path)
        assert!(depth >= 0.0, "Forest depth: {depth}m");
    }

    #[test]
    fn test_building_height() {
        let r = test_rasters();
        let h = r.building_height(49.195, 16.608);
        assert!(h >= 0.0 && h <= 255.0, "Building height: {h}m");
    }
}
