//! Generic surface-scatter kernel for the road/rail line sources
//! ([`crate::scatter_line`], via its `LineGeometry`) and the industrial/building
//! point sources ([`crate::scatter_point`], via its `PointGeometry`). Both walk
//! the SAME receiver-block structure, energy-budget skip, terrain ray-march,
//! `max(A_gr, A_bar)` path assembly, and 3-period accumulation; they differ ONLY
//! in the per-pixel geometry that turns a (source, receiver) pair into the
//! propagation terms. That divergence is the [`PixelGeometry`] trait; everything
//! else is this one kernel, so a propagation bug is fixed once and a future
//! optimisation lands on both.
//!
//! What stays per-geometry (the [`PixelGeometry::pixel`] return [`PixelTerms`]):
//!  * divergence law — line is ISO 9613-2 CYLINDRICAL `10·log10(2π·d_slant)`,
//!    point is SPHERICAL `20·log10(d)+11`;
//!  * the line's finite-line correction (folded into `base_db`) vs the point's
//!    free-field audibility pre-gate (a real per-pixel cull — `pixel` returns
//!    `None`) and its exclusion radius (effective distance + screening exclusion);
//!  * the ground model — line path-averages `ground_g_from_profile` (hard `G=0`
//!    on a bridge), point samples the RECEIVER's `ground_g` (oracle parity);
//!  * the profile sample point — line uses the segment foot, point the source.
//!
//! ground-ops ([`crate::ground_ops`]) shares the machinery (the [`BandScratch`]
//! and the helpers below) but NOT this kernel: it has per-row event weights, a
//! mixed-geometry skip bound, and a different Lden collapse, so its band body
//! stays its own.
//!
//! ## Energy-budget skip (receiver-band ownership)
//!
//! Most far/quiet sources are inaudible at a pixel a louder near source already
//! dominates — computing their exact terrain/diffraction path is wasted work an
//! aggregate Lden can't resolve. So per pixel we track the kept Lden energy and a
//! `skipped` accumulator: a pair whose BEST-CASE contribution (a cheap upper
//! bound — no terrain/screening/veg + max ground gain ⇒ provably ≥ exact) keeps
//! total skipped within `BUDGET_ETA` of kept is dropped without the profile
//! build. Total under-read is bounded by `10·log10(1+η) = 1.5 dB`. Unlike a
//! reach-radius cut this is PER-PIXEL energy-aware: an isolated rural dwelling
//! whose only source is one far road has no louder source to mask it, so `kept`
//! stays ~0 and the source is computed exactly.
//!
//! The skip needs each pixel's running `kept` to see ALL its sources, so the
//! scatter is parallelised over receiver BLOCKS (not over sources): one block
//! owns a square pixel rectangle ([`recv_block_regions`]) and loops every source
//! clipped to it. (Source-major `par_iter` splits a pixel's sources across
//! threads → partial budgets, measured ~10 % skip vs ~30-46 % for block
//! ownership.)

use std::f64::consts::LN_10;
use std::sync::OnceLock;

use noise_compute::constants::{ALPHA_ATM, A_WEIGHTING, GROUND_CF};
use noise_compute::propagation::iso9613::fast_exp_f64;
use noise_compute::propagation::obstacle_index::{CrossingCandidate, ObstacleSet};
use noise_compute::propagation::path_effects;
use noise_compute::propagation::path_profile::CoarseMid;
use noise_compute::propagation::PathProfile;
use noise_compute::types::{Barrier, RasterSampler};
use raster_reader::fused_tile_z13::{FusedTileZ13, TileBbox, TILE_PX};
use rayon::prelude::*;

use crate::accumulator::{TileAccumulator, NUM_PERIODS};

pub(crate) const NUM_BANDS: usize = 8;

