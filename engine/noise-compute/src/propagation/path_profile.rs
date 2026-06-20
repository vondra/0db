//! Unified path sampler.
//!
//! A single bilateral cadence samples DEM, building height, forest cover and
//! ground-type along every source→receiver line: a 10 m near-probe at each
//! end (berm-case capture), three probes at 30 m, three at 60 m, three at
//! 120 m, then 240 m steps until the middle. Density is highest near source
//! and receiver — where obstacles diffract sound most severely — and coarsest
//! in the middle, where a missed hill would still lie well below the line
//! of sight.
//!
//! Terrain diffraction, building screening, vegetation depth and ground effect
//! all read from the same profile. The previous 3-point fast-LOS gate at
//! t∈{0.25, 0.5, 0.75} is replaced by an in-profile scan (zero extra raster
//! reads) that removes the probe's blind zones.
//!
//! This module owns the canonical cadence (`fill_t_values`) and the profile
//! builder contract (`RasterSampler::build_path_profile`).

use crate::types::RasterSampler;

/// Raster cell size in meters (~30.7m) — 1 arc-second at the equator.
pub const CELL_M: f64 = 110_540.0 / 3600.0;

/// Near-endpoint probe offset (meters). A sample at `NEAR_OFFSET_M` from each
/// end catches obstacles close to the source/receiver that would otherwise
/// fall between t=0 and the first regular 30m sample (e.g. highway berms
/// 5-15m from the road). At the default 30m DEM resolution, a 10m probe on
/// E-W paths hits the cell adjacent to the source ~50% of the time, and on
/// N-S paths the bilinear interpolation still shifts the elevation value
/// enough to be useful for edge detection.
pub const NEAR_OFFSET_M: f64 = 10.0;

/// Unified path profile: one bilateral sample set, all four rasters.
///
/// Per source→receiver path, built once by `RasterSampler::build_path_profile`
/// and consumed by `path_effects` (terrain, screening, vegetation, ground).
#[derive(Debug, Clone, Default)]
pub struct PathProfile {
    /// Fractional position along the path, 0..=1 (includes 0 and 1).
    pub t: Vec<f64>,
    /// DEM ground elevation at each t (bilinear where supported).
    pub elevation_m: Vec<f32>,
    /// Overture building height at each t (nearest cell). 0 = no building.
    pub building_h_m: Vec<u8>,
    /// WorldCover forest flag at each t (nearest cell). 0 or 100.
    pub forest_u8: Vec<u8>,
    /// IMD imperviousness at each t (0..100).
    pub imd_u8: Vec<u8>,
    /// Horizontal path length in meters.
    pub dist_m: f64,
    /// Median inter-sample spacing in meters (for tooltip transparency).
    pub step_m_med: f32,
    pub src_lat: f64,
    pub src_lon: f64,
    pub rcv_lat: f64,
    pub rcv_lon: f64,
    /// Scratch buffer for callers that need f64-typed elevation (e.g.
    /// `horizon::single_edge_atten` via path_effects). Grown on first use, reused
    /// across subsequent calls via `elevation_f64()`.
    pub elevation_f64_scratch: Vec<f64>,
    /// Scratch buffer for the composite top profile (elevation + building_h +
    /// barriers) used by `screening_attenuation_with_meta`. Amortized across
    /// paths.
    pub composite_h_scratch: Vec<f64>,
}

impl PathProfile {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clear all arrays and path metadata, keeping capacities.
    pub fn clear(&mut self) {
        self.t.clear();
        self.elevation_m.clear();
        self.building_h_m.clear();
        self.forest_u8.clear();
        self.imd_u8.clear();
        self.elevation_f64_scratch.clear();
        self.composite_h_scratch.clear();
        self.dist_m = 0.0;
        self.step_m_med = 0.0;
        self.src_lat = 0.0;
        self.src_lon = 0.0;
        self.rcv_lat = 0.0;
        self.rcv_lon = 0.0;
    }

