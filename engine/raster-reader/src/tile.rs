//! Generic raw 1°×1° raster tile reader.
//!
//! Mmap'd on demand (lazy) or pre-loaded for pipeline.
//! Thread-safe: mmap is read-only, DashMap for lazy tile cache.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use memmap2::Mmap;

/// Data type of raw tile pixels.
#[derive(Debug, Clone, Copy)]
pub enum DType {
    /// Unsigned 8-bit (building height, forest cover, IMD)
    U8,
    /// Signed 16-bit big-endian (SRTM .hgt elevation)
    I16BE,
}

/// Interpolation method for sampling.
#[derive(Debug, Clone, Copy)]
pub enum Interp {
    /// Bilinear — smooth, for continuous fields (DEM, IMD)
    Bilinear,
    /// Nearest-neighbor — sharp, for discrete features (buildings, forest)
    Nearest,
}

/// One mmap'd 1°×1° tile.
pub(crate) struct RawTile {
    mmap: Mmap,
    grid_size: u32,
    dtype: DType,
}

impl RawTile {
    fn load(path: &Path, _expected_grid: u32, dtype: DType) -> Option<Self> {
        let file = File::open(path).ok()?;
        let mmap = unsafe { Mmap::map(&file).ok()? };

        // Auto-detect grid size from file size (handles both SRTM 1-arcsec and 3-arcsec)
        let bytes_per_pixel = match dtype {
            DType::U8 => 1,
            DType::I16BE => 2,
        };
        let n_pixels = mmap.len() / bytes_per_pixel;
        let grid_size = (n_pixels as f64).sqrt() as u32;

        // Verify it's a square grid
        if (grid_size as usize) * (grid_size as usize) * bytes_per_pixel != mmap.len() {
            return None;
        }

        Some(RawTile { mmap, grid_size, dtype })
    }

    /// Read raw pixel value at (row, col). Row 0 = north edge.
    #[inline]
    fn read_pixel(&self, row: u32, col: u32) -> f64 {
        let r = row.min(self.grid_size - 1);
        let c = col.min(self.grid_size - 1);
        let idx = (r as usize) * (self.grid_size as usize) + (c as usize);

        match self.dtype {
            DType::U8 => self.mmap[idx] as f64,
            DType::I16BE => {
                let off = idx * 2;
                let val = i16::from_be_bytes([self.mmap[off], self.mmap[off + 1]]);
                // SRTM void = -32768 → return 0
                if val == -32768 { 0.0 } else { val as f64 }
            }
        }
    }

    /// Bilinear interpolation within this tile.
    fn sample_bilinear(&self, frac_row: f64, frac_col: f64) -> f64 {
        let max = (self.grid_size - 1) as f64;
        let r = frac_row.clamp(0.0, max);
        let c = frac_col.clamp(0.0, max);

        let r0 = r.floor() as u32;
        let c0 = c.floor() as u32;
        let r1 = (r0 + 1).min(self.grid_size - 1);
        let c1 = (c0 + 1).min(self.grid_size - 1);

        let fr = r - r0 as f64;
        let fc = c - c0 as f64;

        let v00 = self.read_pixel(r0, c0);
        let v01 = self.read_pixel(r0, c1);
        let v10 = self.read_pixel(r1, c0);
        let v11 = self.read_pixel(r1, c1);

        // Skip void neighbors (SRTM)
        if v00 == 0.0 && v01 == 0.0 && v10 == 0.0 && v11 == 0.0 { return 0.0; }

        let v0 = v00 + fc * (v01 - v00);
        let v1 = v10 + fc * (v11 - v10);
        v0 + fr * (v1 - v0)
    }

    /// Nearest-neighbor sampling within this tile.
    fn sample_nearest(&self, frac_row: f64, frac_col: f64) -> f64 {
        let max = (self.grid_size - 1) as f64;
        let r = frac_row.clamp(0.0, max).round() as u32;
        let c = frac_col.clamp(0.0, max).round() as u32;
        self.read_pixel(r, c)
    }
}

