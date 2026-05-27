//! Direct row-view scatter for cruise R7 buckets. The synth-fid keying
//! into `flights` is deliberate: one transit may cross many buckets, so
//! per-real-fid energy aggregation would over-count. Real-fid dedup
//! lives in `cruise_flight_stats` (band counters) and `top_flight_candidates`
//! (popup table); both walk the row's `top_candidates` slice — v14
//! replaces v13's per-fid lists with a bounded top-K identity slice
//! ranked by source-side peak Lmax at 25 m. Tail fids outside the cap
//! drop out of band counters; documented regression.

use std::collections::HashMap;

use h3o::CellIndex;

use crate::compute::aircraft_v6::dates::{date_from_unix, time_from_unix};
use crate::compute::aircraft_v6::state::{
    BandStats, CruiseFlightStats, FlightAccum, TopFlightCandidate,
};
use crate::compute::aircraft_v6::views::CruiseRowView;
use crate::emission::aircraft;
use crate::flight_id::pack_synth;
use crate::propagation::iso9613::fast_exp_f64;
use crate::types::{
    AircraftSegment, CruiseBucketBreakdown, CruiseHexTopFlight, RasterSampler, Receiver,
    TraceCollector,
};

/// Slant floor (m) — clamps the receiver-overhead degenerate case so
/// `1 / d²` doesn't blow up when the cruise rep-line passes directly
/// above the receiver. 5 m matches Doc 29 §A.2 minimum non-zero CPA.
pub const SLANT_FLOOR_M: f64 = 5.0;

/// Per-R7-hex top-flight tracker. Same fid can appear in multiple
/// Stage 2B buckets within the same hex (e.g. crossing an FL boundary
/// mid-hex), so dedup via HashMap with "max peak_lmax wins" merge — a
/// Vec would inflate top-5 with duplicates of the loudest fid.
struct HexTopFlight {
    peak_lmax: f64,
    altitude_m: f64,
    class_idx: u8,
    aircraft_type: [u8; 4],
    callsign: String,
}

struct HexAccum {
    n_unique_flights: std::collections::HashSet<u64>,
    rep_alt_m: f32,
    centroid_lat: f64,
    centroid_lon: f64,
    d_slant_m: f64,
    period_energy: [f64; 3],
    buckets: Vec<CruiseBucketBreakdown>,
    top_fids: HashMap<u64, HexTopFlight>,
}