    /// Populate (if needed) and return the f64 elevation scratch buffer,
    /// converted from `elevation_m`. Reuses capacity across calls.
    ///
    /// Free function so callers can use split borrows — the scratch field
    /// can be borrowed mutably while other `PathProfile` fields stay
    /// available for read-only access.
    pub fn elevation_f64_from<'a>(scratch: &'a mut Vec<f64>, src: &[f32]) -> &'a [f64] {
        if scratch.len() != src.len() {
            scratch.clear();
            scratch.extend(src.iter().map(|&e| e as f64));
        }
        scratch.as_slice()
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.t.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
}

/// Coarse-middle cadence config for the SURFACE HEATMAP path builder
/// (`FusedGrid::build_path_profile_coarse_mid`). The popup path NEVER uses this
/// — it stays on the exact [`fill_t_values`] cadence.
///
/// Diffraction is sharpest within ~200 m of EITHER end — berms 5-15 m off a
/// road, a wall just before the receiver: a sharp shadow edge + strong
/// near-barrier attenuation. Beyond that the single-edge δ is a smooth ramp.
/// So this keeps the dense 10/30/60/120 m bilateral ramp only within
/// `src_zone_m` / `rx_zone_m` of each end and coarse-fills the rest of the ray
/// at `mid_stride × 240 m`. (The exact cadence runs the full ramp out to its
/// natural ~1.4 km end on every ray — far more than diffraction needs in the
/// smooth far field.)
///
/// `src_zone_m` / `rx_zone_m` are the TUNABLE full-res half-windows. Future 5 m
/// terrain + exact OSM building shapes sharpen the field → grow them. The
/// RECEIVER side is the bigger edge-tail driver (an obstacle right before the
/// receiver dominates), so `rx_zone_m` may warrant a larger value than
/// `src_zone_m`.
///
/// A very short ray (≤ ~300 m) hits the uniform-stepping branch unchanged; a ray
/// shorter than `src_zone + rx_zone` keeps its full ramp and has no coarse middle.
#[derive(Debug, Clone, Copy)]
pub struct CoarseMid {
    /// Full-res half-window from the SOURCE end (m). The dense ramp truncates
    /// here; beyond it the ray is coarse-stepped. `INFINITY` ⇒ full ramp (exact).
    pub src_zone_m: f64,
    /// Full-res half-window from the RECEIVER end (m) — the dominant edge-tail
    /// side. The dense ramp truncates here. `INFINITY` ⇒ full ramp (exact).
    pub rx_zone_m: f64,
    /// Integer multiplier on the coarse far-field step. `1` ⇒ no coarsening (=
    /// exact). Default `2` ⇒ ~491 m far-field steps instead of ~245 m.
    pub mid_stride: usize,
}

/// Bilateral adaptive t-values for a path of `dist_m` meters.
///
/// Pattern (≥310 m paths): one near-probe per end (`NEAR_OFFSET_M`), three
/// samples at 30 m, three at 60 m, three at 120 m, then 240 m steps through
/// the middle, mirrored. Always includes t=0.0 and t=1.0. Sample count for
/// a 10 km path ≈ 56.
///
/// Short paths (≤10 cells ≈ 307 m) collapse to uniform 30 m stepping plus
/// the near-probes. Paths shorter than 3×NEAR_OFFSET_M skip the near-probes
/// (they would collapse toward the midpoint). Output buffer is cleared
/// before writing.
///
/// **Fundamental raster limit**: a berm narrower than a single DEM cell
/// (~20-30 m) on the edge of the source cell is invisible regardless of
/// sampling strategy. Higher-resolution DEMs (USGS 3DEP 10 m, national
/// lidars 1-5 m) are the only fix.
pub fn fill_t_values(dist_m: f64, buf: &mut Vec<f64>) {
    fill_t_values_inner(dist_m, buf, None);
}

/// [`fill_t_values`] with the SURFACE-HEATMAP coarse-middle subsampling applied
/// (the two end zones stay full-res; only the smooth long-ray middle is
/// strided). See [`CoarseMid`]. Rays with no real middle reduce to the exact
/// [`fill_t_values`] output, byte-for-byte.
pub fn fill_t_values_coarse_mid(dist_m: f64, buf: &mut Vec<f64>, cfg: CoarseMid) {
    fill_t_values_inner(dist_m, buf, Some(cfg));
}

