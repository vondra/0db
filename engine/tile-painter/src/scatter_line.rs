//! Line-source (road + rail) scatter onto a Web Mercator base-zoom tile — surface
//! heatmap. ISO line-source physics (cylindrical divergence + finite-line
//! correction): a thin entry point over the generic [`crate::scatter_band`]
//! kernel with [`LineGeometry`]. The shared machinery (receiver-block
//! parallelism, energy-budget skip, terrain ray-march, `max(A_gr, A_bar)`
//! assembly, 3-period accumulation) lives in `scatter_band`; the line-specific
//! physics is `LineGeometry::pixel`:
//!
//! * ISO 9613-2 CYLINDRICAL line divergence `10·log10(2π·d_slant)` (a point
//!   source would be `20·log10(d)+11`; the aircraft kernel uses `θ/d_perp` —
//!   neither applies here).
//! * Finite-line correction `10·log10(θ/π) ≤ 0` added as a dB term, with the
//!   CLAMPED foot distance as its perpendicular argument (matches the popup,
//!   `surface-M1-road-notes.md` trap #3).
//! * CNOSSOS `L_W'/m` emission, pre-baked per period as linear band energy in
//!   the loader; the hot loop multiplies by a shared per-pixel path factor.
//! * Source height carried on the row (road 0.05 m, rail 0.5 m); receiver 4 m
//!   (pre-baked alt).
//!
//! Each segment scatters only the pixels inside its reach disk (a residential
//! road's 800 m reach touches ~18 000 of 262 144 px, not all) — the reach-bbox
//! clip that keeps dense city tiles viable at world scale.
//!
//! ground/barrier interaction is `max(A_gr, A_bar)` (ISO 9613-2 §7.3.1), NOT a
//! sum. Per-period steady power accumulates into [`TileAccumulator`]; the
//! caller collapses via `wire_hm3::collapse_lden_surface_u8` (no time-division).

use std::f64::consts::PI;

use noise_compute::propagation::geo::{finite_line_correction, point_to_segment_full};
use noise_compute::propagation::obstacle_index::ObstacleSet;
use noise_compute::propagation::path_profile::CoarseMid;
use noise_compute::types::{Barrier, RasterSampler};
use raster_reader::fused_tile_z13::FusedTileZ13;

use crate::accumulator::{TileAccumulator, NUM_PERIODS};
use crate::scatter_band::{
    coarse_mid_cfg, lat_to_py, lon_to_px, scatter_tile_with_cfg as band_scatter_tile_with_cfg,
    GroundSrc, PixelGeometry, PixelTerms, PreparedSource, ScatterStats, LDEN_WEIGHTS, NUM_BANDS,
};
use crate::source_line::LineRow;

#[derive(Debug, Clone, Copy, Default)]
pub struct LineScatterStats {
    pub rows: usize,
    pub path_calls: u64,
    pub skipped_calls: u64,
    /// Ray-march cadence samples (×4 = raster cell reads).
    pub raster_samples: u64,
}

impl From<ScatterStats> for LineScatterStats {
    fn from(s: ScatterStats) -> Self {
        Self {
            rows: s.rows,
            path_calls: s.path_calls,
            skipped_calls: s.skipped_calls,
            raster_samples: s.raster_samples,
        }
    }
}

/// Scatter every line segment onto `tile`, accumulating per-period steady
/// power. `accum` is collapsed by the caller with the surface (no
/// time-division) Lden collapse.
///
/// `barriers` is the tile's noise-wall slice prepared by
/// `source_loader_barrier::BarrierData::for_tile` (sorted ascending,
/// conservative `dist_m` — see the `types::Barrier` contract). Empty for
/// the 98.5% of regions without a `barriers.arrow`.
pub fn scatter_tile(
    tile: &FusedTileZ13,
    lines: &[LineRow],
    barriers: &[Barrier],
    obstacles: Option<&ObstacleSet>,
    accum: &mut TileAccumulator,
) -> LineScatterStats {
    scatter_tile_with_cfg(tile, lines, barriers, obstacles, accum, coarse_mid_cfg())
}

/// [`scatter_tile`] with the coarse-middle cadence passed EXPLICITLY (bypassing
/// the process-wide `coarse_mid_cfg` env read). The noise-floor harness uses
/// this to render the exact (`None`) and coarse fields in ONE process; the
/// production path uses [`scatter_tile`].
pub fn scatter_tile_with_cfg(
    tile: &FusedTileZ13,
    lines: &[LineRow],
    barriers: &[Barrier],
    obstacles: Option<&ObstacleSet>,
    accum: &mut TileAccumulator,
    cfg: Option<CoarseMid>,
) -> LineScatterStats {
    band_scatter_tile_with_cfg(
        &LineGeometry { lines },
        tile,
        barriers,
        obstacles,
        lines.len(),
        accum,
        cfg,
    )
    .into()
}

/// A segment's tile-pixel reach box + Lden-weighted emission spectrum + a borrow
/// of its row, precomputed once so the per-block loop is a cheap reach-box ∩ block
/// clip + pixel sweep.
pub(crate) struct PreparedLine<'a> {
    line: &'a LineRow,
    py0: usize,
    py1: usize,
    px0: usize,
    px1: usize,
    emission_lden: [f64; NUM_BANDS],
}

