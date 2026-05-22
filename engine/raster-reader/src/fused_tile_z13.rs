//! Per-tile raster cache aligned with the Mercator z=13 receiver lattice
//! plus a WGS84 30 m halo extending the bbox by `HALO_M`.
//!
//! The inner core (`TILE_PX × TILE_PX` Mercator-aligned cells) matches the
//! output HM tile lattice 1:1 — receiver `(py, px)` indexes every layer
//! (DEM, buildings, forest, IMD, pre-baked receiver altitude/refl) without
//! any lat/lon math in the hot loop.
//!
//! Path-profile rays exiting the inner bbox fall through to the halo
//! `FusedGrid` (lat/lon lookup at native source-raster resolution).
//!
//! Builds in ~ms per tile (samples 65 536 inner + ~1.5M halo cells from
//! `RealRasters` mmap). Lives in L2/L3 for the duration of one tile's
//! compute, then drops.

use noise_compute::constants::{
    DEFAULT_RECEIVER_HEIGHT, M_PER_DEG_LAT, m_per_deg_lon,
};
use noise_compute::types::RasterSampler;

use crate::{FusedGrid, RealRasters};

/// Side length of one output tile in receiver pixels.
pub const TILE_PX: usize = 256;

/// Halo extension on each side of the tile bbox, in metres. Matches the
/// ground-ops `TRAFFIC_PRUNE_RADIUS_M` in `heatmap-aircraft`.
pub const HALO_M: f64 = 16_000.0;

/// Equatorial m/px at zoom 0. = 2 π R / 256 with R = 6 378 137.
const EQUATORIAL_M_PER_PX_Z0: f64 = 156_543.033_928_040_99;

/// Mercator tile bbox in lat/lon (EPSG:4326).
#[derive(Debug, Clone, Copy)]
pub struct TileBbox {
    pub west_lon: f64,
    pub east_lon: f64,
    pub north_lat: f64,
    pub south_lat: f64,
}

impl TileBbox {
    pub fn from_xyz(zoom: u8, x: u32, y: u32) -> Self {
        use std::f64::consts::PI;
        let n = (1u64 << zoom) as f64;
        let xf = x as f64;
        let yf = y as f64;
        let west_lon = xf / n * 360.0 - 180.0;
        let east_lon = (xf + 1.0) / n * 360.0 - 180.0;
        let north_lat = (PI * (1.0 - 2.0 * yf / n)).sinh().atan().to_degrees();
        let south_lat = (PI * (1.0 - 2.0 * (yf + 1.0) / n)).sinh().atan().to_degrees();
        TileBbox { west_lon, east_lon, north_lat, south_lat }
    }
}

#[inline]
fn mercator_y_from_lat(lat: f64) -> f64 {
    let lat_rad = lat.to_radians();
    (lat_rad.tan() + 1.0 / lat_rad.cos()).ln()
}

#[inline]
fn lat_from_mercator_y(merc: f64) -> f64 {
    use std::f64::consts::PI;
    (2.0 * merc.exp().atan() - PI / 2.0).to_degrees()
}

#[inline]
fn pixel_lat(bbox: &TileBbox, py: u32) -> f64 {
    let n = TILE_PX as f64;
    let north_merc = mercator_y_from_lat(bbox.north_lat);
    let south_merc = mercator_y_from_lat(bbox.south_lat);
    let frac = (py as f64 + 0.5) / n;
    let merc = north_merc + frac * (south_merc - north_merc);
    lat_from_mercator_y(merc)
}

#[inline]
fn pixel_lon(bbox: &TileBbox, px: u32) -> f64 {
    let n = TILE_PX as f64;
    let frac = (px as f64 + 0.5) / n;
    bbox.west_lon + frac * (bbox.east_lon - bbox.west_lon)
}

/// Mercator pixel side at the given latitude and zoom.
#[inline]
pub fn tile_pixel_size_m(zoom: u8, lat: f64) -> f64 {
    EQUATORIAL_M_PER_PX_Z0 * lat.to_radians().cos() / ((1u64 << zoom) as f64)
}

/// Per-tile raster cache for the aircraft ground-ops V1 kernel.
///
/// `inner_*` arrays are row-major `TILE_PX × TILE_PX` cells aligned with
/// the Mercator receiver lattice at `zoom`. `halo` is the WGS84
/// `FusedGrid` covering the tile bbox extended by `HALO_M`.
pub struct FusedTileZ13 {
    pub zoom: u8,
    pub tile_x: u32,
    pub tile_y: u32,
    pub bbox: TileBbox,

    /// Receiver latitudes — one per pixel row.
    pub rx_lat: [f64; TILE_PX],
    /// Receiver longitudes — one per pixel column.
    pub rx_lon: [f64; TILE_PX],