/// Collection of tiles for one raster type. Thread-safe, lazy-loading.
/// 180 lat × 360 lon = 64,800 slots. OnceLock = wait-free after first init.
const TILE_SLOTS: usize = 180 * 360;

pub struct TileStore {
    dir: PathBuf,
    alt_dir: Option<PathBuf>,
    grid_size: u32,
    dtype: DType,
    interp: Interp,
    default_value: f64,
    extension: &'static str,
    alt_extension: Option<&'static str>,
    tiles: Vec<OnceLock<Option<RawTile>>>,  // flat array, lock-free (no Arc — TileStore owns tiles)
}

impl TileStore {
    pub fn new(
        dir: PathBuf, grid_size: u32, dtype: DType, interp: Interp,
        default_value: f64, extension: &'static str,
    ) -> Self {
        let mut tiles = Vec::with_capacity(TILE_SLOTS);
        for _ in 0..TILE_SLOTS { tiles.push(OnceLock::new()); }
        TileStore {
            dir, alt_dir: None, grid_size, dtype, interp,
            default_value, extension, alt_extension: None,
            tiles,
        }
    }

    /// Pre-load all tiles covering a lat/lon bounding box.
    /// After this call, all sample() calls within the bbox hit cache — no lock contention.
    pub fn preload_bbox(&self, lat_min: f64, lat_max: f64, lon_min: f64, lon_max: f64) {
        let lat0 = lat_min.floor() as i32;
        let lat1 = lat_max.floor() as i32;
        let lon0 = lon_min.floor() as i32;
        let lon1 = lon_max.floor() as i32;
        for lat in lat0..=lat1 {
            for lon in lon0..=lon1 {
                self.get_tile(lat, lon); // loads + caches
            }
        }
    }

    /// Set fallback directory (for SRTM: try .raw first, then .hgt)
    pub fn with_alt_dir(mut self, dir: PathBuf, ext: &'static str) -> Self {
        self.alt_dir = Some(dir);
        self.alt_extension = Some(ext);
        self
    }

    /// Flat index into tile array: (lat+90)*360 + (lon+180)
    #[inline]
    fn tile_idx(lat_int: i32, lon_int: i32) -> usize {
        let lat = (lat_int + 90).clamp(0, 179) as usize;
        let lon = (lon_int + 180).clamp(0, 359) as usize;
        lat * 360 + lon
    }

    /// Get or load a tile. Lock-free after first access (OnceLock).
    fn get_tile(&self, lat_int: i32, lon_int: i32) -> Option<&RawTile> {
        let idx = Self::tile_idx(lat_int, lon_int);

        self.tiles[idx].get_or_init(|| {
            let ns = if lat_int >= 0 { 'N' } else { 'S' };
            let ew = if lon_int >= 0 { 'E' } else { 'W' };
            let base = format!("{}{:02}{}{:03}", ns, lat_int.unsigned_abs(), ew, lon_int.unsigned_abs());

            let primary = self.dir.join(format!("{}{}", base, self.extension));
            let tile = if primary.exists() {
                RawTile::load(&primary, self.grid_size, self.dtype)
            } else if let (Some(alt_dir), Some(alt_ext)) = (&self.alt_dir, self.alt_extension) {
                let alt = alt_dir.join(format!("{}{}", base, alt_ext));
                if alt.exists() { RawTile::load(&alt, self.grid_size, self.dtype) }
                else { None }
            } else { None };

            tile
        }).as_ref()
    }

    /// Convert (lat, lon) to tile key.
    #[inline]
    fn to_tile_key(lat: f64, lon: f64) -> (i32, i32, f64, f64) {
        let lat_int = lat.floor() as i32;
        let lon_int = lon.floor() as i32;
        let frac_lat = lat - lat_int as f64;  // 0..1 within tile
        let frac_lon = lon - lon_int as f64;
        (lat_int, lon_int, frac_lat, frac_lon)
    }

    /// Convert frac (0..1) to pixel coords using tile's actual grid_size.
    #[inline]
    fn frac_to_pixel(frac_lat: f64, frac_lon: f64, grid_size: u32) -> (f64, f64) {
        let max = (grid_size - 1) as f64;
        // Row: north-to-south → row 0 = north = frac_lat=1.0
        ((1.0 - frac_lat) * max, frac_lon * max)
    }

