//! Receiver-INDEPENDENT filters — the single source of truth for which
//! ADS-B points and segments contribute to the v6 popup arrows.
//!
//! Filter D (per-receiver terrain extrapolation invalidation, see
//! `noise-compute::emission::aircraft::{...}`) is *receiver-dependent*
//! and stays in the popup kernel. Everything here can be applied at
//! extraction time so the popup hot path doesn't repeat the work.
//!
//! Layered pipeline:
//!   * [`point_is_sane`] — per-point structural sanity (Stage 0).
//!   * [`validate_flight_trajectory`] — trajectory-aware truncation that
//!     drops the bogus tail of a widebody descending into terrain
//!     instead of dropping segments one-by-one (Stage 1, post-DEM AGL).
//!   * [`segment_is_keepable`] — per-segment sanity (Stage 1, post-segmentation).
//!
//! Anonymous ICAOs (`0xFFFFFF` reserved or zero) are NOT dropped —
//! Stage 0 instead packs a synthetic `flight_id` via
//! [`noise_compute::flight_id::pack_synth`] keyed on the typecode and
//! first-point seed, so anonymous traffic still contributes noise.

use crate::trace::TracePoint;

/// 4× the combined error envelope of barometric altitude (~50 m) +
/// Copernicus DEM (~30 m) + transient pressure offsets (~50 m). Below
/// this we treat the whole tail as fabricated rather than try to rescue
/// individual points — the popup's previous filter D dropped only the
/// underground sub-segment and let the bogus low-AGL approach segments
/// preceding it leak ~65–75 dB of false noise.
pub const HARD_AGL_FLOOR_M: f32 = -300.0;

/// Lossy de-icing / pull-up regimes hit ~6 000 fpm. Sustained anomalies
/// at 8 000 fpm are not real flight; they are the receiver tracking
/// secondary radar returns into the ground after the aircraft is gone.
pub const ANOMALY_DESCENT_RATE_FPM: f32 = 8_000.0;

/// Number of consecutive samples meeting [`ANOMALY_DESCENT_RATE_FPM`]
/// before the trajectory is treated as compromised. Three samples at
/// adsb.lol's median 5 s cadence is ~15 s of sustained descent.
pub const ANOMALY_SUSTAINED_SAMPLES: usize = 3;

/// Minimum credible segment length. Anything shorter is a taxi remnant
/// — keeping it skews the rep_line for ground-ops sub-buckets.
pub const MIN_SEGMENT_LENGTH_M: f32 = 10.0;

/// Maximum credible segment length. Long sparse cadence produces a
/// straight line through the terrain that wasn't actually flown.
pub const MAX_SEGMENT_LENGTH_M: f32 = 50_000.0;

/// Below this airspeed a fixed-wing jet is not flying — drop the
/// segment so the airborne energy isn't anchored on a stalled trace.
pub const JET_STALL_SPEED_KT: f32 = 80.0;

/// Maximum credible barometric altitude in feet above MSL. Concorde's
/// service ceiling was 60 000 ft; this is +10 kft of headroom for
/// extreme high-altitude ferry. Beyond is corrupt data.
pub const MAX_PLAUSIBLE_ALT_FT: f32 = 70_000.0;

/// Minimum credible barometric altitude in feet. Subsea-level
/// aerodromes (Bet She'an, Schiphol) report negative; -2000 covers them
/// with margin against pressure-offset glitches.
pub const MIN_PLAUSIBLE_ALT_FT: f32 = -2_000.0;

/// Sustained physical maximum speed for any aircraft (Mach 3 at FL600
/// ≈ 1700 kt). Above is wildly bad data.
pub const MAX_PLAUSIBLE_SPEED_KT: f32 = 1_500.0;

/// Per-point sanity. Drops NaNs, out-of-range coordinates, the (0,0)
/// "no-fix" sentinel, implausible altitudes (when not on the ground),
/// and impossibly fast vehicles.
#[inline]
pub fn point_is_sane(pt: &TracePoint) -> bool {
    if !pt.lat.is_finite() || !pt.lon.is_finite() || !pt.alt_ft.is_finite() {
        return false;
    }
    if pt.lat.abs() > 90.0 || pt.lon.abs() > 180.0 {
        return false;
    }
    if pt.lat == 0.0 && pt.lon == 0.0 {
        return false;
    }
    if !pt.alt_is_ground() && (pt.alt_ft < MIN_PLAUSIBLE_ALT_FT || pt.alt_ft > MAX_PLAUSIBLE_ALT_FT) {
        return false;
    }
    if pt.speed_kt > MAX_PLAUSIBLE_SPEED_KT {
        return false;
    }
    true
}