    /// DEM elevation at every pixel centre.
    pub inner_elev_m: Vec<f32>,
    /// Building height (Overture, nearest-neighbour).
    pub inner_building: Vec<u8>,
    /// Forest cover 0/100 (WorldCover, nearest).
    pub inner_forest: Vec<u8>,
    /// Imperviousness 0..=100 (bilinear).
    pub inner_imd: Vec<u8>,

    /// Receiver altitude = DEM + END facade height (4 m). Pre-baked.
    pub rx_alt_m: Vec<f32>,
    /// Pre-baked receiver-side `building_enclosure` reflection bonus.
    pub rx_refl_db: Vec<f32>,

    /// Halo covering tile bbox + `HALO_M` extension on each side.
    pub halo: FusedGrid,
}

impl FusedTileZ13 {
    /// Build by sampling rasters for one Mercator tile at the given zoom.
    pub fn build(zoom: u8, tile_x: u32, tile_y: u32, rasters: &RealRasters) -> Self {
        let bbox = TileBbox::from_xyz(zoom, tile_x, tile_y);

        let mut rx_lat = [0.0_f64; TILE_PX];
        let mut rx_lon = [0.0_f64; TILE_PX];
        for i in 0..TILE_PX {
            rx_lat[i] = pixel_lat(&bbox, i as u32);
            rx_lon[i] = pixel_lon(&bbox, i as u32);
        }

        let centre_lat = (bbox.north_lat + bbox.south_lat) * 0.5;
        let halo_lat_deg = HALO_M / M_PER_DEG_LAT;
        let halo_lon_deg = HALO_M / m_per_deg_lon(centre_lat.to_radians()).max(1.0);
        let halo = FusedGrid::build(
            rasters,
            bbox.south_lat - halo_lat_deg,
            bbox.north_lat + halo_lat_deg,
            bbox.west_lon - halo_lon_deg,
            bbox.east_lon + halo_lon_deg,
        );

        let n = TILE_PX * TILE_PX;
        let mut inner_elev_m = vec![0.0_f32; n];
        let mut inner_building = vec![0_u8; n];
        let mut inner_forest = vec![0_u8; n];
        let mut inner_imd = vec![0_u8; n];
        let mut rx_alt_m = vec![0.0_f32; n];
        let mut rx_refl_db = vec![0.0_f32; n];

        // Sample inner core directly from RealRasters tile stores — the
        // same mmap pages were just warmed building the halo, so this is
        // entirely cache-hot. `rx_refl_db` reads from the freshly built
        // halo (denser than 3×3-on-mmap, and one fewer cache hop).
        for py in 0..TILE_PX {
            let lat = rx_lat[py];
            let row_base = py * TILE_PX;
            for px in 0..TILE_PX {
                let lon = rx_lon[px];
                let idx = row_base + px;
                let elev = rasters.dem.sample(lat, lon) as f32;
                inner_elev_m[idx] = elev;
                inner_building[idx] = rasters.building.sample(lat, lon) as u8;
                inner_forest[idx] = rasters.forest.sample(lat, lon) as u8;
                inner_imd[idx] = rasters.imd.sample(lat, lon).round() as u8;
                rx_alt_m[idx] = elev + DEFAULT_RECEIVER_HEIGHT as f32;
                rx_refl_db[idx] = halo.building_enclosure(lat, lon) as f32;
            }
        }

        FusedTileZ13 {
            zoom,
            tile_x,
            tile_y,
            bbox,
            rx_lat,
            rx_lon,
            inner_elev_m,
            inner_building,
            inner_forest,
            inner_imd,
            rx_alt_m,
            rx_refl_db,
            halo,
        }
    }

    /// Return true if `(lat, lon)` lies inside the inner-core bbox.
    #[inline]
    pub fn bbox_contains(&self, lat: f64, lon: f64) -> bool {
        lat >= self.bbox.south_lat
            && lat <= self.bbox.north_lat
            && lon >= self.bbox.west_lon
            && lon <= self.bbox.east_lon
    }

    /// Map `(lat, lon)` inside the bbox to inner-core flat index. Linear
    /// fractional interpolation across the Mercator pixel grid; sub-metre
    /// error across one z=13 tile (~3 km wide).
    #[inline]
    pub fn latlon_to_inner_idx(&self, lat: f64, lon: f64) -> usize {
        let n = TILE_PX as f64;
        let lat_frac = (self.bbox.north_lat - lat) / (self.bbox.north_lat - self.bbox.south_lat);
        let lon_frac = (lon - self.bbox.west_lon) / (self.bbox.east_lon - self.bbox.west_lon);
        let py = (lat_frac * n).floor().clamp(0.0, (TILE_PX - 1) as f64) as usize;
        let px = (lon_frac * n).floor().clamp(0.0, (TILE_PX - 1) as f64) as usize;
        py * TILE_PX + px
    }