/// Receiver block size (px): the scatter parallelises over square `B×B` pixel
/// blocks, one rayon work-item each (shared by the line / point / ground-ops
/// kernels via [`recv_block_regions`]). Square blocks beat full-width row-bands by
/// ~16% on dense tiles and up to ~40% on sparse — per-core L2 locality of the
/// terrain ray-march (a compact block's hot terrain fits L1/L2, a full-width band
/// spills to shared L3) PLUS finer load-balance (a wide band over a sparse tile
/// leaves most cores idle; 1024 blocks + rayon work-stealing spread it). Measured;
/// the standard GPU "tiled rendering" / cache-blocking pattern. `SURFACE_BLOCK_PX`
/// overrides it (must be >0; e.g. 8 is ~3% faster on dense, more scheduling churn).
pub(crate) const RECV_BLOCK_PX: usize = 16;

fn recv_block_px() -> usize {
    static V: OnceLock<usize> = OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("SURFACE_BLOCK_PX")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|&b| b > 0)
            .unwrap_or(RECV_BLOCK_PX)
    })
}

/// The tile's TILE_PX×TILE_PX receiver pixels partitioned into square blocks of
/// [`recv_block_px`], each `(py_lo, py_hi, px_lo, px_hi)` a rayon work-item. Shared
/// by all three surface scatter kernels.
pub(crate) fn recv_block_regions() -> Vec<(usize, usize, usize, usize)> {
    let b = recv_block_px();
    let bps = TILE_PX.div_ceil(b);
    (0..bps * bps)
        .map(|blk| {
            let (by, bx) = (blk / bps, blk % bps);
            (
                by * b,
                ((by + 1) * b).min(TILE_PX),
                bx * b,
                ((bx + 1) * b).min(TILE_PX),
            )
        })
        .collect()
}

/// Energy-budget skip tolerance: total skipped Lden energy stays within η of
/// the kept energy, so the displayed under-read is `≤ 10·log10(1+η)`. η=0.40 ⇒
/// ≤ 1.5 dB (HM3's 1 dB quantisation can show a 2.0 dB byte step).
/// The error concentrates at LOUD pixels (large budget); faint near-floor
/// pixels keep a tiny budget so they barely skip and stay near-exact.
/// `SURFACE_BUDGET_ETA` lowers it (clamped to `[0, this]`; 0 = exact reference).
const BUDGET_ETA: f64 = 0.40;

/// Clamp the env override to `[0, BUDGET_ETA]`: it may only make the skip MORE
/// conservative (or disable it), never exceed the validated ≤1.5 dB bound — an
/// accidental `SURFACE_BUDGET_ETA=1.0` would otherwise mean a 3 dB under-read.
pub(crate) fn budget_eta() -> f64 {
    static ETA: OnceLock<f64> = OnceLock::new();
    *ETA.get_or_init(|| {
        std::env::var("SURFACE_BUDGET_ETA")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|e| e.is_finite() && *e >= 0.0)
            .map(|e| e.min(BUDGET_ETA))
            .unwrap_or(BUDGET_ETA)
    })
}

/// `fast_exp_f64` is ~1.45e-6 non-monotone at its range-reduction joints (Codex
/// /gg), so a numerically "louder" upper bound can read fractionally below the
/// exact value. Inflate the UB by 1e-4 (≫ that wobble) so `ub ≥ exact` stays
/// literally true — the skip's soundness rests on it.
pub(crate) const UB_SAFETY: f64 = 1.0001;

/// Default coarse-middle stride for the surface-heatmap ray-march: beyond the
/// full-res near-end zone the deep-middle ray is stepped at 3× the 245 m coarse
/// step (≈737 m). `SURFACE_SHADOW_STRIDE` overrides; `1` disables (exact
/// reference). The near-end zones (below) are never subsampled. Tuned on the
/// LKPR/Dobříš/rural trio against the method's own raster-phase noise floor:
/// with the 600 m zones protecting the diffraction-critical near field, stride 3
/// (vs 2) buys +11 pt deep-middle reduction at essentially the same error
/// (exceed ≤4.5 % of cells, DEV p99 ≤0.8 dB ≪ the floor's 2.6-5.2 dB p99);
/// stride 4 adds little for the same accuracy. See /tmp/s6-coarse-shadow-report.md.
const SHADOW_MID_STRIDE: usize = 3;