pub fn scatter(
    receiver: &Receiver,
    rows: &[CruiseRowView<'_>],
    rasters: &dyn RasterSampler,
    n_days_f: f64,
    flights: &mut HashMap<u64, FlightAccum>,
    cruise_flight_stats: &mut HashMap<u64, CruiseFlightStats>,
    top_flight_candidates: &mut HashMap<u64, TopFlightCandidate>,
    mut traces: Option<&mut TraceCollector>,
) {
    let rx_elev = receiver.altitude_m();
    let npd_luts = aircraft::NpdLuts::shared();
    let mut hex_accums: HashMap<u64, HexAccum> = HashMap::new();

    // R7-centre prefilter constants. rep_len_m is typically ~50 km
    // (Stage 2B uses source-segment length, not clip length), so the
    // cap dilates the 16 km horizontal reach to ~51 km worst case —
    // still drops a meaningful share of the 7-R4 grid disk's ~350 k
    // cruise rows for praha-150km × 7 days. Detailed math at the
    // call site below.
    let m_per_lat = crate::constants::M_PER_DEG_LAT;
    let m_per_lon = crate::constants::m_per_deg_lon(receiver.lat.to_radians());

    for (idx, row) in rows.iter().enumerate() {
        let Some((lat, lon)) = r7_cell_center(row.r7_hex) else {
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
        // to one R7 cell) keep their 0.05× weight — no `.max(1.0)`
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
        let acc = flights.entry(synth_fid).or_insert_with(|| {
            // Cruise rows have no per-flight callsign / typecode (one
            // R7 bucket aggregates many flights), so leave both empty.
            FlightAccum::new(row.rep_profile_idx, density, true, [0; 4], String::new())
        });
        acc.period_energy[period] += energy;
        acc.flight_weight = acc.flight_weight.max(density);

        let class_idx = aircraft::noise_class_of(seg.profile_idx) as usize;
        // Clamp the DISPLAY CPA onto the observed segment so an off-segment
        // infinite-line foot can't report a phantom near pass. Cruise synthetic
        // segments are level (start == end == rep_alt_m), so the altitude clamp
        // is a no-op (sdz = 0) today — but both distance and altitude go through
        // the helper to stay symmetric with airborne and stay correct if a
        // gradient is ever modelled. `sel` / `energy` keep the unclamped `cpa`
        // (ΔF needs the infinite-line `q_m`).
        let (disp_dist, disp_alt) = aircraft::clamped_display_cpa(&cpa, 0.0);
        let log_d = (disp_dist * aircraft::FT_PER_M).max(100.0).log10();
        let lmax = npd_luts.lookup_lmax(class_idx, true, log_d);
        if lmax > acc.peak_lmax {
            acc.peak_lmax = lmax;
            acc.peak_sel = sel;
            acc.peak_altitude_m = disp_alt;
            acc.peak_period = row.period;
            acc.peak_seg_start = [seg.start_lon, seg.start_lat];
            acc.peak_seg_end = [seg.end_lon, seg.end_lat];
        }
        if disp_dist < acc.min_dist_m {
            acc.min_dist_m = disp_dist;
        }
        // v14: walk the row's bounded top-K candidate slice instead of
        // per-fid lists. Identity (typecode / callsign / fid) comes
        // from the candidate; receiver-side ranking (`lmax`, `disp_alt`)
        // comes from the row's already-computed values per Codex W2 —
        // re-deriving Lmax from candidate's
        // source-side peak would discard the popup-receiver geometry.
        for cand_view in row.top_candidates.iter() {
            let fid = cand_view.flight_id;
            let entry = cruise_flight_stats.entry(fid).or_insert(CruiseFlightStats {
                peak_lmax: f64::NEG_INFINITY,
                alt_at_peak: 0.0,
                class_at_peak: class_idx,
            });
            if lmax > entry.peak_lmax {
                entry.peak_lmax = lmax;
                entry.alt_at_peak = disp_alt;
                entry.class_at_peak = class_idx;
            }

            let cand = top_flight_candidates.entry(fid).or_insert(TopFlightCandidate {
                peak_lmax: f64::NEG_INFINITY,
                peak_altitude_m: 0.0,
                peak_period: row.period,
                peak_seg_start: [0.0; 2],
                peak_seg_end: [0.0; 2],
                min_dist_m: f64::MAX,
                profile_idx: row.rep_profile_idx,
                aircraft_type: *cand_view.aircraft_type,
                callsign: cand_view.callsign.to_string(),
            });
            if lmax > cand.peak_lmax {
                cand.peak_lmax = lmax;
                cand.peak_altitude_m = disp_alt;
                cand.peak_period = row.period;
                cand.peak_seg_start = [seg.start_lon, seg.start_lat];
                cand.peak_seg_end = [seg.end_lon, seg.end_lat];
            }
            if disp_dist < cand.min_dist_m {
                cand.min_dist_m = disp_dist;
            }
        }

        if traces.is_some() {
            // Per-bucket received_lden uses the row's energy density; the
            // popup tab only renders relative ordering inside one hex,
            // so a stable proxy (received_lden ≈ SEL on a per-event basis)
            // is enough.
            let received_lden = sel + 10.0 * density.max(1e-9).log10();
            let entry = hex_accums.entry(row.r7_hex).or_insert(HexAccum {
                n_unique_flights: std::collections::HashSet::new(),
                rep_alt_m: row.rep_alt_m,
                centroid_lat: lat,
                centroid_lon: lon,
                d_slant_m: disp_dist.max(SLANT_FLOOR_M),
                period_energy: [0.0; 3],
                buckets: Vec::new(),
                top_fids: HashMap::new(),
            });
            for cand_view in row.top_candidates.iter() {
                entry.n_unique_flights.insert(cand_view.flight_id);
                let cand = entry.top_fids.entry(cand_view.flight_id).or_insert(HexTopFlight {
                    peak_lmax: f64::NEG_INFINITY,
                    altitude_m: 0.0,
                    class_idx: class_idx as u8,
                    aircraft_type: *cand_view.aircraft_type,
                    callsign: cand_view.callsign.to_string(),
                });
                if lmax > cand.peak_lmax {
                    cand.peak_lmax = lmax;
                    cand.altitude_m = disp_alt;
                    cand.class_idx = class_idx as u8;
                }
            }
            entry.period_energy[period] += energy;
            if disp_dist < entry.d_slant_m {
                entry.d_slant_m = disp_dist.max(SLANT_FLOOR_M);
            }
            entry.buckets.push(CruiseBucketBreakdown {
                class: row.class,
                fl_bin: row.fl_bin,
                period: row.period,
                // v14: `unique_count` is the full bucket count (not
                // just top-K) — display semantics match v13.
                n_flights: row.unique_count,
                received_lden,
            });
        }
    }

    if let Some(t) = traces.as_deref_mut() {
        let mut hex_keys: Vec<u64> = hex_accums.keys().copied().collect();
        hex_keys.sort();
        for hex_key in hex_keys {
            let mut acc = hex_accums.remove(&hex_key).unwrap();
            acc.buckets.sort_by(|a, b| {
                b.received_lden
                    .partial_cmp(&a.received_lden)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let cruise_top_flights = top_flights_for_hex(&acc.top_fids);
            // Doc 29 placeholder: kernel breakdown not yet plumbed; cruise
            // is always CFFK fast-path (FL250+ slant > 7.62 km).
            let placeholder_doc29 = crate::types::Doc29Breakdown {
                sel_npd_db: 0.0,
                delta_v_db: 0.0,
                delta_i_db: 0.0,
                lambda_db: 0.0,
                delta_f_db: 0.0,
                d_p_m: acc.d_slant_m,
                lateral_m: 0.0,
                beta_deg: 90.0,
                seg_len_m: 0.0,
                d_bar_m: acc.d_slant_m,
                installation: "wing",
                cffk_fast_path: true,
            };
            t.segments
                .push(crate::traces::build_aircraft_cruise_r7_trace(
                    crate::traces::BuildAircraftCruiseR7Trace {
                        r7_hex: hex_key,
                        n_unique_flights: acc.n_unique_flights.len() as u32,
                        rep_alt_m: acc.rep_alt_m,
                        centroid_lat: acc.centroid_lat,
                        centroid_lon: acc.centroid_lon,
                        d_slant_m: acc.d_slant_m,
                        period_energies: acc.period_energy,
                        n_days: n_days_f,
                        cruise_buckets: acc.buckets,
                        cruise_top_flights,
                        doc29: placeholder_doc29,
                    },
                ));
        }
    }
}

const TOP_FLIGHTS_PER_HEX: usize = 5;

fn top_flights_for_hex(top_fids: &HashMap<u64, HexTopFlight>) -> Vec<CruiseHexTopFlight> {
    let mut entries: Vec<(u64, &HexTopFlight)> = top_fids.iter().map(|(f, t)| (*f, t)).collect();
    entries.sort_by(|a, b| {
        b.1.peak_lmax
            .partial_cmp(&a.1.peak_lmax)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    entries.truncate(TOP_FLIGHTS_PER_HEX);
    entries
        .into_iter()
        .map(|(fid, t)| {
            let (icao_hex, start_unix) = crate::flight_id::icao_hex_and_start_unix(fid);
            let date = start_unix.map(date_from_unix).unwrap_or_default();
            let time_utc = start_unix.map(time_from_unix).unwrap_or_default();
            CruiseHexTopFlight {
                lmax_db: round1(t.peak_lmax),
                altitude_m: round1(t.altitude_m),
                date,
                time_utc,
                icao_hex,
                aircraft_type: aircraft::typecode_to_string(&t.aircraft_type),
                callsign: t.callsign.clone(),
                class_name: aircraft::CLASS_NAMES[t.class_idx as usize].to_string(),
            }
        })
        .collect()
}

#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Per-band cruise dedup → `[band_faint, band_audible, band_disruptive]`.
/// Each real fid contributes once per band it crosses (not once per R7
/// bucket). v14: walks `cruise_flight_stats` which is keyed on real fid
/// and populated from each row's `top_candidates` slice — so a fid
/// touching multiple R7 buckets dedupes naturally via HashMap insert.
/// Tail fids outside the per-row top-K cap silently undercount per
/// plan §4.4 / §9; documented regression.
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

fn r7_cell_center(r7_hex: u64) -> Option<(f64, f64)> {
    let cell = CellIndex::try_from(r7_hex).ok()?;
    let ll: h3o::LatLng = cell.into();
    Some((ll.lat(), ll.lng()))
}