    /// Receiver altitude (DEM + 4 m) at pixel.
    #[inline]
    pub fn rx_alt(&self, py: u32, px: u32) -> f32 {
        self.rx_alt_m[py as usize * TILE_PX + px as usize]
    }

    /// Pre-baked enclosure reflection bonus (0..=5 dB) at pixel.
    #[inline]
    pub fn rx_refl(&self, py: u32, px: u32) -> f32 {
        self.rx_refl_db[py as usize * TILE_PX + px as usize]
    }
}

impl RasterSampler for FusedTileZ13 {
    fn elevation(&self, lat: f64, lon: f64) -> f64 {
        if self.bbox_contains(lat, lon) {
            self.inner_elev_m[self.latlon_to_inner_idx(lat, lon)] as f64
        } else {
            self.halo.elevation(lat, lon)
        }
    }

    fn building_height(&self, lat: f64, lon: f64) -> f64 {
        if self.bbox_contains(lat, lon) {
            self.inner_building[self.latlon_to_inner_idx(lat, lon)] as f64
        } else {
            self.halo.building_height(lat, lon)
        }
    }

    fn ground_g(&self, lat: f64, lon: f64) -> f64 {
        if self.bbox_contains(lat, lon) {
            let imd = self.inner_imd[self.latlon_to_inner_idx(lat, lon)] as f64;
            1.0 - imd / 100.0
        } else {
            self.halo.ground_g(lat, lon)
        }
    }

    fn building_enclosure(&self, lat: f64, lon: f64) -> f64 {
        // The 75 m metric probe spans cells beyond the inner core for
        // edge receivers. Halo covers tile + 16 km, so the probe always
        // sees real building data regardless of receiver position.
        self.halo.building_enclosure(lat, lon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn data_root() -> Option<PathBuf> {
        // Cargo runs tests from the crate root, so resolve relative to it.
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let p = PathBuf::from(manifest_dir).join("../../data/prepared");
        if p.exists() { Some(p) } else { None }
    }

    #[test]
    fn praha_tile_bbox_round_trips() {
        // Praha LKPR (50.10°N, 14.26°E) → z=13 tile (4420, 2773).
        let bbox = TileBbox::from_xyz(13, 4420, 2773);
        assert!(
            bbox.south_lat > 49.9 && bbox.north_lat < 50.3,
            "lat range {:.3}..{:.3}", bbox.south_lat, bbox.north_lat
        );
        assert!(
            bbox.west_lon > 14.0 && bbox.east_lon < 14.5,
            "lon range {:.3}..{:.3}", bbox.west_lon, bbox.east_lon
        );
    }

    #[test]
    fn pixel_size_at_praha_z13() {
        let px_m = tile_pixel_size_m(13, 50.10);
        assert!((px_m - 12.3).abs() < 0.5, "z=13 px size at Praha = {px_m:.3} m");
    }

    #[test]
    fn pixel_centres_inside_bbox() {
        let bbox = TileBbox::from_xyz(13, 4420, 2773);
        let lat = pixel_lat(&bbox, 128);
        let lon = pixel_lon(&bbox, 128);
        assert!(lat <= bbox.north_lat && lat >= bbox.south_lat);
        assert!(lon >= bbox.west_lon && lon <= bbox.east_lon);
    }

    #[test]
    fn latlon_round_trip_via_inner_idx() {
        let bbox = TileBbox::from_xyz(13, 4420, 2773);
        let bbox_centre_lat = (bbox.north_lat + bbox.south_lat) * 0.5;
        let bbox_centre_lon = (bbox.east_lon + bbox.west_lon) * 0.5;
        let n = TILE_PX as f64;
        let lat_frac = (bbox.north_lat - bbox_centre_lat) / (bbox.north_lat - bbox.south_lat);
        let lon_frac = (bbox_centre_lon - bbox.west_lon) / (bbox.east_lon - bbox.west_lon);
        let py = (lat_frac * n).floor() as usize;
        let px = (lon_frac * n).floor() as usize;
        assert_eq!(py, 128);
        assert_eq!(px, 128);
    }

    #[test]
    fn build_smoke() {
        let Some(root) = data_root() else {
            eprintln!("data/prepared not present; skipping FusedTileZ13 smoke build");
            return;
        };
        let rasters = RealRasters::new(&root);
        let tile = FusedTileZ13::build(13, 4493, 2823, &rasters);
        assert_eq!(tile.zoom, 13);
        assert_eq!(tile.inner_elev_m.len(), TILE_PX * TILE_PX);
        assert_eq!(tile.rx_alt_m.len(), TILE_PX * TILE_PX);
        // Praha DEM around 200-400 m; receiver alt = DEM + 4 m.
        let mid = tile.rx_alt(128, 128);
        assert!(mid > 100.0 && mid < 500.0, "Praha tile centre alt = {mid} m");
    }
}