/// Truncate `points` (and the parallel `agl_m` view) at the first point
/// where the trajectory becomes implausible — either the AGL drops
/// below [`HARD_AGL_FLOOR_M`] or a sustained-descent run of
/// [`ANOMALY_SUSTAINED_SAMPLES`] points exceeds
/// [`ANOMALY_DESCENT_RATE_FPM`]. After truncation, also drops
/// teleport-style outliers (>10 000 ft jump or >1 500 kt apparent speed
/// over <10 s).
///
/// Trajectory-level fix per plan: a per-segment filter would drop only
/// the underground sub-segment, leaving the fabricated approach
/// segments before it. Truncating the whole tail eliminates the leak.
pub fn validate_flight_trajectory(points: &mut Vec<TracePoint>, agl_m: &mut Vec<f32>) {
    debug_assert_eq!(points.len(), agl_m.len());
    let underground = agl_m.iter().position(|&a| a < HARD_AGL_FLOOR_M);
    let descent = scan_for_sustained_descent(points);
    let cut = match (underground, descent) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    if let Some(idx) = cut {
        let keep = backtrack_to_last_credible(points, agl_m, idx);
        points.truncate(keep);
        agl_m.truncate(keep);
    }
    drop_teleport_points(points, agl_m);
}

fn scan_for_sustained_descent(points: &[TracePoint]) -> Option<usize> {
    if points.len() < ANOMALY_SUSTAINED_SAMPLES + 1 {
        return None;
    }
    let mut run = 0usize;
    let mut start = 0usize;
    for (i, pt) in points.iter().enumerate() {
        // baro_rate_fpm is signed: negative = descending.
        if pt.baro_rate_fpm < -ANOMALY_DESCENT_RATE_FPM {
            if run == 0 {
                start = i;
            }
            run += 1;
            if run >= ANOMALY_SUSTAINED_SAMPLES {
                return Some(start);
            }
        } else {
            run = 0;
        }
    }
    None
}

fn backtrack_to_last_credible(
    points: &[TracePoint],
    agl_m: &[f32],
    anomaly_idx: usize,
) -> usize {
    // Walk back to the last point whose AGL is comfortably above the
    // floor (>= 0 m) — the descent that LED to the anomaly may have
    // been fabricated for several samples before crossing the floor.
    let mut idx = anomaly_idx;
    while idx > 0 && agl_m[idx - 1] < 0.0 {
        idx -= 1;
    }
    idx.min(points.len())
}

fn drop_teleport_points(points: &mut Vec<TracePoint>, agl_m: &mut Vec<f32>) {
    if points.len() < 2 {
        return;
    }
    let mut keep_idx = vec![true; points.len()];
    for i in 1..points.len() {
        let dt = (points[i].timestamp - points[i - 1].timestamp).abs() as f32;
        if dt > 0.0 && dt < 10.0 {
            let d_alt = (points[i].alt_ft - points[i - 1].alt_ft).abs();
            // Implied horizontal speed via the local-flat formula —
            // we only need a coarse upper bound to flag teleports.
            let dx_deg = points[i].lon - points[i - 1].lon;
            let dy_deg = points[i].lat - points[i - 1].lat;
            let cos_lat = ((points[i].lat as f64).to_radians().cos()) as f32;
            let dx_m = dx_deg * 111_320.0 * cos_lat;
            let dy_m = dy_deg * 110_540.0;
            let dist_m = (dx_m * dx_m + dy_m * dy_m).sqrt();
            let kt = dist_m / dt * (3600.0 / 1852.0);
            if d_alt > 10_000.0 || kt > 1_500.0 {
                keep_idx[i] = false;
            }
        }
    }
    let mut j = 0;
    for i in 0..points.len() {
        if keep_idx[i] {
            if j != i {
                points.swap(j, i);
                agl_m.swap(j, i);
            }
            j += 1;
        }
    }
    points.truncate(j);
    agl_m.truncate(j);
}