fn fill_t_values_inner(dist_m: f64, buf: &mut Vec<f64>, coarse_mid: Option<CoarseMid>) {
    buf.clear();

    // Near-endpoint probe at 10m — only emitted when there's room (≥3×NEAR_OFFSET
    // so the probe doesn't collapse toward the midpoint). Skipped for paths
    // shorter than 30m.
    let emit_near = dist_m >= 3.0 * NEAR_OFFSET_M;
    let near_t = NEAR_OFFSET_M / dist_m;

    if dist_m <= CELL_M * 10.0 {
        // Short path: uniform stepping + optional 10m probe at each end. No
        // "middle" exists, so coarse_mid is a no-op here (the end zones cover it).
        let n = (dist_m / CELL_M).ceil().max(3.0) as usize;
        buf.push(0.0);
        if emit_near {
            buf.push(near_t);
        }
        for i in 1..n.saturating_sub(1) {
            let t = i as f64 / (n - 1) as f64;
            // Skip uniform sample if it's within 3m of a near-endpoint probe.
            if emit_near
                && ((t - near_t).abs() * dist_m < 3.0 || ((1.0 - t) - near_t).abs() * dist_m < 3.0)
            {
                continue;
            }
            buf.push(t);
        }
        if emit_near {
            buf.push(1.0 - near_t);
        }
        buf.push(1.0);
        buf.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        return;
    }

    buf.push(0.0);
    if emit_near {
        buf.push(near_t);
    }

    let levels = [CELL_M, CELL_M * 2.0, CELL_M * 4.0, CELL_M * 8.0];
    let reps = 3usize;

    // SURFACE-HEATMAP coarse-middle: the dense 10/30/60/120 m ramp is TRUNCATED
    // at the full-res zone (`src_zone_m`/`rx_zone_m`, ~200 m by owner design) and
    // the rest of the ray is coarse-filled at `mid_stride × 240 m`. Diffraction is
    // sharpest within ~200 m of either end (berms, near-receiver walls); beyond
    // that the single-edge δ is a smooth ramp the coarse step resolves. `None`
    // (popup / exact) keeps the full ramp out to its natural ~1.4 km end.
    let (src_zone_m, rx_zone_m, mid_stride) = match coarse_mid {
        Some(cm) if cm.mid_stride > 1 => (cm.src_zone_m, cm.rx_zone_m, cm.mid_stride),
        // stride ≤ 1 or no config ⇒ exact: no truncation, stride 1 (byte-identical).
        _ => (f64::INFINITY, f64::INFINITY, 1usize),
    };

    // Forward from source — ramp starts *after* the 10m near-probe so the
    // first ramp sample lands at 10 + 30 = 40m (vs. 30m before), which costs
    // nothing: we already have a sample at 10m. Stops at the full-res zone.
    // `last_fwd` tracks the last COMMITTED sample so the coarse fill bridges from
    // it (not from `pos`, which over-steps by one increment on the breaking step —
    // a zone-truncated ramp would otherwise leave a >coarse hole at the transition).
    let mut pos = if emit_near { NEAR_OFFSET_M } else { 0.0 };
    let mut last_fwd = pos;
    'fwd: for &step in &levels {
        for _ in 0..reps {
            pos += step;
            if pos >= dist_m * 0.5 || pos > src_zone_m {
                break 'fwd;
            }
            buf.push(pos / dist_m);
            last_fwd = pos;
        }
    }
    // Exact (no truncation): `pos` reaches the midpoint clamp; coarse: `last_fwd`
    // is the last pushed ramp sample. Both give a hole-free transition.
    let fwd_end = if src_zone_m.is_finite() {
        last_fwd / dist_m
    } else {
        pos.min(dist_m * 0.5) / dist_m
    };

    // Fill the middle (everything past both end zones) at the strided coarse step.
    let coarse = (levels[levels.len() - 1] * mid_stride as f64).min(dist_m * 0.25);
    // Backward ramp start as a t fraction (so the coarse fill stops there).
    let mut bpos = if emit_near { NEAR_OFFSET_M } else { 0.0 };
    'bw: for &step in &levels {
        for _ in 0..reps {
            let next = bpos + step;
            if next >= dist_m * 0.5 || next > rx_zone_m {
                break 'bw;
            }
            bpos = next;
        }
    }
    let bwd_start = (1.0 - bpos / dist_m).max(1.0 - dist_m * 0.5 / dist_m);
    let mut mid = fwd_end;
    while mid < bwd_start - 0.0001 {
        mid += coarse / dist_m;
        if mid < bwd_start - 1e-9 {
            buf.push(mid);
        }
    }

    // Backward from receiver (mirror of forward, reversed). Same zone truncation.
    let mut back_count = 0usize;
    pos = if emit_near { NEAR_OFFSET_M } else { 0.0 };
    'back: for &step in &levels {
        for _ in 0..reps {
            pos += step;
            if pos >= dist_m * 0.5 || pos > rx_zone_m {
                break 'back;
            }
            buf.push(1.0 - pos / dist_m);
            back_count += 1;
        }
    }
    let back_start = buf.len() - back_count;
    buf[back_start..].reverse();

    if emit_near {
        buf.push(1.0 - near_t);
    }
    buf.push(1.0);
    buf.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
}

