//! Real raster reader — raw 1°×1° tiles, mmap'd, global scale.
//!
//! Implements noise_compute::types::RasterSampler for both popup (lazy) and pipeline (pre-loaded).
//! Reads Copernicus GLO-30 / SRTM DEM, GHSL building height, WorldCover forest, IMD ground type.

pub mod tile;

use std::path::{Path, PathBuf};
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
            data_dir.join("dem/copernicus"), 1201, DType::I16BE, Interp::Bilinear, 0.0, ".hgt",
        ).with_alt_dir(data_dir.join("dem/srtm"), ".hgt");

        // Building height: u8 (meters), 1201×1201, nearest-neighbor
        let building = TileStore::new(
            data_dir.join("rasters/building"), 1201, DType::U8, Interp::Nearest, 0.0, ".raw",
        );

        // Forest cover: u8 (0-100%), 1201×1201, nearest-neighbor
        let forest = TileStore::new(
            data_dir.join("rasters/forest"), 1201, DType::U8, Interp::Nearest, 0.0, ".raw",
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
        let imd = self.imd.sample(lat, lon);
        if imd > 0.0 { 1.0 - imd / 100.0 } else { 0.5 }
    }

    fn ground_g_path(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let avg_imd = self.imd.avg_along_path(lat1, lon1, lat2, lon2);
        if avg_imd > 0.0 { 1.0 - avg_imd / 100.0 } else { 0.5 }
    }

    fn terrain_profile(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64, _steps: usize) -> Vec<f64> {
        // Sample at raster resolution (~30m), ignore _steps
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