impl PreparedSource for PreparedLine<'_> {
    #[inline]
    fn reach_box(&self) -> (usize, usize, usize, usize) {
        (self.py0, self.py1, self.px0, self.px1)
    }
    #[inline]
    fn emission_lin(&self) -> &[[f32; NUM_BANDS]; NUM_PERIODS] {
        &self.line.emission_lin
    }
    #[inline]
    fn emission_lden(&self) -> &[f64; NUM_BANDS] {
        &self.emission_lden
    }
}

/// ISO 9613-2 line-source physics (road + rail): cylindrical divergence
/// `10·log10(2π·d_slant)`, finite-line correction with the clamped foot distance
/// as its perpendicular argument, path-averaged ground (hard `G=0` on a bridge),
/// and the segment foot as the profile sample point. The borrowed `lines` slice
/// is the source rows the prepare phase clips.
pub(crate) struct LineGeometry<'a> {
    pub(crate) lines: &'a [LineRow],
}

impl<'a> PixelGeometry for LineGeometry<'a> {
    type Prep = PreparedLine<'a>;

    fn prepare(&self, tile: &FusedTileZ13, prep: &mut Vec<PreparedLine<'a>>) {
        let bbox = &tile.bbox;
        prep.extend(self.lines.iter().filter_map(|line| {
            if line
                .emission_lin
                .iter()
                .all(|p| p.iter().all(|&e| e <= 0.0))
            {
                return None;
            }
            let reach = line.max_distance_m;
            let seg_s_lat = line.start_lat.min(line.end_lat);
            let seg_n_lat = line.start_lat.max(line.end_lat);
            let seg_w_lon = line.start_lon.min(line.end_lon);
            let seg_e_lon = line.start_lon.max(line.end_lon);
            // Longitude uses the segment's widest latitude so a poleward-leaning
            // segment is never under-covered (smaller cos → wider lon reach).
            let widest_lat = seg_n_lat.abs().max(seg_s_lat.abs());
            let reach_lat_deg = reach / 110_540.0;
            let reach_lon_deg = reach / (111_320.0 * widest_lat.to_radians().cos().max(0.2));
            if seg_s_lat - reach_lat_deg > bbox.north_lat
                || seg_n_lat + reach_lat_deg < bbox.south_lat
                || seg_w_lon - reach_lon_deg > bbox.east_lon
                || seg_e_lon + reach_lon_deg < bbox.west_lon
            {
                return None;
            }
            let mut emission_lden = [0.0f64; NUM_BANDS];
            // Band-outer / period-inner accumulation order kept verbatim from the
            // pre-refactor kernel — the f32→f64 sum order is part of byte parity.
            #[allow(clippy::needless_range_loop)]
            for i in 0..NUM_BANDS {
                for p in 0..NUM_PERIODS {
                    emission_lden[i] += line.emission_lin[p][i] as f64 * LDEN_WEIGHTS[p];
                }
            }
            Some(PreparedLine {
                line,
                py0: lat_to_py(bbox, seg_n_lat + reach_lat_deg),
                py1: lat_to_py(bbox, seg_s_lat - reach_lat_deg),
                px0: lon_to_px(bbox, seg_w_lon - reach_lon_deg),
                px1: lon_to_px(bbox, seg_e_lon + reach_lon_deg),
                emission_lden,
            })
        }));
    }

    #[inline]
    fn pixel(
        &self,
        pl: &PreparedLine<'a>,
        tile: &FusedTileZ13,
        rx_lat: f64,
        rx_lon: f64,
        rx_alt: f64,
        refl: f64,
    ) -> Option<PixelTerms> {
        let line = pl.line;
        let length_m = line.length_m as f64;
        let reach = line.max_distance_m;
        let pts = point_to_segment_full(
            rx_lat,
            rx_lon,
            line.start_lat,
            line.start_lon,
            line.end_lat,
            line.end_lon,
        );
        let dist_m = pts.d_endpoint_m;
        if dist_m > reach {
            return None;
        }
        let src_alt = tile.elevation(pts.cp_lat, pts.cp_lon) + line.source_height_m;
        let d_slant = (dist_m * dist_m + (src_alt - rx_alt).powi(2))
            .sqrt()
            .max(1.0);
        // FLC: clamp the foot fraction to the segment (popup parity) and pass the
        // clamped-foot distance as the perpendicular argument.
        let flc = finite_line_correction(length_m, dist_m, pts.fraction.clamp(0.0, 1.0));
        let geo_div = 10.0 * (2.0 * PI * d_slant).log10();
        let atm_d_km = d_slant / 1000.0;
        let base_db = refl + flc - geo_div;
        Some(PixelTerms {
            base_db,
            atm_d_km,
            profile_dist_m: dist_m,
            src_alt,
            excl_m: 0.0,
            cp_lat: pts.cp_lat,
            cp_lon: pts.cp_lon,
            ground_src: if line.bridge {
                GroundSrc::Fixed(0.0)
            } else {
                GroundSrc::FromProfile
            },
        })
    }
}
