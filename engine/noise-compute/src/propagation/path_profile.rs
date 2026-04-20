//! Unified path sampler.
//!
//! A single bilateral cadence samples DEM, building height, forest cover and
//! ground-type along every source→receiver line: three probes at 30 m from each
//! end, then three at 60 m, three at 120 m, then 240 m steps until the middle.
//! Density is highest near source and receiver — where obstacles diffract sound
//! most severely — and coarsest in the middle, where a missed hill would still
//! lie well below the line of sight.
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
    /// `diffraction::compute_path_difference`). Grown on first use, reused
    /// across subsequent calls via `elevation_f64()`.
    pub elevation_f64_scratch: Vec<f64>,
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

/// Bilateral adaptive t-values for a path of `dist_m` meters.
///
/// Pattern (≥310 m paths): three samples at 30 m from each end, then three at
/// 60 m, three at 120 m, then 240 m steps through the middle, mirrored. Always
/// includes t=0.0 and t=1.0. Sample count for a 10 km path ≈ 54.
///
/// For short paths (≤10 cells ≈ 307 m) the cadence collapses to uniform 30 m
/// stepping so diffraction short-circuits don't lose precision.
///
/// Output buffer is cleared before writing.
pub fn fill_t_values(dist_m: f64, buf: &mut Vec<f64>) {
    buf.clear();

    if dist_m <= CELL_M * 10.0 {
        let n = (dist_m / CELL_M).ceil().max(3.0) as usize;
        for i in 0..n {
            buf.push(i as f64 / (n - 1).max(1) as f64);
        }
        return;
    }

    buf.push(0.0);

    let levels = [CELL_M, CELL_M * 2.0, CELL_M * 4.0, CELL_M * 8.0];
    let reps = 3usize;

    // Forward from source.
    let mut pos = 0.0_f64;
    for &step in &levels {
        for _ in 0..reps {
            pos += step;
            if pos >= dist_m * 0.5 {
                break;
            }
            buf.push(pos / dist_m);
        }
        if pos >= dist_m * 0.5 {
            break;
        }
    }
    let fwd_end = pos.min(dist_m * 0.5) / dist_m;

    // Fill middle with coarsest step.
    let coarse = levels[levels.len() - 1].min(dist_m * 0.25);
    let mut mid = fwd_end;
    let bwd_start_approx = 1.0 - fwd_end;
    while mid < bwd_start_approx - 0.0001 {
        mid += coarse / dist_m;
        if mid < bwd_start_approx {
            buf.push(mid);
        }
    }

    // Backward from receiver (mirror of forward, reversed).
    let mut back_count = 0usize;
    pos = 0.0;
    for &step in &levels {
        for _ in 0..reps {
            pos += step;
            if pos >= dist_m * 0.5 {
                break;
            }
            buf.push(1.0 - pos / dist_m);
            back_count += 1;
        }
        if pos >= dist_m * 0.5 {
            break;
        }
    }
    let back_start = buf.len() - back_count;
    buf[back_start..].reverse();

    buf.push(1.0);
    buf.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
}

/// Median of the inter-sample spacing in meters.
pub fn median_step_m(t: &[f64], dist_m: f64) -> f32 {
    if t.len() < 2 {
        return 0.0;
    }
    let mut steps: Vec<f64> = t.windows(2).map(|w| (w[1] - w[0]) * dist_m).collect();
    steps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    steps[steps.len() / 2] as f32
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

    #[test]
    fn fill_short_path_uniform() {
        let mut buf = Vec::new();
        fill_t_values(200.0, &mut buf);
        assert!(buf.first().copied().unwrap() == 0.0);
        assert!((*buf.last().unwrap() - 1.0).abs() < 1e-9);
        assert!(buf.len() >= 3);
        // Uniform: consecutive diffs are equal.
        let d0 = buf[1] - buf[0];
        for w in buf.windows(2) {
            assert!((w[1] - w[0] - d0).abs() < 1e-9);
        }
    }

    #[test]
    fn fill_long_path_bilateral() {
        let mut buf = Vec::new();
        fill_t_values(5000.0, &mut buf);
        assert_eq!(buf[0], 0.0);
        assert!((*buf.last().unwrap() - 1.0).abs() < 1e-9);
        // First two gaps should be CELL_M (≈30 m / 5000 ≈ 0.006).
        let first_gap = (buf[1] - buf[0]) * 5000.0;
        assert!((first_gap - CELL_M).abs() < 1.0, "first gap ~30m, got {first_gap}");
        // Last two gaps should also be CELL_M (symmetric).
        let last_gap = (*buf.last().unwrap() - buf[buf.len() - 2]) * 5000.0;
        assert!((last_gap - CELL_M).abs() < 1.0, "last gap ~30m, got {last_gap}");
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
