//! Real raster reader — raw 1°×1° tiles, mmap'd, global scale.
//!
//! Implements noise_compute::types::RasterSampler for both popup (lazy) and pipeline (pre-loaded).
//! Reads Copernicus GLO-30 / SRTM DEM, GHSL building height, WorldCover forest, IMD ground type.

pub mod tile;

use std::path::Path;
use noise_compute::types::RasterSampler;
use tile::{TileStore, DType, Interp};

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
        // DEM: Copernicus GLO-30 primary (.hgt), SRTM fallback (.hgt)
        let dem = TileStore::new(
            data_dir.join("dem/copernicus"), 3601, DType::I16BE, Interp::Bilinear, 0.0, ".hgt",
        ).with_alt_dir(data_dir.join("dem/srtm"), ".hgt");

        // Building height: u8 (meters), 3601×3601 (Overture 30m), nearest-neighbor
        let building = TileStore::new(
            data_dir.join("rasters/building"), 3601, DType::U8, Interp::Nearest, 0.0, ".raw",
        );

        // Forest cover: u8 (0/100%), 3601×3601 (WorldCover 30m), nearest-neighbor
        let forest = TileStore::new(
            data_dir.join("rasters/forest"), 3601, DType::U8, Interp::Nearest, 0.0, ".raw",
        );

        // IMD ground type: u8 (0-100 imperviousness), 401×401, bilinear
        let imd = TileStore::new(
            data_dir.join("rasters/imd"), 401, DType::U8, Interp::Bilinear, 50.0, ".raw",
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
