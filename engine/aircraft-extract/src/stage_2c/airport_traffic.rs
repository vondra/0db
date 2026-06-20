//! Polyline-to-polyline projection: each ADS-B leg is distributed
//! across the OSM airport-line microsegments it overlaps within
//! `max_perp_m` perpendicular distance. Geometric kernel only — the
//! Stage 2C aggregator wires this into the counter pipeline.
//!
//! ## Why polyline-to-polyline, not snap-to-nearest
//!
//! A 500 m taxi leg crossing 10 × 50 m taxiway microsegments would
//! produce 1 row in a snap-to-nearest scheme (all emission compressed
//! to one segment). Distributing length proportionally keeps the
//! acoustic energy spatially smooth across the taxiway and matches
//! how a continuous taxi sounds to a downrange receiver.
//!
//! ## Geometric model
//!
//! Each OSM microsegment `S` (typically 50-250 m, CNOSSOS Annex II
//! microsegmentation) is buffered by `max_perp_m` perpendicular to
//! its axis, forming a rectangle of half-width `max_perp_m` along
//! its length. The portion of leg `L = (L1, L2)` lying inside this
//! rectangle is the "overlap" — its length contributes to the
//! segment's `band_energy_lin` counter.
//!
//! Coordinates are flat-Earth at the segment midpoint latitude.
//! Antimeridian / pole crossings are out of scope (airports don't
//! sit there). At microsegment scale (≤ 250 m) flat-Earth error is
//! sub-millimeter.

use crate::geo::{flat_dist, M_PER_DEG_LAT, M_PER_DEG_LON_EQUATOR};

/// Perpendicular buffer used by [`project_leg_onto_airport_lines`] to
/// decide whether an ADS-B leg snapped onto an OSM aeroway. Stage 2C
/// projects every ground leg against the real OSM lines using this
/// value; Stage 1.5 (`stage_airport_discover_runner.rs`) inverts the
/// snap to find OSM-missing candidates and must use the SAME buffer
/// — a vertex Stage 2C would have snapped to must not feed DBSCAN.
pub(crate) const AIRPORT_LINE_SNAP_BUFFER_M: f32 = 50.0;

/// Minimal view into one airport_lines.arrow row — enough to do
/// projection geometry plus the per-row metadata the aggregator needs
/// without re-reading the source Arrow. Geometry coords drive
/// `clipped_overlap_m`; `length_m`/`aeroway_type` ride through for
/// the writer.
#[derive(Clone, Copy, Debug)]
pub struct AirportLineSegment {
    pub osm_id: u64,
    pub segment_idx: u16,
    pub start_lat: f32,
    pub start_lon: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    /// Carried through from airport_lines.arrow for downstream rows
    /// (`airport_traffic.length_m`). NOT consulted inside the kernel
    /// — `clipped_overlap_m` recomputes from coords so the local u/v
    /// basis stays consistent with the cached length.
    pub length_m: f32,
    /// OSM aeroway encoding (0=runway, 1=taxiway, 6=stopway, 7=airstrip,
    /// else apron/parking/heliport/gate). The aggregator uses it to
    /// derive `ops_kind` without re-reading the source Arrow row.
    pub aeroway_type: u8,
}

/// One ADS-B leg → one OSM microsegment overlap.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(test, derive(PartialEq))]
pub struct LegIntersection {
    pub osm_id: u64,
    pub segment_idx: u16,
    /// Length of the leg's intersection with the segment's
    /// max-perp buffer rectangle, in meters. Bounded by `leg_len_m`.
    pub length_within_segment_m: f32,
}

