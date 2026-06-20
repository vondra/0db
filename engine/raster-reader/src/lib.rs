//! Real raster reader — raw 1°×1° tiles, mmap'd, global scale.
//!
//! Implements noise_compute::types::RasterSampler for both popup (lazy) and pipeline (pre-loaded).
//! Reads Copernicus GLO-30 / SRTM DEM, Overture building height, WorldCover forest, IMD ground type.
//!
//! Submodules:
//! - [`real_rasters`] — [`RealRasters`]: lazy mmap'd 1° tiles, the popup + extract sampler.
//! - [`fused_grid`] — [`FusedGrid`] + [`FusedPixel`]: L3-resident cropped grid for pipeline compute.
//! - [`fused_tile_z13`] — z13 tile batching/halo over [`FusedGrid`].
//! - [`tile`] — the underlying [`TileStore`](tile::TileStore) / [`RawTile`] mmap cache.

pub mod fused_grid;
pub mod fused_tile_z13;
pub mod real_rasters;
pub mod tile;

pub use fused_grid::{FusedGrid, FusedPixel};
pub use real_rasters::RealRasters;
pub use tile::RawTile;

/// Half-edge of the `building_enclosure` 3×3 probe footprint, in metres.
/// 75 m yields a 150 × 150 m isotropic square; the prior 0.001° degree
/// step squeezed E-W at high latitudes (down to ~75 m at 70°N), making
/// the enclosure metric latitude-dependent.
///
/// Shared by [`real_rasters::RealRasters::building_enclosure`] and
/// [`fused_grid::FusedGrid::building_enclosure`] — the two impls must probe the
/// identical footprint for popup/pipeline parity, so the constant lives in the
/// crate root and both reach it via `crate::ENCLOSURE_RADIUS_M`.
pub(crate) const ENCLOSURE_RADIUS_M: f64 = 75.0;
