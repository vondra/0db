//! Stage 2A — Airborne segments → per-R4 `airborne.arrow`.
//!
//! One row per (flight, R4) crossing. Sub-segments (each carrying its
//! own period / date / flags) are kept in a `List<Struct>` so a long
//! crossing that straddles 19:00 still gets the correct Lden weighting.
//!
//! Cruise-phase segments are routed to Stage 2B; ground to 2C. Only
//! Phase::Airborne segments flow through here.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use h3o::{LatLng, Resolution};
use rayon::prelude::*;

use crate::arrow_io::write_airborne;
use crate::flight::{
    segment_flags, AirborneEvent, AirborneSubSegment, FlightSegment, Phase,
};
use crate::scope::ScopeBbox;

/// Run Stage 2A. Reads Stage 1 segments for one day from `segments_dir`,
/// groups airborne sub-segments by (flight_id, R4) and writes one
/// `airborne.arrow` per R4 under `h3r4_dir/<hex>/`. When `scope` is
/// set, only R4 cells whose centroid sits inside the bbox (expanded
/// by `scope::SCOPE_BUFFER_M`) get written — required to prevent
/// bbox/radius-subset caches from overwriting global R4 files with
/// the full daily trajectories of in-scope flights.
pub fn run_stage_2a(
    segments: &[FlightSegment],
    h3r4_dir: &Path,
    n_days: u16,
    scope: Option<&ScopeBbox>,
) -> Result<usize> {
    let by_r4 = bucket_by_r4(segments);
    let r4s: Vec<u64> = by_r4
        .keys()
        .copied()
        .filter(|r4| scope.map_or(true, |s| s.contains_r4(*r4)))
        .collect();
    let n_r4 = r4s.len();

    r4s.par_iter().try_for_each(|r4_hex| -> Result<()> {
        let segs = by_r4.get(r4_hex).expect("present");
        let events = aggregate_events_for_r4(segs);
        if events.is_empty() {
            return Ok(());
        }
        let hex_str = format!("{r4_hex:015x}");
        let dir = h3r4_dir.join(&hex_str);
        std::fs::create_dir_all(&dir)?;
        write_airborne(&dir.join("airborne.arrow"), &events, n_days)
    })?;
    Ok(n_r4)
}

/// Group every Phase::Airborne FlightSegment by the R4 cell at its
/// midpoint. We bucket by midpoint rather than per-end because per-sample
/// segments are short (1-4 km typical ADS-B sample-pair) vs R4 ≈ 25 km
/// edge — the midpoint approximation snaps each segment to one R4 within
/// a few % of an analytical split. (A future pass could do analytical
/// clipping like Stage 2B; current accuracy is dominated by Doc 29 NPD
/// interpolation, not midpoint snap.)
fn bucket_by_r4(segments: &[FlightSegment]) -> HashMap<u64, Vec<&FlightSegment>> {
    let mut map: HashMap<u64, Vec<&FlightSegment>> = HashMap::new();
    for seg in segments {
        if seg.phase != Phase::Airborne || seg.veh_kind != 0 {
            continue;
        }
        let mid_lat = (seg.start_lat + seg.end_lat) as f64 * 0.5;
        let mid_lon = (seg.start_lon + seg.end_lon) as f64 * 0.5;
        let Ok(ll) = LatLng::new(mid_lat, mid_lon) else {
            continue;
        };
        let r4 = u64::from(ll.to_cell(Resolution::Four));
        map.entry(r4).or_default().push(seg);
    }
    map
}

fn aggregate_events_for_r4(segments: &[&FlightSegment]) -> Vec<AirborneEvent> {
    let mut by_flight: HashMap<u64, AirborneEventBuilder> = HashMap::new();
    for seg in segments {
        let entry = by_flight
            .entry(seg.flight_id)
            .or_insert_with(|| AirborneEventBuilder::new(seg));
        entry.push(seg);
    }
    by_flight.into_values().map(AirborneEventBuilder::finish).collect()
}

struct AirborneEventBuilder {
    flight_id: u64,
    callsign: String,
    aircraft_type: [u8; 4],
    profile_idx: u8,
    source_id: u8,
    origin: u8,
    sub_segments: Vec<AirborneSubSegment>,
    bbox_min_lat: f32,
    bbox_max_lat: f32,
    bbox_min_lon: f32,
    bbox_max_lon: f32,
    total_length_m: f32,
}