/// Median of the inter-sample spacing in meters.
pub fn median_step_m(t: &[f64], dist_m: f64) -> f32 {
    if t.len() < 2 {
        return 0.0;
    }
    let mut steps: Vec<f64> = t.windows(2).map(|w| (w[1] - w[0]) * dist_m).collect();
    // Median only needs the mid-order statistic, not a full sort: select_nth is
    // O(n) and yields the identical element (steps[mid] is the same value a full
    // sort would place there).
    let mid = steps.len() / 2;
    steps.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap());
    steps[mid] as f32
}

/// Horizontal path length in meters from (lat1, lon1) to (lat2, lon2)
/// using the equirectangular approximation (matches pipeline convention).
pub fn path_dist_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let mid_lat_rad = ((lat1 + lat2) * 0.5).to_radians();
    let dlat = (lat2 - lat1) * crate::constants::M_PER_DEG_LAT;
    let dlon = (lon2 - lon1) * crate::constants::M_PER_DEG_LON_EQ * mid_lat_rad.cos();
    (dlat * dlat + dlon * dlon).sqrt()
}

/// Build a `PathProfile` using the default (per-point) sampler — calls
/// `elevation`/`building_height`/`ground_g` at each t individually. Overridden
/// by `RealRasters` and `FusedGrid` with tile-cache-friendly fused loops.
///
/// Kept as a free function so `RasterSampler` trait's default impl can call
/// into it without dragging unrelated trait state into the namespace.
pub fn build_default<R: RasterSampler + ?Sized>(
    rasters: &R,
    src_lat: f64,
    src_lon: f64,
    rcv_lat: f64,
    rcv_lon: f64,
    dist_m: f64,
    out: &mut PathProfile,
) {
    out.clear();
    out.dist_m = dist_m;
    out.src_lat = src_lat;
    out.src_lon = src_lon;
    out.rcv_lat = rcv_lat;
    out.rcv_lon = rcv_lon;

    fill_t_values(dist_m, &mut out.t);

    let n = out.t.len();
    out.elevation_m.reserve(n);
    out.building_h_m.reserve(n);
    out.forest_u8.reserve(n);
    out.imd_u8.reserve(n);

    for &t in &out.t {
        let lat = src_lat + t * (rcv_lat - src_lat);
        let lon = src_lon + t * (rcv_lon - src_lon);
        out.elevation_m.push(rasters.elevation(lat, lon) as f32);
        let bh = rasters.building_height(lat, lon).clamp(0.0, 255.0) as u8;
        out.building_h_m.push(bh);
        // ground_g is in 0..=1 range (1 − imd/100). Invert for imd_u8 storage.
        let imd = ((1.0 - rasters.ground_g(lat, lon).clamp(0.0, 1.0)) * 100.0).round() as u8;
        out.imd_u8.push(imd);
        // Default trait has no forest accessor; callers should override if they
        // care about vegetation — default impl stores 0 for all samples.
        out.forest_u8.push(0);
    }

    out.step_m_med = median_step_m(&out.t, dist_m);
}

/// Trapezoidal path integral of a `u8` array along `t`, returning the mean
/// value (0..=255). Interval-length-weighted — correct for non-uniform t.
pub fn path_integral_u8(t: &[f64], vals: &[u8], dist_m: f64) -> f64 {
    if t.len() < 2 || vals.len() < 2 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut total_len = 0.0;
    for i in 1..t.len() {
        let mid = 0.5 * (vals[i - 1] as f64 + vals[i] as f64);
        let len = (t[i] - t[i - 1]) * dist_m;
        sum += mid * len;
        total_len += len;
    }
    if total_len < 1e-9 {
        0.0
    } else {
        sum / total_len
    }
}