/// Default full-res half-window metres from each end (≈600 m). The dense
/// 10/30/60/120 m bilateral ramp is kept only within this distance of an
/// endpoint — where berms / near-receiver walls make the shadow SHARP — and the
/// far field is coarse-stepped. Tuned to the sweet spot where the coarse error
/// sits WITHIN the method's own noise floor: 200 m exceeded it (20-38 % of
/// cells), 600 m brings exceed to ≤4.5 % with ~33-44 % fewer ray samples on long
/// rays. `SURFACE_SHADOW_SRC_ZONE_M` / `SURFACE_SHADOW_RX_ZONE_M` raise it as
/// future 5 m terrain + OSM-exact buildings sharpen the field. The RECEIVER side
/// is the bigger edge-tail driver, so it can warrant a wider window (measured
/// symmetric here — the CZ fixtures show no rx/src asymmetry at 600 m).
const SHADOW_SRC_ZONE_M: f64 = 600.0;
const SHADOW_RX_ZONE_M: f64 = 600.0;

/// The surface-heatmap coarse-middle cadence config, read once from env. `None`
/// ⇒ exact cadence (the `STRIDE=1` reference path). Shared by the line, point,
/// and ground-ops kernels so the cadence is identical across the three surface
/// terrain-ray-march sources.
pub(crate) fn coarse_mid_cfg() -> Option<CoarseMid> {
    static CFG: OnceLock<Option<CoarseMid>> = OnceLock::new();
    *CFG.get_or_init(|| {
        let env_usize = |k: &str, d: usize| {
            std::env::var(k)
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(d)
        };
        let env_f64 = |k: &str, d: f64| {
            std::env::var(k)
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .unwrap_or(d)
        };
        let mid_stride = env_usize("SURFACE_SHADOW_STRIDE", SHADOW_MID_STRIDE).clamp(1, 8);
        if mid_stride <= 1 {
            return None; // exact reference
        }
        Some(CoarseMid {
            src_zone_m: env_f64("SURFACE_SHADOW_SRC_ZONE_M", SHADOW_SRC_ZONE_M),
            rx_zone_m: env_f64("SURFACE_SHADOW_RX_ZONE_M", SHADOW_RX_ZONE_M),
            mid_stride,
        })
    })
}

/// Build a path profile for surface scatter, applying the coarse-middle cadence
/// when enabled, else the exact cadence. The single call site for all three
/// surface kernels so the cadence policy lives in one place.
#[inline]
pub(crate) fn build_surface_profile(
    tile: &FusedTileZ13,
    cfg: Option<CoarseMid>,
    src_lat: f64,
    src_lon: f64,
    rcv_lat: f64,
    rcv_lon: f64,
    dist_m: f64,
    out: &mut PathProfile,
) {
    match cfg {
        Some(cm) => {
            tile.build_path_profile_coarse_mid(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, cm, out)
        }
        None => tile.build_path_profile(src_lat, src_lon, rcv_lat, rcv_lon, dist_m, out),
    }
}

/// Lden-energy period weights = `compute_lden`'s 12/4/8-hour × 0/5/10-dB
/// penalties (`10^(penalty/10)`): collapse a pair's per-period power to the one
/// scalar the budget compares. The shared `/24` cancels in the skip RATIO, so
/// it's dropped (√10 = 3.162… for the +5 dB evening penalty).
pub(crate) const LDEN_WEIGHTS: [f64; NUM_PERIODS] = [12.0, 4.0 * 3.1622776601683795, 80.0];

/// dB path level → linear A-weighted band energy. The hot loop's innermost op,
/// shared by the budget bound and the exact path factor — keep the expression
/// identical (the exact path must stay bit-exact vs the pre-skip kernel).
#[inline]
pub(crate) fn db_to_lin_a(path_db: f64, band: usize) -> f64 {
    fast_exp_f64((path_db + A_WEIGHTING[band]) * LN_10 * 0.1)
}