    /// Fast tile lookup for pre-loaded tiles (skips init path).
    #[inline]
    fn get_tile_fast(&self, lat_int: i32, lon_int: i32) -> Option<&RawTile> {
        let idx = Self::tile_idx(lat_int, lon_int);
        self.tiles[idx].get().and_then(|t| t.as_ref())
    }

    /// Sample at (frac_row, frac_col) within a tile, using this store's interpolation mode.
    #[inline]
    fn sample_tile(&self, tile: &RawTile, frac_lat: f64, frac_lon: f64) -> f64 {
        let (frac_row, frac_col) = Self::frac_to_pixel(frac_lat, frac_lon, tile.grid_size);
        match self.interp {
            Interp::Bilinear => tile.sample_bilinear(frac_row, frac_col),
            Interp::Nearest => tile.sample_nearest(frac_row, frac_col),
        }
    }

    /// Sample raster value at (lat, lon).
    pub fn sample(&self, lat: f64, lon: f64) -> f64 {
        let (lat_int, lon_int, frac_lat, frac_lon) = Self::to_tile_key(lat, lon);

        match self.get_tile_fast(lat_int, lon_int) {
            Some(tile) => self.sample_tile(tile, frac_lat, frac_lon),
            None => {
                // Fallback: try full get_tile (handles lazy loading for popup)
                match self.get_tile(lat_int, lon_int) {
                    Some(tile) => self.sample_tile(tile, frac_lat, frac_lon),
                    None => self.default_value,
                }
            }
        }
    }