/// Per-segment receiver-independent filter. `length_m` is the segment
/// arc length in metres; `start_agl_m` / `end_agl_m` are post-DEM AGL.
/// `is_airborne` reflects the classified phase (Airborne or Cruise).
pub fn segment_is_keepable(
    length_m: f32,
    start_agl_m: f32,
    end_agl_m: f32,
    avg_speed_kt: f32,
    profile_idx: u8,
    is_airborne: bool,
) -> bool {
    if start_agl_m.min(end_agl_m) < HARD_AGL_FLOOR_M {
        return false;
    }
    if length_m < MIN_SEGMENT_LENGTH_M || length_m > MAX_SEGMENT_LENGTH_M {
        return false;
    }
    if is_airborne
        && noise_compute::emission::aircraft::is_jet_profile(profile_idx)
        && avg_speed_kt < JET_STALL_SPEED_KT
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(ts: f64, lat: f32, lon: f32, alt_ft: f32, baro: f32, flags: u8) -> TracePoint {
        TracePoint {
            timestamp: ts,
            lat,
            lon,
            alt_ft,
            speed_kt: 250.0,
            track_deg: 90.0,
            baro_rate_fpm: baro,
            flags,
        }
    }

    #[test]
    fn point_is_sane_drops_zero_lat_lon() {
        let p = pt(0.0, 0.0, 0.0, 1000.0, 0.0, 0);
        assert!(!point_is_sane(&p));
    }

    #[test]
    fn point_is_sane_drops_huge_altitude_when_airborne() {
        let p = pt(0.0, 50.0, 14.0, 80_000.0, 0.0, 0);
        assert!(!point_is_sane(&p));
    }

    #[test]
    fn point_is_sane_keeps_subsea_aerodrome_when_on_ground() {
        // Dead Sea / Bet She'an — alt < 0 is real on the ground.
        let p = pt(
            0.0, 32.5, 35.5, 0.0, 0.0,
            crate::trace::FLAG_ALT_IS_GROUND | crate::trace::FLAG_ON_GROUND_RAW,
        );
        assert!(point_is_sane(&p));
    }

    #[test]
    fn point_is_sane_drops_nan() {
        let p = pt(0.0, f32::NAN, 14.0, 1000.0, 0.0, 0);
        assert!(!point_is_sane(&p));
    }

    #[test]
    fn validate_truncates_at_underground_anomaly() {
        let mut points = vec![
            pt(0.0, 50.0, 14.0, 5000.0, 0.0, 0),
            pt(5.0, 50.001, 14.001, 4000.0, 0.0, 0),
            pt(10.0, 50.002, 14.002, 3000.0, 0.0, 0),
            pt(15.0, 50.003, 14.003, 0.0, 0.0, 0), // start of fake tail
            pt(20.0, 50.004, 14.004, -5000.0, 0.0, 0),
        ];
        // Synthetic AGL: last two points underground.
        let mut agl = vec![1500.0, 1000.0, 800.0, -100.0, -500.0];
        validate_flight_trajectory(&mut points, &mut agl);
        // Cuts at the first agl < HARD_AGL_FLOOR (-300m), which is
        // index 4 (the -500 point). Backtracks through index 3 (-100 m
        // is also negative) to keep index 3 only if AGL >= 0. Here
        // index 2 has 800m → keep first 3 points.
        assert_eq!(points.len(), 3);
        assert_eq!(agl.len(), 3);
    }

    #[test]
    fn validate_truncates_at_sustained_descent() {
        let mut points = vec![
            pt(0.0, 50.0, 14.0, 5000.0, -1000.0, 0),
            pt(5.0, 50.001, 14.001, 4500.0, -8500.0, 0),
            pt(10.0, 50.002, 14.002, 4000.0, -9000.0, 0),
            pt(15.0, 50.003, 14.003, 3500.0, -8500.0, 0),
            pt(20.0, 50.004, 14.004, 3000.0, -8500.0, 0),
        ];
        let mut agl = vec![1500.0, 1000.0, 600.0, 200.0, 100.0];
        validate_flight_trajectory(&mut points, &mut agl);
        assert!(points.len() <= 1, "got {}", points.len());
    }

    #[test]
    fn validate_drops_teleport_jump() {
        let mut points = vec![
            pt(0.0, 50.0, 14.0, 5000.0, 0.0, 0),
            pt(5.0, 50.0, 14.0, 5500.0, 0.0, 0),
            pt(7.0, 70.0, 30.0, 5500.0, 0.0, 0), // teleport
            pt(12.0, 70.001, 30.001, 5500.0, 0.0, 0),
        ];
        let mut agl = vec![1500.0, 1500.0, 1500.0, 1500.0];
        validate_flight_trajectory(&mut points, &mut agl);
        assert_eq!(points.len(), 3);
    }

    #[test]
    fn segment_is_keepable_rejects_short_taxi_remnant() {
        assert!(!segment_is_keepable(5.0, 0.0, 0.0, 250.0, 0, true));
    }

    #[test]
    fn segment_is_keepable_rejects_sparse_50km_gap() {
        assert!(!segment_is_keepable(60_000.0, 0.0, 0.0, 250.0, 0, true));
    }

    #[test]
    fn segment_is_keepable_rejects_underground() {
        assert!(!segment_is_keepable(1000.0, -500.0, -400.0, 250.0, 0, true));
    }

    #[test]
    fn segment_is_keepable_keeps_sane_jet_segment() {
        assert!(segment_is_keepable(1000.0, 100.0, 200.0, 250.0, 0, true));
    }
}