/// Best-case Lden energy of a source→pixel pair for the budget skip: no
/// terrain/screening/veg + max ground gain (`(-CF).max(0)`), inflated by
/// [`UB_SAFETY`] — provably ≥ the exact contribution. Shared verbatim by the
/// line + point kernels so the `ub ≥ exact` soundness invariant lives in one
/// place. `base_db` already folds in divergence/FLC/reflection; `emission_lden`
/// is the pair's Lden-weighted band spectrum.
#[inline]
pub(crate) fn budget_ub_lden(base_db: f64, atm_d_km: f64, emission_lden: &[f64; NUM_BANDS]) -> f64 {
    let mut ub = 0.0;
    for i in 0..NUM_BANDS {
        let ground_gain_ub = (-GROUND_CF[i]).max(0.0);
        let path_db = base_db - ALPHA_ATM[i] * atm_d_km + ground_gain_ub;
        ub += emission_lden[i] * db_to_lin_a(path_db, i);
    }
    ub * UB_SAFETY
}

/// Per-worker scatter state, threaded through the blocks one rayon worker folds.
/// `kept`/`skipped` are full-tile but each block touches only its own (disjoint)
/// pixel rectangle, so they need no clearing between a worker's blocks. Shared by
/// the line, point, and ground-ops kernels.
pub(crate) struct BandScratch {
    pub(crate) local: TileAccumulator,
    pub(crate) profile: PathProfile,
    pub(crate) kept: Vec<f64>,
    pub(crate) skipped: Vec<f64>,
    pub(crate) path_calls: u64,
    pub(crate) skipped_calls: u64,
    /// Raster cadence samples taken by `build_path_profile` (the ray-march). Each
    /// reads a 4-cell bilinear quad, so cell reads = 4× this — the numerator of
    /// the read-redundancy metric (cell reads ÷ grid cells = ×-reread).
    pub(crate) raster_samples: u64,
    /// Vector-obstacle crossings of the current ray (geodata-v2, reused).
    pub(crate) cand_scratch: Vec<CrossingCandidate>,
}

impl BandScratch {
    pub(crate) fn new() -> Self {
        let n = TILE_PX * TILE_PX;
        Self {
            local: TileAccumulator::new(),
            profile: PathProfile::new(),
            kept: vec![0.0; n],
            skipped: vec![0.0; n],
            path_calls: 0,
            skipped_calls: 0,
            raster_samples: 0,
            cand_scratch: Vec::new(),
        }
    }
}

/// How a pixel's ground attenuation coefficient `G` is resolved AFTER the path
/// profile is built — the one branch where the line and point ground models
/// diverge. Line path-averages the profile (hard `G=0` on a bridge); point
/// samples the receiver's `ground_g` (the popup oracle samples it once at the
/// receiver, not along the path).
pub(crate) enum GroundSrc {
    /// `path_effects::ground_g_from_profile(&profile)` — the line's path average.
    FromProfile,
    /// A pixel-resolved constant — the line's bridge `0.0`.
    Fixed(f64),
    /// `tile.ground_g(rx_lat, rx_lon)` — the point's receiver-sampled `G` (oracle
    /// parity). Resolved by the kernel AFTER the budget skip (like the original
    /// point loop), so a skipped pixel never pays for the raster lookup; the value
    /// is a pure lat/lon function so deferring it is byte-identical.
    ReceiverSampled,
}

