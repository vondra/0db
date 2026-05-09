//! Direct row-view scatter for cruise R8 buckets. Each `CruiseRowView`
//! is one bucket aggregating `sum_length_m` of cruise track at altitude
//! `rep_alt_m` through R8-cell-centre. Builds a stack-only synth segment
//! per bucket, runs the standard Doc 29 SEL chain, and feeds energy
//! into `FlightAccum`s keyed by a per-bucket synth fid (`pack_synth`).
//! Real cruise flight identity is preserved in `cruise_flight_stats` so
//! the popup band counters dedup across R8 cells.

use std::collections::HashMap;

use h3o::CellIndex;

use crate::compute::aircraft_v6::state::{BandStats, CruiseFlightStats, FlightAccum};
use crate::compute::aircraft_v6::views::CruiseRowView;
use crate::emission::aircraft;
use crate::flight_id::pack_synth;
use crate::propagation::iso9613::fast_exp_f64;
use crate::types::{AircraftSegment, RasterSampler, Receiver};

/// Slant floor (m) — clamps the receiver-overhead degenerate case so
/// `1 / d²` doesn't blow up when the cruise rep-line passes directly
/// above the receiver. 5 m matches Doc 29 §A.2 minimum non-zero CPA.
pub const SLANT_FLOOR_M: f64 = 5.0;

