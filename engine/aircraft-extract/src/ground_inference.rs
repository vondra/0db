//! Composite ground-flag inference. The raw ADS-B `on_ground` bit is
//! unreliable: jets at FL350 sometimes still report it, taxiing aircraft
//! sometimes don't. Trusting the raw bit produced 99 dB ground-source
//! ghosts at FL350 in v5.
//!
//! The composite layered inference:
//!   1. Rate-limits the raw bit (alt ≤ 600 ft, speed ≤ 140 kt,
//!      |baro_rate| ≤ 2 000 fpm) — otherwise reject as bogus.
//!   2. Edge-window scan recovers ground prefixes / suffixes that have
//!      NO raw bit set but match surface signatures (low alt + low
//!      speed + low baro_rate) for ≥ 3 consecutive points.
//!   3. The edge scan terminates on the first strongly-airborne sample
//!      (alt ≥ 500 ft OR speed ≥ 130 kt) so cruise points never get
//!      flipped to ground.
//!
//! Plan note (high-elevation airports): the raw `on_ground` gate uses
//! AGL-relative limits at the segment level — La Paz (≈ 4 000 m AMSL),
//! Lhasa, Quito sit above the absolute MSL alt floor, so the gate must
//! reject only when AGL is high. AGL is computed in Stage 1 and the
//! gate is applied there.

use crate::trace::TracePoint;

const SURFACE_EDGE_WINDOW_POINTS: usize = 32;
const SURFACE_MAX_ALT_FT: f32 = 220.0;
const SURFACE_MAX_SPEED_KT: f32 = 90.0;
const SURFACE_MAX_BARO_RATE_FPM: f32 = 1200.0;
const SURFACE_MIN_INFERRED_POINTS: usize = 3;
const SURFACE_EDGE_STRONG_AIRBORNE_ALT_FT: f32 = 500.0;
const SURFACE_EDGE_STRONG_AIRBORNE_SPEED_KT: f32 = 130.0;
const SURFACE_LOCAL_WINDOW: usize = 2;
const RAW_GROUND_FLAG_MAX_ALT_FT: f32 = 600.0;
const RAW_GROUND_FLAG_MAX_SPEED_KT: f32 = 140.0;
const RAW_GROUND_FLAG_MAX_BARO_RATE_FPM: f32 = 2000.0;

/// Per-point composite ground flag. Length matches `points`.
pub fn ground_flags(points: &[TracePoint]) -> Vec<bool> {
    let mut flags: Vec<bool> = points.iter().map(raw_ground_signal).collect();
    if points.len() < 2 {
        return flags;
    }
    infer_edge_ground(points, &mut flags, true);
    infer_edge_ground(points, &mut flags, false);
    flags
}

/// Raw on-ground signal: altitude-marker `"ground"` always wins; the
/// bitfield bit is gated against alt / speed / baro_rate so a jet at
/// FL350 still asserting `on_ground` doesn't get treated as one.
pub fn raw_ground_signal(pt: &TracePoint) -> bool {
    if pt.alt_is_ground() {
        return true;
    }
    pt.on_ground_raw()
        && pt.alt_ft <= RAW_GROUND_FLAG_MAX_ALT_FT
        && pt.speed_kt <= RAW_GROUND_FLAG_MAX_SPEED_KT
        && pt.baro_rate_fpm.abs() <= RAW_GROUND_FLAG_MAX_BARO_RATE_FPM
}