/// Everything the generic band loop needs from a (source, receiver) pair that the
/// per-geometry [`PixelGeometry::pixel`] computes. The shared kernel folds these
/// into the budget bound, the path build, and the `max(A_gr, A_bar)` assembly
/// identically for line and point — the divergence law, FLC, exclusion, ground
/// model, and profile sample point are all already baked in here.
pub(crate) struct PixelTerms {
    /// Distance/divergence/FLC/reflection folded to a pre-attenuation dB level
    /// (`refl + flc − geo_div` for line; `refl − geo_div` for point).
    pub(crate) base_db: f64,
    /// Slant distance in km for atmospheric absorption (`d_slant / 1000`).
    pub(crate) atm_d_km: f64,
    /// Horizontal distance passed to `build_surface_profile` (the ray length):
    /// line = `d_endpoint_m`; point = the PRE-exclusion flat `dist_m` (NOT the
    /// exclusion-shrunk `prop_dist`, which only feeds the divergence `d_slant`).
    pub(crate) profile_dist_m: f64,
    /// Source altitude (ground elevation + source height) for terrain/screening.
    pub(crate) src_alt: f64,
    /// `exclusion_radius_m` passed to `screening_attenuation` so footprint
    /// buildings aren't a barrier: line `0.0`, point `exclusion_radius_m`.
    pub(crate) excl_m: f64,
    /// Source-side lat/lon the profile is sampled from: line = the segment foot
    /// `cp_lat/cp_lon`; point = the source `lat/lon`.
    pub(crate) cp_lat: f64,
    pub(crate) cp_lon: f64,
    /// How `G` is resolved after the profile is built (line vs point ground model).
    pub(crate) ground_src: GroundSrc,
}

/// A prepared source's tile-pixel reach box + per-period emission, exposed
/// generically so the band loop clips and accumulates without knowing whether the
/// source is a line or a point. The bbox/emission `prepare` phase stays
/// geometry-specific (line uses segment extents + a widest-segment latitude,
/// point a centre + precomputed source altitude); only the post-clip band body is
/// unified.
pub(crate) trait PreparedSource {
    /// Reach-box top/bottom/left/right tile-pixel bounds (inclusive).
    fn reach_box(&self) -> (usize, usize, usize, usize);
    /// `[period][band]` linear A-unweighted band energy (the accumulation factor).
    fn emission_lin(&self) -> &[[f32; NUM_BANDS]; NUM_PERIODS];
    /// Lden-weighted band spectrum for the budget upper bound.
    fn emission_lden(&self) -> &[f64; NUM_BANDS];
}

/// The per-pixel geometry divergence between the line and point kernels. One
/// `Prep` row is borrowed by [`Self::pixel`] for every receiver in its reach box;
/// returning `None` culls the pixel (out of reach, or below the point's
/// free-field audibility floor) BEFORE any budget/path work.
pub(crate) trait PixelGeometry: Sync {
    /// Per-source prepared row (reach box, emission, and any pixel-independent
    /// hoisted state like the point's source altitude). `Sync` because the
    /// rayon block-fold borrows `&[Prep]` across worker threads.
    type Prep: PreparedSource + Sync;

    /// Prepare every in-reach, emitting source's reach box + emission, pushing
    /// each onto `prep` (silent or wholly-out-of-tile sources drop).
    fn prepare(&self, tile: &FusedTileZ13, prep: &mut Vec<Self::Prep>);

    /// Turn one (source, receiver) pair into the shared propagation terms, or
    /// `None` to cull this pixel. `rx_lat/rx_lon` are the receiver pixel centre;
    /// `rx_alt` its pre-baked altitude; `refl` its reflection dB.
    fn pixel(
        &self,
        prep: &Self::Prep,
        tile: &FusedTileZ13,
        rx_lat: f64,
        rx_lon: f64,
        rx_alt: f64,
        refl: f64,
    ) -> Option<PixelTerms>;
}

/// Telemetry returned by the generic scatter (line and point share the shape).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ScatterStats {
    pub(crate) rows: usize,
    pub(crate) path_calls: u64,
    pub(crate) skipped_calls: u64,
    /// Ray-march cadence samples (×4 = raster cell reads). See [`BandScratch`].
    pub(crate) raster_samples: u64,
}

/// Scatter every prepared source onto `tile` via the geometry `geo`, with the
/// coarse-middle cadence read from the process-wide env (`coarse_mid_cfg`).
#[allow(dead_code)]
pub(crate) fn scatter_tile<G: PixelGeometry>(
    geo: &G,
    tile: &FusedTileZ13,
    barriers: &[Barrier],
    obstacles: Option<&ObstacleSet>,
    n_rows: usize,
    accum: &mut TileAccumulator,
) -> ScatterStats {
    scatter_tile_with_cfg(
        geo,
        tile,
        barriers,
        obstacles,
        n_rows,
        accum,
        coarse_mid_cfg(),
    )
}