pub fn scatter(
    receiver: &Receiver,
    rows: &[CruiseRowView<'_>],
    rasters: &dyn RasterSampler,
    flights: &mut HashMap<u64, FlightAccum>,
    cruise_flight_stats: &mut HashMap<u64, CruiseFlightStats>,
) {
    let rx_elev = receiver.altitude_m();
    let npd_luts = aircraft::NpdLuts::shared();

    // R8-centre prefilter constants. rep_len_m is typically ~50 km
    // (Stage 2B uses source-segment length, not clip length), so the
    // cap dilates the 16 km horizontal reach to ~51 km worst case —
    // still drops a meaningful share of the 7-R4 grid disk's ~350 k
    // cruise rows for praha-150km × 7 days. Detailed math at the
    // call site below.
    let m_per_lat = crate::constants::M_PER_DEG_LAT;
    let m_per_lon = crate::constants::m_per_deg_lon(receiver.lat.to_radians());

    for (idx, row) in rows.iter().enumerate() {
        let Some((lat, lon)) = r8_cell_center(row.r8_hex) else {
            continue;
        };
        let rep_len_m = (row.rep_len_m as f64).max(SLANT_FLOOR_M);
        let half_len_m = rep_len_m * 0.5;

        // Distance prefilter: synth segment extends `half_len_m` along
        // each axis (NE-SW diagonal), so the closest segment point is
        // at least `dist_to_centre - half_len_m * sqrt(2)` from the
        // receiver. Skip rows beyond reach + diagonal cap. The kernel's
        // per-row slant test would reject these too, but this lat/lon
        // test is ~ns vs ~µs for `segment_sel_with_terrain`.
        // /gg (Codex) flagged that a naive `lon - receiver.lon` produces
        // a ~360° false-negative for receivers near ±180° (a Pacific
        // receiver vs an Asia source on the other side of the
        // dateline). Wrap the lon delta to [-180, 180] so the test
        // measures real great-circle longitude separation.
        let dlat_m = (lat - receiver.lat) * m_per_lat;
        let mut dlon = lon - receiver.lon;
        if dlon > 180.0 {
            dlon -= 360.0;
        } else if dlon < -180.0 {
            dlon += 360.0;
        }
        let dlon_m = dlon * m_per_lon;
        let dist2_m2 = dlat_m * dlat_m + dlon_m * dlon_m;
        let cap_m = aircraft::AIRCRAFT_MAX_HORIZONTAL_REACH_M + half_len_m * std::f64::consts::SQRT_2;
        if dist2_m2 > cap_m * cap_m {
            continue;
        }

        // Density = sum_length / rep_len: fractional weight of this
        // representative segment carried by the bucket. Partial transits
        // (sum_length < rep_len, e.g. 500 m of a 10 km segment clipped
        // to one R8 cell) keep their 0.05× weight — no `.max(1.0)`
        // floor, which a /gg review caught as a multi-cell over-count.
        let density = if row.rep_len_m > 0.0 {
            (row.sum_length_m / row.rep_len_m) as f64
        } else {
            0.0
        };
        if density <= 0.0 {
            continue;
        }
        let lat_off = half_len_m / crate::constants::M_PER_DEG_LAT;
        let lon_off = half_len_m / crate::constants::m_per_deg_lon(lat.to_radians());
        let synth_fid = pack_synth(idx as u64);
        let seg = AircraftSegment {
            flight_id: synth_fid,
            profile_idx: row.rep_profile_idx,
            // Doc 29 §A.3.2 — cruise NPD curves are taken from the
            // departure family (en-route is closest to climb-out).
            is_departure: true,
            on_ground: false,
            period: row.period,
            date_id: 0,
            start_lat: lat - lat_off,
            start_lon: lon - lon_off,
            start_alt_m: row.rep_alt_m,
            end_lat: lat + lat_off,
            end_lon: lon + lon_off,
            end_alt_m: row.rep_alt_m,
            speed_kt: row.rep_speed_kt,
            segment_length_m: rep_len_m as f32,
            count_weight: density as f32,
            surface_model: false,
            ground_context: aircraft::GROUND_CONTEXT_NONE,
            ground_ops_kind: aircraft::GROUND_OPS_KIND_NONE,
            source_id: row.source_id as u16,
            cruise_flight_ids: row.cruise_flight_ids.to_vec(),
        };
        let terrain = aircraft::SegmentTerrain::sample(&seg, rasters);
        if !aircraft::is_valid_airborne_with_terrain(&seg, &terrain) {
            continue;
        }
        let Some((sel, cpa)) = aircraft::segment_sel_with_terrain(
            &seg,
            receiver.lat,
            receiver.lon,
            rx_elev,
            &terrain,
            npd_luts,
        ) else {
            continue;
        };
        let energy = fast_exp_f64(sel * std::f64::consts::LN_10 * 0.1) * density;
        let period = (row.period.min(2)) as usize;
        let acc = flights
            .entry(synth_fid)
            .or_insert_with(|| FlightAccum::new(row.rep_profile_idx, density, true));
        acc.period_energy[period] += energy;
        acc.flight_weight = acc.flight_weight.max(density);

        let class_idx = aircraft::noise_class_of(seg.profile_idx) as usize;
        let log_d = (cpa.d_p_m * aircraft::FT_PER_M).max(100.0).log10();
        let lmax = npd_luts.lookup_lmax(class_idx, true, log_d);
        if lmax > acc.peak_lmax {
            acc.peak_lmax = lmax;
            acc.peak_sel = sel;
            acc.peak_altitude_m = cpa.relative_alt_m;
            acc.peak_period = row.period;
            acc.peak_seg_start = [seg.start_lon, seg.start_lat];
            acc.peak_seg_end = [seg.end_lon, seg.end_lat];
        }
        if cpa.d_p_m < acc.min_dist_m {
            acc.min_dist_m = cpa.d_p_m;
        }
        for &fid in row.cruise_flight_ids {
            let entry = cruise_flight_stats.entry(fid).or_insert(CruiseFlightStats {
                peak_lmax: f64::NEG_INFINITY,
                alt_at_peak: 0.0,
                class_at_peak: class_idx,
            });
            if lmax > entry.peak_lmax {
                entry.peak_lmax = lmax;
                entry.alt_at_peak = cpa.relative_alt_m;
                entry.class_at_peak = class_idx;
            }
        }
    }
}

/// Per-band cruise dedup → `[band_faint, band_audible, band_disruptive]`.
/// Each real fid contributes once per band it crosses (not once per R8
/// bucket), matching the Doc 29 event-counting contract.
pub fn band_stats(cruise_flight_stats: &HashMap<u64, CruiseFlightStats>) -> [BandStats; 3] {
    let mut out = [BandStats::new(), BandStats::new(), BandStats::new()];
    for stats in cruise_flight_stats.values() {
        if stats.peak_lmax > 30.0 {
            let cls = stats.class_at_peak;
            out[0].add_event(1.0, stats.alt_at_peak, cls, 1);
            if stats.peak_lmax > 45.0 {
                out[1].add_event(1.0, stats.alt_at_peak, cls, 1);
                if stats.peak_lmax > 60.0 {
                    out[2].add_event(1.0, stats.alt_at_peak, cls, 1);
                }
            }
        }
    }
    out
}

fn r8_cell_center(r8_hex: u64) -> Option<(f64, f64)> {
    let cell = CellIndex::try_from(r8_hex).ok()?;
    let ll: h3o::LatLng = cell.into();
    Some((ll.lat(), ll.lng()))
}