/// Project one leg onto all candidate airport-line microsegments,
/// returning the per-segment overlap length. Candidates are typically
/// pre-filtered upstream by a bounding-box / H3 index so this loop
/// runs over O(10-100) segments per leg, not the global airport list.
///
/// **Energy conservation:** when two OSM segments are within
/// `2 * max_perp_m` of each other (parallel taxiways close together),
/// the raw clipped overlap can exceed the leg length on both segments
/// simultaneously. That would double-count the aircraft's acoustic
/// contribution and bias Leq up by ~3 dB on the overlap patch. The
/// kernel resolves this by normalizing: if `Σ raw_overlap > leg_len`,
/// every overlap is scaled by `leg_len / Σ raw_overlap` so the total
/// matches the leg length exactly. Treats the situation as spatial
/// uncertainty between adjacent segments rather than two physically
/// independent sources.
pub fn project_leg_onto_airport_lines(
    leg_start_lat: f32,
    leg_start_lon: f32,
    leg_end_lat: f32,
    leg_end_lon: f32,
    candidates: &[AirportLineSegment],
    max_perp_m: f32,
) -> Vec<LegIntersection> {
    let leg_len_m = flat_dist(leg_start_lat, leg_start_lon, leg_end_lat, leg_end_lon);
    let mut out = Vec::with_capacity(candidates.len().min(8));
    let mut total: f32 = 0.0;
    for seg in candidates {
        let overlap = clipped_overlap_m(
            leg_start_lat,
            leg_start_lon,
            leg_end_lat,
            leg_end_lon,
            seg,
            max_perp_m,
        );
        if overlap > 0.0 {
            total += overlap;
            out.push(LegIntersection {
                osm_id: seg.osm_id,
                segment_idx: seg.segment_idx,
                length_within_segment_m: overlap,
            });
        }
    }
    if total > leg_len_m && total > 0.0 {
        let scale = leg_len_m / total;
        for h in out.iter_mut() {
            h.length_within_segment_m *= scale;
        }
    }
    out
}