/// [`scatter_tile`] with the coarse-middle cadence passed EXPLICITLY (bypassing
/// the process-wide `coarse_mid_cfg` env read). The noise-floor harness uses this
/// to render the exact (`None`) and coarse fields in ONE process; production uses
/// [`scatter_tile`].
pub(crate) fn scatter_tile_with_cfg<G: PixelGeometry>(
    geo: &G,
    tile: &FusedTileZ13,
    barriers: &[Barrier],
    obstacles: Option<&ObstacleSet>,
    n_rows: usize,
    accum: &mut TileAccumulator,
    cfg: Option<CoarseMid>,
) -> ScatterStats {
    if n_rows == 0 {
        return ScatterStats::default();
    }
    let mut prep: Vec<G::Prep> = Vec::new();
    geo.prepare(tile, &mut prep);
    if prep.is_empty() {
        return ScatterStats {
            rows: n_rows,
            ..Default::default()
        };
    }

    let eta = budget_eta();
    let (merged, path_calls, skipped_calls, raster_samples) = recv_block_regions()
        .into_par_iter()
        .fold(BandScratch::new, |mut s, (py_lo, py_hi, px_lo, px_hi)| {
            if py_lo < py_hi && px_lo < px_hi {
                scatter_band(
                    geo, tile, &prep, barriers, obstacles, py_lo, py_hi, px_lo, px_hi, eta, cfg,
                    &mut s,
                );
            }
            s
        })
        .map(|s| (s.local, s.path_calls, s.skipped_calls, s.raster_samples))
        .reduce(
            || (TileAccumulator::new(), 0u64, 0u64, 0u64),
            |mut a, b| {
                a.0.merge_from(&b.0);
                (a.0, a.1 + b.1, a.2 + b.2, a.3 + b.3)
            },
        );
    accum.merge_from(&merged);
    ScatterStats {
        rows: n_rows,
        path_calls,
        skipped_calls,
        raster_samples,
    }
}