impl AirborneEventBuilder {
    fn new(seed: &FlightSegment) -> Self {
        Self {
            flight_id: seed.flight_id,
            callsign: seed.callsign.clone(),
            aircraft_type: seed.aircraft_type,
            profile_idx: seed.profile_idx,
            source_id: seed.source_id,
            origin: seed.origin,
            sub_segments: Vec::new(),
            bbox_min_lat: f32::MAX,
            bbox_max_lat: f32::MIN,
            bbox_min_lon: f32::MAX,
            bbox_max_lon: f32::MIN,
            total_length_m: 0.0,
        }
    }
    fn push(&mut self, seg: &FlightSegment) {
        let mut flags = 0u8;
        if seg.is_departure() {
            flags |= segment_flags::IS_DEPARTURE;
        }
        self.bbox_min_lat = self
            .bbox_min_lat
            .min(seg.start_lat)
            .min(seg.end_lat);
        self.bbox_max_lat = self
            .bbox_max_lat
            .max(seg.start_lat)
            .max(seg.end_lat);
        self.bbox_min_lon = self
            .bbox_min_lon
            .min(seg.start_lon)
            .min(seg.end_lon);
        self.bbox_max_lon = self
            .bbox_max_lon
            .max(seg.start_lon)
            .max(seg.end_lon);
        self.total_length_m += seg.length_m;
        self.sub_segments.push(AirborneSubSegment {
            start_lat: seg.start_lat,
            start_lon: seg.start_lon,
            start_alt_m: seg.start_alt_m,
            end_lat: seg.end_lat,
            end_lon: seg.end_lon,
            end_alt_m: seg.end_alt_m,
            speed_kt: seg.speed_kt,
            length_m: seg.length_m,
            period: seg.period,
            date_id: seg.date_id,
            flags,
        });
    }
    fn finish(self) -> AirborneEvent {
        AirborneEvent {
            flight_id: self.flight_id,
            callsign: self.callsign,
            aircraft_type: self.aircraft_type,
            profile_idx: self.profile_idx,
            source_id: self.source_id,
            origin: self.origin,
            sub_segments: self.sub_segments,
            total_length_m: self.total_length_m,
            bbox_min_lat: self.bbox_min_lat,
            bbox_max_lat: self.bbox_max_lat,
            bbox_min_lon: self.bbox_min_lon,
            bbox_max_lon: self.bbox_max_lon,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(flight_id: u64, lat: f32, lon: f32) -> FlightSegment {
        FlightSegment {
            callsign: String::new(),
            aircraft_type: [0u8; 4],
            flight_id,
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            veh_kind: 0,
            gse_class: 0,
            period: 0,
            date_id: 0,
            phase: Phase::Airborne,
            flags: 0,
            start_lat: lat,
            start_lon: lon,
            start_alt_m: 1000.0,
            end_lat: lat + 0.001,
            end_lon: lon + 0.001,
            end_alt_m: 1100.0,
            speed_kt: 250.0,
            length_m: 200.0,
            agl_avg_m: 500.0,
        }
    }

    #[test]
    fn bucketing_groups_segments_in_same_r4() {
        let segs = vec![seg(1, 50.10, 14.26), seg(2, 50.11, 14.27)];
        let map = bucket_by_r4(&segs);
        assert_eq!(map.len(), 1, "got {} R4 buckets", map.len());
    }

    #[test]
    fn aggregate_groups_per_flight() {
        let s1 = seg(1, 50.10, 14.26);
        let s2 = seg(1, 50.10, 14.27);
        let s3 = seg(2, 50.10, 14.26);
        let segs: Vec<&FlightSegment> = [&s1, &s2, &s3].into_iter().collect();
        let events = aggregate_events_for_r4(&segs);
        assert_eq!(events.len(), 2);
        let f1 = events.iter().find(|e| e.flight_id == 1).unwrap();
        assert_eq!(f1.sub_segments.len(), 2);
        let f2 = events.iter().find(|e| e.flight_id == 2).unwrap();
        assert_eq!(f2.sub_segments.len(), 1);
    }
}