/// Cumulative run-length of contiguous `forest_u8 > 0` intervals, in meters.
/// Runs shorter than 10 m are discarded (matches pre-unification semantics).
pub fn vegetation_run_length(t: &[f64], forest: &[u8], dist_m: f64) -> f64 {
    if t.len() < 2 || forest.len() < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    let mut run = 0.0;
    for i in 1..t.len() {
        let len = (t[i] - t[i - 1]) * dist_m;
        // Forest if either endpoint is forested (inclusive — matches the
        // previous `self.pixel(lat_end, lon_end).forest > 0` convention).
        if forest[i] > 0 {
            run += len;
        } else {
            if run >= 10.0 {
                total += run;
            }
            run = 0.0;
        }
    }
    if run >= 10.0 {
        total += run;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Default surface-heatmap coarse-middle config: full-res within ~200 m of
    /// each end (per owner design), coarse far-field step ×2.
    fn default_coarse_mid() -> CoarseMid {
        CoarseMid {
            src_zone_m: 200.0,
            rx_zone_m: 200.0,
            mid_stride: 2,
        }
    }

    /// stride=1 (with INFINITY zones, as the kernel sets when disabled) is a no-op
    /// everywhere — the EXACT reference, byte-for-byte, on every distance.
    #[test]
    fn coarse_mid_stride_one_is_exact() {
        for &d in &[200.0, 400.0, 1000.0, 3000.0, 7000.0, 10_000.0] {
            let mut exact = Vec::new();
            fill_t_values(d, &mut exact);
            let mut coarse = Vec::new();
            fill_t_values_coarse_mid(
                d,
                &mut coarse,
                CoarseMid {
                    src_zone_m: f64::INFINITY,
                    rx_zone_m: f64::INFINITY,
                    mid_stride: 1,
                },
            );
            assert_eq!(exact, coarse, "d={d}: stride=1 must equal exact");
        }
    }

    /// The very-short uniform-stepping branch (≤ ~307 m) is untouched by the
    /// coarse-middle config — there is no ramp/middle to truncate.
    #[test]
    fn coarse_mid_short_uniform_branch_unchanged() {
        for &d in &[50.0, 150.0, 300.0] {
            let mut exact = Vec::new();
            fill_t_values(d, &mut exact);
            let mut coarse = Vec::new();
            fill_t_values_coarse_mid(d, &mut coarse, default_coarse_mid());
            assert_eq!(
                exact, coarse,
                "d={d}: short uniform branch must be unchanged"
            );
        }
    }

    /// The dense near-END samples WITHIN the full-res zone are preserved exactly
    /// (the berm / near-receiver-wall capture the owner's design protects), and
    /// the endpoints t=0/1 + 10 m near-probes are always present.
    #[test]
    fn coarse_mid_preserves_within_zone_samples() {
        let d = 10_000.0;
        let zone = 200.0;
        let mut coarse = Vec::new();
        fill_t_values_coarse_mid(
            d,
            &mut coarse,
            CoarseMid {
                src_zone_m: zone,
                rx_zone_m: zone,
                mid_stride: 2,
            },
        );
        assert_eq!(coarse[0], 0.0, "starts at source");
        assert!(
            (coarse.last().unwrap() - 1.0).abs() < 1e-9,
            "ends at receiver"
        );
        // 10 m near-probes at both ends.
        assert!(
            (coarse[1] * d - NEAR_OFFSET_M).abs() < 1.0,
            "near-source 10 m probe"
        );
        let n = coarse.len();
        assert!(
            ((1.0 - coarse[n - 2]) * d - NEAR_OFFSET_M).abs() < 1.0,
            "near-rx 10 m probe"
        );
        // The exact cadence's within-zone ramp samples (≤ zone m from source) all
        // appear in the coarse output (the dense near-field is untouched).
        let mut exact = Vec::new();
        fill_t_values(d, &mut exact);
        for &t in exact.iter().filter(|&&t| t * d <= zone) {
            assert!(
                coarse.iter().any(|&c| (c - t).abs() < 1e-9),
                "within-zone exact sample t={t} ({:.0} m) dropped",
                t * d
            );
        }
    }

    /// Far-field: monotone, every gap ≤ the strided coarse step, all in [0,1].
    #[test]
    fn coarse_mid_far_field_monotone_and_strided() {
        let d = 10_000.0;
        let mut coarse = Vec::new();
        fill_t_values_coarse_mid(d, &mut coarse, default_coarse_mid());
        let coarse_step_m = CELL_M * 8.0; // ~245 m
        for w in coarse.windows(2) {
            assert!(w[1] > w[0], "non-monotonic: {coarse:?}");
            let gap_m = (w[1] - w[0]) * d;
            assert!(
                gap_m <= 2.0 * coarse_step_m + 1.0,
                "gap {gap_m} m exceeds 2× coarse step"
            );
        }
    }

    /// Growing the full-res zone keeps MORE dense samples → MORE total samples;
    /// the default (~200 m) is the leanest, the exact (∞ zone) the densest.
    #[test]
    fn coarse_mid_zone_growth_adds_samples() {
        let d = 10_000.0;
        let mut exact = Vec::new();
        fill_t_values(d, &mut exact);
        let mut narrow = Vec::new(); // 200 m zone → leanest
        fill_t_values_coarse_mid(d, &mut narrow, default_coarse_mid());
        let mut wide = Vec::new(); // 800 m zone → keeps more ramp
        fill_t_values_coarse_mid(
            d,
            &mut wide,
            CoarseMid {
                src_zone_m: 800.0,
                rx_zone_m: 800.0,
                mid_stride: 2,
            },
        );
        assert!(
            narrow.len() < wide.len() && wide.len() < exact.len(),
            "narrow={} wide={} exact={}",
            narrow.len(),
            wide.len(),
            exact.len()
        );
    }

    #[test]
    fn fill_short_path_uniform() {
        let mut buf = Vec::new();
        fill_t_values(200.0, &mut buf);
        assert!(buf.first().copied().unwrap() == 0.0);
        assert!((*buf.last().unwrap() - 1.0).abs() < 1e-9);
        assert!(buf.len() >= 3);
        // Monotonic + first sample at 0, last at 1.
        for w in buf.windows(2) {
            assert!(w[1] > w[0], "non-monotonic: {:?}", buf);
        }
        // With 10 m near-probes, first gap is ≤ 10 m + tolerance.
        let first_gap_m = (buf[1] - buf[0]) * 200.0;
        assert!(
            first_gap_m <= NEAR_OFFSET_M + 1.0,
            "first gap ≤ 10m, got {first_gap_m}"
        );
    }

    #[test]
    fn fill_long_path_bilateral() {
        let mut buf = Vec::new();
        fill_t_values(5000.0, &mut buf);
        assert_eq!(buf[0], 0.0);
        assert!((*buf.last().unwrap() - 1.0).abs() < 1e-9);
        // First gap is the 10m near-probe.
        let first_gap = (buf[1] - buf[0]) * 5000.0;
        assert!(
            (first_gap - NEAR_OFFSET_M).abs() < 1.0,
            "first gap should be 10m near-probe, got {first_gap}"
        );
        // Last gap is symmetric.
        let last_gap = (*buf.last().unwrap() - buf[buf.len() - 2]) * 5000.0;
        assert!(
            (last_gap - NEAR_OFFSET_M).abs() < 1.0,
            "last gap should be 10m, got {last_gap}"
        );
        // Second gap (10m probe → first ramp sample) should be ≈ CELL_M (30m).
        let second_gap = (buf[2] - buf[1]) * 5000.0;
        assert!(
            (second_gap - CELL_M).abs() < 1.0,
            "second gap should be ~30m, got {second_gap}"
        );
    }

    #[test]
    fn near_probe_at_10m_from_both_ends() {
        for dist in &[50.0, 100.0, 300.0, 1000.0, 10_000.0] {
            let mut buf = Vec::new();
            fill_t_values(*dist, &mut buf);
            let first_probe_m = buf[1] * dist;
            let last_probe_m = (1.0 - buf[buf.len() - 2]) * dist;
            assert!(
                (first_probe_m - NEAR_OFFSET_M).abs() < 1.0,
                "D={dist}: near-source probe at {first_probe_m}m"
            );
            assert!(
                (last_probe_m - NEAR_OFFSET_M).abs() < 1.0,
                "D={dist}: near-receiver probe at {last_probe_m}m"
            );
        }
    }

    #[test]
    fn very_short_path_skips_near_probe() {
        // D < 3×NEAR_OFFSET (30 m) → no 10m probe, just uniform.
        let mut buf = Vec::new();
        fill_t_values(25.0, &mut buf);
        assert_eq!(buf[0], 0.0);
        assert!((*buf.last().unwrap() - 1.0).abs() < 1e-9);
        // No 10m probe at t ≈ 0.4 (10/25).
        let has_near = buf.iter().any(|&t| ((t * 25.0) - 10.0).abs() < 0.5);
        assert!(!has_near, "D=25m should not emit 10m probe, got {:?}", buf);
    }

    #[test]
    fn fill_very_long_path_fits_64() {
        // 10 km path: 24 endpoint samples + (10000 - 2×1200) / 240 ≈ 32 middle → ~55-58 total
        let mut buf = Vec::new();
        fill_t_values(10_000.0, &mut buf);
        assert!(
            buf.len() < 64,
            "10 km path must fit in 64-slot SmallVec, got {}",
            buf.len()
        );
    }

    #[test]
    fn integral_matches_simple_mean_on_uniform() {
        let t = vec![0.0, 0.25, 0.5, 0.75, 1.0];
        let vals = vec![10u8, 20, 30, 40, 50];
        let integral = path_integral_u8(&t, &vals, 1000.0);
        // Trapezoidal integral of linear ramp equals midpoint value = 30.
        assert!((integral - 30.0).abs() < 1e-6, "got {integral}");
    }

    #[test]
    fn integral_endpoint_not_oversampled() {
        // Non-uniform: samples bunched near start, one coarse middle gap.
        let t = vec![0.0, 0.03, 0.06, 0.1, 0.5, 0.9, 0.94, 0.97, 1.0];
        // Pure endpoint values = 100, middle = 0. Simple mean would be heavily
        // biased to endpoints; correct integral should be closer to zero because
        // the zero region dominates the path length.
        let vals = vec![100u8, 100, 100, 100, 0, 0, 100, 100, 100];
        let integral = path_integral_u8(&t, &vals, 1000.0);
        // Wide zero span (0.1..0.9) has length 800 m, positive edges total ≈
        // ~200 m. Integral should be on the order of 25, not the naive
        // unweighted mean of 66.7.
        assert!(
            integral < 40.0,
            "interval weighting should deprioritise endpoint cluster, got {integral}"
        );
    }

    #[test]
    fn veg_run_length_skips_short_runs() {
        // Steps: each 100 m, so interval lengths are 100 m.
        // Convention: an interval counts as forested when its END sample is >0.
        let t = vec![0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
        //   intervals: [0→1] [1→2] [2→3] [3→4] [4→5] [5→6] [6→7] [7→8] [8→9] [9→10]
        //   end-sample:  100   100   100    0     0    100   100   100    0     0
        //   runs:        ──── first run (3×100 = 300) ────    ── second run (3×100 = 300) ──
        let vals = vec![0u8, 100, 100, 100, 0, 0, 100, 100, 100, 0, 0];
        let total = vegetation_run_length(&t, &vals, 1000.0);
        assert!((total - 600.0).abs() < 1.0, "got {total}");
    }

    #[test]
    fn veg_run_length_drops_short_run_below_10m() {
        // A single 5-m forested interval should be dropped (threshold 10 m).
        let t = vec![0.0, 0.005, 0.01, 0.5, 1.0];
        let vals = vec![0u8, 100, 0, 100, 0];
        let total = vegetation_run_length(&t, &vals, 1000.0);
        // First run: interval [0→1] is 5 m with end=100 → only 5 m, under 10 → dropped
        // Second run: interval [2→3] (end=100) = 490 m, kept
        // Interval [3→4] end=0 → close; no further runs
        assert!((total - 490.0).abs() < 1.0, "got {total}");
    }
}