/// Length of the leg `L1→L2` lying within the `max_perp_m` buffer of
/// segment `seg`. 0 when no overlap.
///
/// Algorithm:
/// 1. Build a local meter frame at the segment midpoint where the
///    segment is along the +x axis, length 2·s_half.
/// 2. Project L1, L2 into this frame.
/// 3. Liang-Barsky clip the leg parametric line against the rectangle
///    x ∈ [-s_half, +s_half], y ∈ [-max_perp_m, +max_perp_m].
/// 4. Return (t_max - t_min) · leg_len_m.
fn clipped_overlap_m(
    l1_lat: f32,
    l1_lon: f32,
    l2_lat: f32,
    l2_lon: f32,
    seg: &AirportLineSegment,
    max_perp_m: f32,
) -> f32 {
    let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
    // OSM aeroway microsegments are ≤ 250 m and no real airport
    // straddles 180°E/W. Bail out on a wrapped seg rather than
    // silently producing midpoint-of-nowhere (Fiji/Midway-style).
    if (seg.end_lon - seg.start_lon).abs() > 1.0 {
        return 0.0;
    }
    let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
    let cos_lat = (mid_lat as f64).to_radians().cos() as f32;
    let m_per_deg_lon = M_PER_DEG_LON_EQUATOR * cos_lat;

    // Segment vector in (east_m, north_m).
    let seg_dx_m = (seg.end_lon - seg.start_lon) * m_per_deg_lon;
    let seg_dy_m = (seg.end_lat - seg.start_lat) * M_PER_DEG_LAT;
    let seg_len_m = (seg_dx_m * seg_dx_m + seg_dy_m * seg_dy_m).sqrt();
    // Guard against NaN/inf coordinates and sub-millimeter degenerate
    // segments — both would propagate to garbage clipping results.
    if !seg_len_m.is_finite() || seg_len_m < 1e-3 {
        return 0.0;
    }
    let s_half = seg_len_m * 0.5;
    let inv_len = 1.0 / seg_len_m;
    // u = unit vector along the segment (east_m, north_m components).
    // v = perpendicular, 90° CCW from u in the east-north plane.
    let u_e = seg_dx_m * inv_len;
    let u_n = seg_dy_m * inv_len;
    let v_e = -u_n;
    let v_n = u_e;

    let to_local = |lat: f32, lon: f32| -> (f32, f32) {
        let dlon_m = (lon - mid_lon) * m_per_deg_lon;
        let dlat_m = (lat - mid_lat) * M_PER_DEG_LAT;
        let x = dlon_m * u_e + dlat_m * u_n;
        let y = dlon_m * v_e + dlat_m * v_n;
        (x, y)
    };

    let (l1x, l1y) = to_local(l1_lat, l1_lon);
    let (l2x, l2y) = to_local(l2_lat, l2_lon);
    let leg_dx = l2x - l1x;
    let leg_dy = l2y - l1y;
    let leg_len_m = (leg_dx * leg_dx + leg_dy * leg_dy).sqrt();
    if !leg_len_m.is_finite() || leg_len_m < 1e-3 {
        return 0.0;
    }

    // Liang-Barsky parametric clip. t ∈ [t_min, t_max] is the slice
    // of the leg inside the rectangle. p · q encodes each edge:
    //   p < 0 → ray entering through this edge (update t_min)
    //   p > 0 → ray leaving through this edge (update t_max)
    //   p == 0 && q < 0 → fully outside parallel to this edge
    let mut t_min = 0.0f32;
    let mut t_max = 1.0f32;
    let pq = [
        (-leg_dx, l1x + s_half),     // left edge x = -s_half
        (leg_dx, s_half - l1x),      // right edge x = +s_half
        (-leg_dy, l1y + max_perp_m), // bottom edge y = -max_perp_m
        (leg_dy, max_perp_m - l1y),  // top edge y = +max_perp_m
    ];
    for (p, q) in pq {
        // 1e-6 m is below the noise floor of the (lat,lon)→meter
        // propagation at airport-scale input precision — a leg whose
        // along-this-axis component is below this is treated as
        // parallel to that edge.
        if p.abs() < 1e-6 {
            if q < 0.0 {
                return 0.0;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t_max {
                    return 0.0;
                }
                if r > t_min {
                    t_min = r;
                }
            } else {
                if r < t_min {
                    return 0.0;
                }
                if r < t_max {
                    t_max = r;
                }
            }
        }
    }
    if t_max <= t_min {
        return 0.0;
    }
    (t_max - t_min) * leg_len_m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(
        osm_id: u64,
        segment_idx: u16,
        sla: f32,
        slo: f32,
        ela: f32,
        elo: f32,
    ) -> AirportLineSegment {
        AirportLineSegment {
            osm_id,
            segment_idx,
            start_lat: sla,
            start_lon: slo,
            end_lat: ela,
            end_lon: elo,
            length_m: flat_dist(sla, slo, ela, elo),
            aeroway_type: 1, // taxi default for projection tests
        }
    }

    #[test]
    fn leg_parallel_to_segment_fully_inside_buffer_returns_leg_length() {
        // Leg overlays segment exactly (both ~250 m, same line).
        let s = segment(1, 0, 50.105, 14.255, 50.106, 14.258);
        let out = project_leg_onto_airport_lines(
            s.start_lat,
            s.start_lon,
            s.end_lat,
            s.end_lon,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1);
        let leg_len = flat_dist(s.start_lat, s.start_lon, s.end_lat, s.end_lon);
        assert!(
            (out[0].length_within_segment_m - leg_len).abs() < 0.5,
            "expected ~{leg_len} m, got {}",
            out[0].length_within_segment_m
        );
    }

    #[test]
    fn leg_far_from_segment_returns_zero() {
        // Leg is 1 km north of the segment (50.110 vs 50.105 ≈ 553 m).
        let s = segment(1, 0, 50.105, 14.255, 50.106, 14.258);
        let out = project_leg_onto_airport_lines(50.115, 14.255, 50.116, 14.258, &[s], 50.0);
        assert!(out.is_empty(), "leg far above should not overlap");
    }

    #[test]
    fn leg_perpendicular_crossing_returns_short_overlap() {
        // Segment east-west; leg perpendicular through midpoint.
        // Buffer is 50 m wide perpendicular, so a perpendicular leg
        // that crosses the segment ON-axis spans the full 100 m
        // perp-buffer height (-50..+50 m).
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        // Leg from south to north through the segment midpoint.
        let mid_lat = (s.start_lat + s.end_lat) * 0.5;
        let mid_lon = (s.start_lon + s.end_lon) * 0.5;
        let north_offset_m = 100.0;
        let dlat = north_offset_m / M_PER_DEG_LAT;
        let out = project_leg_onto_airport_lines(
            mid_lat - dlat,
            mid_lon,
            mid_lat + dlat,
            mid_lon,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1);
        assert!(
            (out[0].length_within_segment_m - 100.0).abs() < 1.0,
            "expected ~100 m perpendicular overlap, got {}",
            out[0].length_within_segment_m
        );
    }

    #[test]
    fn leg_partially_outside_segment_clipped_at_endpoint() {
        // Segment along latitude 50.105 from lon 14.250 to 14.260
        // (~715 m east-west at 50°N). Leg starts 100 m before the
        // west end and runs 100 m past it on-axis. Overlap should
        // be ~100 m (only the inside half).
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let cos50 = (50.105f32.to_radians()).cos();
        let dlon_100m = 100.0 / (M_PER_DEG_LON_EQUATOR * cos50);
        let out = project_leg_onto_airport_lines(
            50.105,
            s.start_lon - dlon_100m,
            50.105,
            s.start_lon + dlon_100m,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1);
        assert!(
            (out[0].length_within_segment_m - 100.0).abs() < 1.0,
            "expected ~100 m on-axis overlap inside the segment, got {}",
            out[0].length_within_segment_m
        );
    }

    #[test]
    fn leg_offset_within_buffer_returns_leg_length() {
        // Leg parallel to segment, offset by 30 m (< 50 m max_perp).
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let dlat_30m = 30.0 / M_PER_DEG_LAT;
        let out = project_leg_onto_airport_lines(
            50.105 + dlat_30m,
            14.252,
            50.105 + dlat_30m,
            14.258,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1);
        let expected = flat_dist(50.105, 14.252, 50.105, 14.258);
        assert!(
            (out[0].length_within_segment_m - expected).abs() < 0.5,
            "30 m parallel offset should not reduce overlap; expected {expected}, got {}",
            out[0].length_within_segment_m
        );
    }

    #[test]
    fn leg_offset_beyond_buffer_returns_zero() {
        // Leg parallel to segment, offset by 60 m (> 50 m max_perp).
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let dlat_60m = 60.0 / M_PER_DEG_LAT;
        let out = project_leg_onto_airport_lines(
            50.105 + dlat_60m,
            14.252,
            50.105 + dlat_60m,
            14.258,
            &[s],
            50.0,
        );
        assert!(out.is_empty(), "60 m perpendicular offset > 50 m max_perp");
    }

    #[test]
    fn leg_crossing_multiple_segments_distributes_length() {
        // Three abutting east-west segments, leg runs through all three.
        let s1 = segment(1, 0, 50.105, 14.250, 50.105, 14.253);
        let s2 = segment(1, 1, 50.105, 14.253, 50.105, 14.256);
        let s3 = segment(1, 2, 50.105, 14.256, 50.105, 14.259);
        let out =
            project_leg_onto_airport_lines(50.105, 14.250, 50.105, 14.259, &[s1, s2, s3], 50.0);
        assert_eq!(out.len(), 3, "leg should hit all three segments");
        let total: f32 = out.iter().map(|h| h.length_within_segment_m).sum();
        let leg_len = flat_dist(50.105, 14.250, 50.105, 14.259);
        // Sum across the three abutting segments ≈ leg length within
        // ~1 m due to flat-Earth + clip rounding.
        assert!(
            (total - leg_len).abs() < 2.0,
            "expected sum ~{leg_len}, got {total}"
        );
    }

    #[test]
    fn degenerate_zero_length_segment_skipped() {
        let s = segment(1, 0, 50.105, 14.255, 50.105, 14.255);
        let out = project_leg_onto_airport_lines(50.105, 14.255, 50.106, 14.258, &[s], 50.0);
        assert!(out.is_empty(), "zero-length seg must produce no overlap");
    }

    #[test]
    fn degenerate_zero_length_leg_returns_no_overlap() {
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let out = project_leg_onto_airport_lines(50.105, 14.255, 50.105, 14.255, &[s], 50.0);
        assert!(out.is_empty(), "point leg must produce no overlap");
    }

    #[test]
    fn parallel_adjacent_taxiways_normalized_to_leg_length() {
        // Two parallel east-west "taxiways" 80 m apart, both within
        // 2 * max_perp_m (100 m) of a leg running halfway between them
        // (40 m from each). Pre-2.3b-fix: both segs would return full
        // overlap → total = 2 * leg_len. Post-fix: normalization scales
        // each to half so total = leg_len, preserving energy.
        let s1 = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let dlat_80m = 80.0 / M_PER_DEG_LAT;
        let s2 = segment(2, 0, 50.105 + dlat_80m, 14.250, 50.105 + dlat_80m, 14.260);
        // Leg parallel to both, midway between (40 m from each).
        let dlat_40m = 40.0 / M_PER_DEG_LAT;
        let leg_sla = 50.105 + dlat_40m;
        let leg_ela = leg_sla;
        let out = project_leg_onto_airport_lines(leg_sla, 14.252, leg_ela, 14.258, &[s1, s2], 50.0);
        assert_eq!(out.len(), 2, "leg between two parallel segs must hit both");
        let leg_len = flat_dist(leg_sla, 14.252, leg_ela, 14.258);
        let total: f32 = out.iter().map(|h| h.length_within_segment_m).sum();
        assert!(
            (total - leg_len).abs() < 1.0,
            "double-overlap must normalize to leg_len; got total={total}, leg_len={leg_len}"
        );
        // Each should be ~ leg_len / 2.
        for h in &out {
            assert!(
                (h.length_within_segment_m - leg_len * 0.5).abs() < 1.0,
                "each seg should get half the leg; got {}",
                h.length_within_segment_m
            );
        }
    }

    #[test]
    fn oblique_45_degree_crossing_returns_buffer_diagonal() {
        // Leg crosses an east-west segment at 45°. Inside the
        // 50 m perp-buffer the diagonal slice length is
        // 2 * max_perp / sin(45°) ≈ 141.4 m if the leg is long
        // enough to span the buffer. Catches transposition errors in
        // the (p,q) edge table where parallel/perpendicular tests
        // can't distinguish.
        let s = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        // Leg from south-west to north-east through midpoint at 45°.
        let mid_lat = (s.start_lat + s.end_lat) * 0.5;
        let mid_lon = (s.start_lon + s.end_lon) * 0.5;
        let offset_m = 200.0;
        let cos_mid = (mid_lat as f64).to_radians().cos() as f32;
        let dlat = offset_m / M_PER_DEG_LAT;
        let dlon = offset_m / (M_PER_DEG_LON_EQUATOR * cos_mid);
        let out = project_leg_onto_airport_lines(
            mid_lat - dlat,
            mid_lon - dlon,
            mid_lat + dlat,
            mid_lon + dlon,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1);
        // 45° entry through y=±50 buffer → length = 100·sqrt(2) ≈ 141.4 m
        let expected = 100.0 * std::f32::consts::SQRT_2;
        assert!(
            (out[0].length_within_segment_m - expected).abs() < 2.0,
            "45° crossing diagonal ≈ {expected} m, got {}",
            out[0].length_within_segment_m
        );
    }

    #[test]
    fn taxiway_90_degree_turn_distributes_across_two_segments() {
        // Two segments meeting at a 90° corner: s1 east-west,
        // s2 north-south. A leg following the curve (diagonal from
        // SW end of s1 to NE end of s2 via the corner) should hit
        // both segments. Total normalized length ≤ leg_len; gaps
        // and overlaps at the corner are policy-resolved by the
        // kernel's energy-preservation normalization.
        let s1 = segment(1, 0, 50.105, 14.250, 50.105, 14.260);
        let s2 = segment(1, 1, 50.105, 14.260, 50.110, 14.260);
        // Leg from middle of s1 (sweeping east) to middle of s2
        // (going north). Approximate by a single diagonal leg.
        let leg_sla = 50.105;
        let leg_ela = 50.108;
        let leg_slo = 14.255;
        let leg_elo = 14.260;
        let out =
            project_leg_onto_airport_lines(leg_sla, leg_slo, leg_ela, leg_elo, &[s1, s2], 50.0);
        assert!(
            !out.is_empty(),
            "leg through 90° turn must hit at least one seg"
        );
        let leg_len = flat_dist(leg_sla, leg_slo, leg_ela, leg_elo);
        let total: f32 = out.iter().map(|h| h.length_within_segment_m).sum();
        assert!(
            total <= leg_len + 0.5,
            "normalized total ({total}) must not exceed leg_len ({leg_len})"
        );
    }

    #[test]
    fn antimeridian_crossing_segment_returns_zero() {
        // Synthetic segment with longitudes wrapping around ±180°.
        // The `(seg.end_lon - seg.start_lon).abs() > 1.0` guard
        // catches this — airport-scale microsegments are < 250 m and
        // cannot legitimately wrap. Without the guard, the midpoint
        // would land at lon=0 (the Atlantic) and produce garbage.
        let s = segment(1, 0, 50.105, 179.999, 50.105, -179.999);
        let out = project_leg_onto_airport_lines(50.105, 179.999, 50.105, 179.998, &[s], 50.0);
        assert!(out.is_empty(), "antimeridian-wrapped seg must be rejected");
    }

    #[test]
    fn lkpr_runway_06_sanity() {
        // LKPR runway 06/24 ≈ bearing 60°. A taxi leg parallel to it
        // at 20 m offset should yield full overlap.
        let s = segment(42, 0, 50.105, 14.255, 50.106, 14.258);
        // Offset perpendicular to seg axis by 20 m. Seg bearing ≈ 60°
        // from north → perp bearing ≈ 150°. Approximate via small dlat/dlon.
        let perp_offset_lat = 0.00009; // ~10 m north
        let perp_offset_lon = -0.000156; // ~10 m west @ 50°N (cos≈0.643)
        let out = project_leg_onto_airport_lines(
            s.start_lat + perp_offset_lat,
            s.start_lon + perp_offset_lon,
            s.end_lat + perp_offset_lat,
            s.end_lon + perp_offset_lon,
            &[s],
            50.0,
        );
        assert_eq!(out.len(), 1, "parallel leg should overlap");
        assert!(
            out[0].length_within_segment_m > s.length_m * 0.9,
            "expected ~full overlap, got {} of {}",
            out[0].length_within_segment_m,
            s.length_m
        );
    }
}