/// Scatter every source that reaches the block `[py_lo, py_hi) × [px_lo, px_hi)`
/// into its pixels, applying the per-pixel energy-budget skip. The single hot
/// loop both line and point share; the per-pixel geometry is `geo.pixel`.
#[allow(clippy::too_many_arguments)]
fn scatter_band<G: PixelGeometry>(
    geo: &G,
    tile: &FusedTileZ13,
    prep: &[G::Prep],
    barriers: &[Barrier],
    obstacles: Option<&ObstacleSet>,
    py_lo: usize,
    py_hi: usize,
    px_lo: usize,
    px_hi: usize,
    eta: f64,
    cfg: Option<CoarseMid>,
    s: &mut BandScratch,
) {
    for pr in prep {
        let (rpy0, rpy1, rpx0, rpx1) = pr.reach_box();
        let py0 = rpy0.max(py_lo);
        let py1 = rpy1.min(py_hi - 1);
        if py0 > py1 {
            continue;
        }
        let px0 = rpx0.max(px_lo);
        let px1 = rpx1.min(px_hi - 1);
        if px0 > px1 {
            continue;
        }
        let emission_lin = pr.emission_lin();
        let emission_lden = pr.emission_lden();

        for py in py0..=py1 {
            let rx_lat = tile.rx_lat[py];
            let row_base = py * TILE_PX;
            for px in px0..=px1 {
                let rx_lon = tile.rx_lon[px];
                let idx = row_base + px;
                let rx_alt = tile.rx_alt_m[idx] as f64;
                let refl = tile.rx_refl_db[idx] as f64;
                let Some(t) = geo.pixel(pr, tile, rx_lat, rx_lon, rx_alt, refl) else {
                    continue;
                };

                let ub_lden = budget_ub_lden(t.base_db, t.atm_d_km, emission_lden);
                if s.skipped[idx] + ub_lden <= eta * s.kept[idx] {
                    s.skipped[idx] += ub_lden;
                    s.skipped_calls += 1;
                    continue;
                }

                build_surface_profile(
                    tile,
                    cfg,
                    t.cp_lat,
                    t.cp_lon,
                    rx_lat,
                    rx_lon,
                    t.profile_dist_m,
                    &mut s.profile,
                );
                s.path_calls += 1;
                s.raster_samples += s.profile.len() as u64;
                let ground_g = match t.ground_src {
                    GroundSrc::FromProfile => path_effects::ground_g_from_profile(&s.profile),
                    GroundSrc::Fixed(g) => g,
                    GroundSrc::ReceiverSampled => tile.ground_g(rx_lat, rx_lon),
                };
                // Heatmap discards the popup obstacle traces, so call the
                // metadata-free band-only variants: terrain skips the per-pixel
                // EdgePoint Vec, screening skips the ObstacleEdge materialisation.
                let terrain_bands =
                    path_effects::terrain_attenuation(&mut s.profile, t.src_alt, rx_alt);
                let obstacle_input = match obstacles {
                    Some(set) => {
                        set.crossings(t.cp_lat, t.cp_lon, rx_lat, rx_lon, &mut s.cand_scratch);
                        path_effects::ObstacleInput {
                            candidates: &s.cand_scratch,
                            replace_sample_buildings: true,
                        }
                    }
                    None => path_effects::ObstacleInput::CANDIDATES_OFF,
                };
                let screening = path_effects::screening_attenuation(
                    &mut s.profile,
                    barriers,
                    obstacle_input,
                    t.src_alt,
                    rx_alt,
                    t.excl_m,
                    &terrain_bands,
                );
                let veg = path_effects::vegetation_attenuation_path(&s.profile);

                // Period-independent per-band path factor (A-weighted linear).
                let mut pf = [0.0f64; NUM_BANDS];
                for i in 0..NUM_BANDS {
                    let a_gr = GROUND_CF[i] * ground_g;
                    let a_bar = terrain_bands[i] + screening[i];
                    // ISO 9613-2 §7.3.1: barrier REPLACES ground (max), never adds.
                    let gob = if a_bar > 0.0 { a_gr.max(a_bar) } else { a_gr };
                    let path_db = t.base_db - ALPHA_ATM[i] * t.atm_d_km - gob - veg[i];
                    pf[i] = db_to_lin_a(path_db, i);
                }

                let mut kept_add = 0.0;
                for p in 0..NUM_PERIODS {
                    let mut power = 0.0f64;
                    for i in 0..NUM_BANDS {
                        power += emission_lin[p][i] as f64 * pf[i];
                    }
                    if power.is_finite() && power > 0.0 {
                        s.local
                            .add_energy_at(py as u32, px as u32, p as u8, power as f32);
                        kept_add += power * LDEN_WEIGHTS[p];
                    }
                }
                s.kept[idx] += kept_add;
            }
        }
    }
}

/// Tile pixel row for a latitude (linear in the Mercator bbox, matching
/// `FusedTileZ13::latlon_to_inner_idx`); clamped to `[0, TILE_PX)`. Shared by all
/// three surface scatter kernels for the reach-bbox clip.
#[inline]
pub(crate) fn lat_to_py(bbox: &TileBbox, lat: f64) -> usize {
    let frac = (bbox.north_lat - lat) / (bbox.north_lat - bbox.south_lat);
    (frac * TILE_PX as f64)
        .floor()
        .clamp(0.0, (TILE_PX - 1) as f64) as usize
}

#[inline]
pub(crate) fn lon_to_px(bbox: &TileBbox, lon: f64) -> usize {
    let frac = (lon - bbox.west_lon) / (bbox.east_lon - bbox.west_lon);
    (frac * TILE_PX as f64)
        .floor()
        .clamp(0.0, (TILE_PX - 1) as f64) as usize
}