    /// Sample with tile caching — avoids repeated OnceLock lookups when consecutive
    /// samples fall within the same 1° tile (common for path sampling).
    #[inline]
    /// Sample with tile caching — avoids repeated OnceLock lookups when consecutive
    /// samples fall within the same 1° tile.
    pub(crate) fn sample_cached<'a>(&'a self, lat: f64, lon: f64, cached_key: &mut (i32, i32), cached_tile: &mut Option<&'a RawTile>) -> f64 {
        let (lat_int, lon_int, frac_lat, frac_lon) = Self::to_tile_key(lat, lon);
        let tile = if (lat_int, lon_int) == *cached_key {
            *cached_tile
        } else {
            *cached_key = (lat_int, lon_int);
            let t = self.get_tile_fast(lat_int, lon_int);
            *cached_tile = t;
            t
        };
        match tile {
            Some(t) => self.sample_tile(t, frac_lat, frac_lon),
            None => self.default_value,
        }
    }

    /// Sample along path, return profile of values at raster resolution.
    pub fn profile_along_path(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> Vec<f64> {
        let cos_lat = ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * cos_lat;
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();

        // Adaptive resolution: full at <1km, 3× coarser 1-3km, 6× coarser >3km.
        // Major terrain features (100m+ wide) detected at all distances.
        let cell_m = 110_540.0 / (self.grid_size - 1) as f64;
        let step_m = if dist_m <= 1000.0 { cell_m }
            else if dist_m <= 3000.0 { cell_m * 3.0 }
            else { cell_m * 6.0 };
        let steps = (dist_m / step_m).ceil().max(3.0) as usize;

        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile: Option<&RawTile> = None;
        let mut profile = Vec::with_capacity(steps);
        for i in 0..steps {
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            profile.push(self.sample_cached(lat, lon, &mut cached_key, &mut cached_tile));
        }
        profile
    }

    /// Maximum value along path + its position (for building screening).
    /// Returns (max_value, distance_from_start_m, distance_to_end_m).
    pub fn max_along_path_with_pos(
        &self, lat1: f64, lon1: f64, lat2: f64, lon2: f64, total_dist_m: f64,
    ) -> (f64, f64, f64) {
        let cell_m = 110_540.0 / (self.grid_size - 1) as f64;
        let steps = (total_dist_m / cell_m).ceil().max(3.0) as usize;

        let mut max_val = 0.0f64;
        let mut max_t = 0.5;
        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile: Option<&RawTile> = None;

        for i in 1..steps - 1 {  // skip source and receiver positions
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            let v = self.sample_cached(lat, lon, &mut cached_key, &mut cached_tile);
            if v > max_val {
                max_val = v;
                max_t = t;
            }
        }

        (max_val, max_t * total_dist_m, (1.0 - max_t) * total_dist_m)
    }

    /// Cumulative distance through cells above threshold (for forest depth).
    /// Requires minimum contiguous depth of 10m.
    pub fn cumulative_along_path(
        &self, lat1: f64, lon1: f64, lat2: f64, lon2: f64, threshold: f64,
    ) -> f64 {
        let cos_lat = ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * cos_lat;
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();

        let cell_m = 110_540.0 / (self.grid_size - 1) as f64;
        let steps = (dist_m / cell_m).ceil().max(3.0) as usize;
        let step_m = dist_m / steps.max(1) as f64;

        let mut total_depth = 0.0;
        let mut contiguous_depth = 0.0;
        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile: Option<&RawTile> = None;

        for i in 0..steps {
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            let v = self.sample_cached(lat, lon, &mut cached_key, &mut cached_tile);

            if v > threshold {
                contiguous_depth += step_m;
            } else {
                // Only count contiguous sections >= 10m
                if contiguous_depth >= 10.0 {
                    total_depth += contiguous_depth;
                }
                contiguous_depth = 0.0;
            }
        }
        // Don't forget last section
        if contiguous_depth >= 10.0 {
            total_depth += contiguous_depth;
        }

        total_depth
    }

    /// Average value along path (for ground G from IMD).
    pub fn avg_along_path(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let cos_lat = ((lat1 + lat2) / 2.0).to_radians().cos().max(0.1);
        let dlat = (lat2 - lat1) * 110_540.0;
        let dlon = (lon2 - lon1) * 111_320.0 * cos_lat;
        let dist_m = (dlat * dlat + dlon * dlon).sqrt();

        let cell_m = 110_540.0 / (self.grid_size - 1) as f64;
        let steps = (dist_m / cell_m).ceil().max(3.0) as usize;

        let mut sum = 0.0;
        let mut cached_key = (i32::MIN, i32::MIN);
        let mut cached_tile: Option<&RawTile> = None;
        for i in 0..steps {
            let t = i as f64 / (steps - 1).max(1) as f64;
            let lat = lat1 + t * (lat2 - lat1);
            let lon = lon1 + t * (lon2 - lon1);
            sum += self.sample_cached(lat, lon, &mut cached_key, &mut cached_tile);
        }
        sum / steps as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_srtm_brno() {
        // Real SRTM tile for Brno area
        let store = TileStore::new(
            PathBuf::from("../../source-data/dem/srtm"),
            1201, DType::I16BE, Interp::Bilinear, 0.0, ".hgt",
        );
        // Brno center: ~200-250m elevation
        let elev = store.sample(49.195, 16.608);
        assert!(elev > 150.0 && elev < 400.0, "Brno elevation: {elev}m");

        // Somewhere in the mountains (Vysočina): should be higher
        let elev2 = store.sample(49.5, 16.0);
        assert!(elev2 > 300.0 && elev2 < 800.0, "Vysočina elevation: {elev2}m");
    }

    #[test]
    fn test_building_brno() {
        let store = TileStore::new(
            PathBuf::from("../../source-data/rasters/building"),
            1201, DType::U8, Interp::Nearest, 0.0, ".raw",
        );
        // Sample in Brno center — should find some buildings
        let h = store.sample(49.195, 16.608);
        // Could be 0 (street) or >0 (building) — just verify no crash
        assert!(h >= 0.0 && h <= 255.0, "Building height: {h}m");
    }

    #[test]
    fn test_missing_tile() {
        let store = TileStore::new(
            PathBuf::from("/nonexistent"),
            1201, DType::U8, Interp::Nearest, 42.0, ".raw",
        );
        assert_eq!(store.sample(49.0, 16.0), 42.0);
    }
}