fn infer_edge_ground(points: &[TracePoint], flags: &mut [bool], is_prefix: bool) {
    let n = points.len();
    let edge_len = n.min(SURFACE_EDGE_WINDOW_POINTS);
    if edge_len == 0 {
        return;
    }
    let has_raw_ground = if is_prefix {
        flags[..edge_len].iter().any(|g| *g)
    } else {
        flags[n - edge_len..].iter().any(|g| *g)
    };

    let mut inferred = Vec::new();
    let mut seen_candidate = false;
    let mut misses_after_candidate = 0usize;
    let indices: Vec<usize> = if is_prefix {
        (0..edge_len).collect()
    } else {
        (n - edge_len..n).rev().collect()
    };
    for idx in indices {
        let candidate = flags[idx] || is_surface_candidate(points, idx);
        if candidate {
            seen_candidate = true;
            misses_after_candidate = 0;
            if !flags[idx] {
                inferred.push(idx);
            }
            continue;
        }
        if seen_candidate {
            misses_after_candidate += 1;
            if misses_after_candidate >= 2 {
                break;
            }
            continue;
        }
        let pt = &points[idx];
        if pt.alt_ft >= SURFACE_EDGE_STRONG_AIRBORNE_ALT_FT
            || pt.speed_kt >= SURFACE_EDGE_STRONG_AIRBORNE_SPEED_KT
        {
            break;
        }
    }
    if has_raw_ground || inferred.len() >= SURFACE_MIN_INFERRED_POINTS {
        for idx in inferred {
            flags[idx] = true;
        }
    }
}

fn is_surface_candidate(points: &[TracePoint], idx: usize) -> bool {
    let pt = &points[idx];
    if raw_ground_signal(pt) {
        return true;
    }
    if pt.alt_ft > SURFACE_MAX_ALT_FT
        || pt.speed_kt > SURFACE_MAX_SPEED_KT
        || pt.baro_rate_fpm.abs() > SURFACE_MAX_BARO_RATE_FPM
    {
        return false;
    }
    let lo = idx.saturating_sub(SURFACE_LOCAL_WINDOW);
    let hi = (idx + SURFACE_LOCAL_WINDOW + 1).min(points.len());
    let local_matches = points[lo..hi]
        .iter()
        .filter(|p| {
            raw_ground_signal(p)
                || (p.alt_ft <= SURFACE_MAX_ALT_FT
                    && p.speed_kt <= SURFACE_MAX_SPEED_KT
                    && p.baro_rate_fpm.abs() <= SURFACE_MAX_BARO_RATE_FPM)
        })
        .count();
    local_matches >= 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::FLAG_ON_GROUND_RAW;

    fn pt(alt_ft: f32, speed_kt: f32, baro: f32, raw_ground: bool) -> TracePoint {
        TracePoint {
            timestamp: 0.0,
            lat: 50.0,
            lon: 14.0,
            alt_ft,
            speed_kt,
            track_deg: 90.0,
            baro_rate_fpm: baro,
            flags: if raw_ground { FLAG_ON_GROUND_RAW } else { 0 },
        }
    }

    #[test]
    fn raw_signal_rejects_high_alt_jet_with_ground_bit() {
        // Jet at FL350 spuriously asserting on_ground — must NOT be treated as ground.
        let p = pt(35_000.0, 450.0, 0.0, true);
        assert!(!raw_ground_signal(&p));
    }

    #[test]
    fn raw_signal_accepts_taxi() {
        let p = pt(0.0, 15.0, 0.0, true);
        assert!(raw_ground_signal(&p));
    }

    #[test]
    fn edge_window_recovers_ground_prefix() {
        // 4 surface-ish points (no raw bit) followed by 4 airborne points.
        // Edge scan should flip the first 4 to ground because they form
        // a ≥ 3-point candidate run.
        let points = vec![
            pt(0.0, 8.0, 0.0, false),
            pt(0.0, 10.0, 0.0, false),
            pt(50.0, 12.0, 0.0, false),
            pt(100.0, 18.0, 0.0, false),
            pt(800.0, 200.0, 0.0, false),
            pt(2_000.0, 250.0, 0.0, false),
            pt(4_000.0, 280.0, 0.0, false),
            pt(8_000.0, 320.0, 0.0, false),
        ];
        let flags = ground_flags(&points);
        assert!(flags[0] && flags[1] && flags[2] && flags[3]);
        assert!(!flags[4]);
    }

    #[test]
    fn cruise_low_speed_burst_does_not_get_flipped_to_ground() {
        // Cruise sample with momentary speed dip — must stay airborne.
        let points = vec![
            pt(35_000.0, 450.0, 0.0, false),
            pt(35_000.0, 80.0, 0.0, false), // glitchy speed; not ground
            pt(35_000.0, 450.0, 0.0, false),
        ];
        let flags = ground_flags(&points);
        assert!(!flags[0] && !flags[1] && !flags[2]);
    }
}
