//! Core in-memory types crossing the stage boundaries.
//!
//! `Flight` (Stage 0 output) carries the raw point list per aircraft.
//! `FlightSegment` (Stage 1 output) carries one classified segment.
//! `AirborneEvent` / `CruiseBucket` / `GroundPath` are the per-R4
//! aggregates produced by Stage 2A / 2B / 2C and serialised into the
//! per-R4 Arrow files.

use crate::trace::TracePoint;

/// Flight phase classification — from `classify`. Stored as `u8` in
/// segments.arrow (`phase` column).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Ground = 0,
    Airborne = 1,
    Cruise = 2,
}

impl Phase {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Phase::Ground,
            2 => Phase::Cruise,
            _ => Phase::Airborne,
        }
    }
}

/// Per-segment bitfield flags. Bit 0 = is_departure, bit 1 = on_ground
/// (composite, post-ground-inference), bit 2 = synthetic identity.
pub mod segment_flags {
    pub const IS_DEPARTURE: u8 = 1 << 0;
    pub const ON_GROUND: u8 = 1 << 1;
    pub const SYNTHETIC: u8 = 1 << 2;
}

/// Pack a variable-width ICAO typecode (`"A320"`, `"B738"`, `"PC12"`,
/// `""`) into the canonical 4-byte FixedSizeBinary representation —
/// truncated to 4 chars and zero-padded. The Arrow column type is
/// `FixedSizeBinary(4)` so consumers can read it as `&[u8; 4]` without
/// allocating. Empty / shorter codes round-trip as trailing `\0`.
pub fn typecode_bytes(s: &str) -> [u8; 4] {
    let mut out = [0u8; 4];
    let bytes = s.as_bytes();
    let n = bytes.len().min(4);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

/// Stage 0 in-memory record. One per rotation — a single
/// `trace_full_<icao>.json` typically yields N `Flight`s, one per
/// sustained on-ground rest (≥ `MIN_TURNAROUND_S`) detected in the
/// trace. `flight_id` is per-leg so popup dedup counts movements
/// rather than aircraft-days; airborne signal dropouts of any
/// duration preserve flight identity, so a transoceanic crossing with
/// a 4 h coverage hole stays one `Flight`.
///
/// `veh_kind` partitions aircraft (`0`) from ground-support equipment
/// (`1`) so Stage 0 routing can fork the two pipelines: aircraft run
/// through the NPD path, GSE through the CNOSSOS-derived emission
/// table in `noise_compute::emission::gse`. Wired by phase:
/// 2.3a adds the struct fields (defaults `(0, 0)` everywhere),
/// 2.3b extends `flights.arrow` / `segments.arrow` schemas so the
/// flag survives Stage 0 → Stage 1 and Stage 1 → Stage 2 disk
/// round-trips, 2.3c activates GND → GSE routing in trace_to_flight.
#[derive(Clone)]
pub struct Flight {
    pub flight_id: u64,
    /// Callsign active at the rotation's first point. Empty when no
    /// point in the trace carried `flight` metadata.
    pub callsign: String,
    pub aircraft_type: String,
    pub profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    /// 0 = aircraft (default), 1 = GSE.
    pub veh_kind: u8,
    /// Valid when `veh_kind == 1`: GSE noise class index
    /// (`GSE_CLASS_LIGHT`/`MEDIUM`/`HEAVY` from `noise_compute::emission::gse`).
    /// Ignored otherwise.
    pub gse_class: u8,
    pub points: Vec<TracePoint>,
}

/// Stage 1 in-memory record. One per classified flight segment.
///
/// `veh_kind`/`gse_class` mirror the `Flight` fields and propagate
/// down so Stage 2A/2B/2C writers can route GSE segments off the
/// aircraft NPD path. See `Flight` for the contract.
#[derive(Clone)]
pub struct FlightSegment {
    pub flight_id: u64,
    pub callsign: String,
    pub aircraft_type: [u8; 4],
    pub profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    pub veh_kind: u8,
    pub gse_class: u8,
    pub period: u8,
    pub date_id: i16,
    pub phase: Phase,
    pub flags: u8,
    pub start_lat: f32,
    pub start_lon: f32,
    pub start_alt_m: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    pub end_alt_m: f32,
    pub speed_kt: f32,
    pub length_m: f32,
    pub agl_avg_m: f32,
}

impl FlightSegment {
    pub fn is_airborne(&self) -> bool {
        self.phase != Phase::Ground
    }
    pub fn is_departure(&self) -> bool {
        self.flags & segment_flags::IS_DEPARTURE != 0
    }
    pub fn is_on_ground(&self) -> bool {
        self.flags & segment_flags::ON_GROUND != 0
    }
}

/// Stage 2A row — one per (flight, R4) crossing. The vector of sub
/// segments is what gets serialised as a `List<Struct>` in the airborne
/// arrow file.
#[derive(Clone)]
pub struct AirborneEvent {
    pub flight_id: u64,
    pub callsign: String,
    pub aircraft_type: [u8; 4],
    pub profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    pub sub_segments: Vec<AirborneSubSegment>,
    pub total_length_m: f32,
    pub bbox_min_lat: f32,
    pub bbox_max_lat: f32,
    pub bbox_min_lon: f32,
    pub bbox_max_lon: f32,
}

/// One sub-segment inside an [`AirborneEvent`]. Period and date are
/// stored per sub-segment so a long airborne crossing that spans the
/// 19:00 evening boundary still gets the correct Lden weighting.
#[derive(Clone)]
pub struct AirborneSubSegment {
    pub start_lat: f32,
    pub start_lon: f32,
    pub start_alt_m: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    pub end_alt_m: f32,
    pub speed_kt: f32,
    pub length_m: f32,
    pub period: u8,
    pub date_id: i16,
    pub flags: u8,
}

/// Stage 2B row — per (R8, fl_bin, class, period, is_dep) bucket.
#[derive(Clone)]
pub struct CruiseBucket {
    pub r8_hex: u64,
    pub class: u8,
    pub rep_profile_idx: u8,
    pub fl_bin: u8,
    pub period: u8,
    pub flags: u8,
    pub sum_length_m: f32,
    pub rep_len_m: f32,
    pub rep_alt_m: f32,
    pub rep_speed_kt: f32,
    pub cruise_flight_ids: Vec<u64>,
    /// Aircraft typecode per fid in `cruise_flight_ids`, parallel order.
    pub cruise_aircraft_types: Vec<[u8; 4]>,
    /// Callsign per fid in `cruise_flight_ids`, parallel order.
    pub cruise_callsigns: Vec<String>,
    pub source_id: u8,
    pub origin: u8,
}

/// Stage 2C row — one aircraft × one contiguous ground path. Polyline
/// of consecutive `FlightSegment` endpoints (segN.start = segN-1.end)
/// in `vertices`; `legs[i]` joins `vertices[start_idx]` to
/// `vertices[end_idx]` with a smoothed `ops_kind`,
/// `count_weight = 1 / n_legs_of_this_kind_in_path` (one movement's
/// energy distributed across same-kind legs so summation reconstructs
/// a single SEL), and per-leg `em_bands` (8 dB SPL floats; silent
/// rows round-trip as `f32::NEG_INFINITY`).
#[derive(Clone)]
pub struct GroundPath {
    pub flight_id: u64,
    pub callsign: String,
    pub aircraft_type: [u8; 4],
    pub profile_idx: u8,
    pub airport_key: String,
    pub vertices: Vec<GroundPathVertex>,
    pub legs: Vec<GroundPathLeg>,
    pub length_m_runway: f32,
    pub length_m_taxi: f32,
    pub length_m_apron: f32,
    pub period_rep: u8,
    pub date_id: i16,
    pub is_departure: bool,
    pub source_id: u8,
    pub origin: u8,
}

#[derive(Clone, Copy)]
pub struct GroundPathVertex {
    pub lat: f32,
    pub lon: f32,
    pub alt_m: f32,
    pub speed_kt: f32,
    pub ts_offset_s: f32,
}

#[derive(Clone)]
pub struct GroundPathLeg {
    pub start_idx: u16,
    pub end_idx: u16,
    /// 1 = runway_roll, 2 = taxi, 3 = apron_movement (post-smoothing).
    pub ops_kind: u8,
    /// 1 / n_legs_of_this_kind_in_path. Distributes one movement's
    /// reference SEL energy across same-kind legs of the path so that
    /// summing energies × count_weight reconstructs one movement.
    pub count_weight: f32,
    pub length_m: f32,
    /// 8 octave-band emission levels (dB SPL); silent legs round-trip
    /// as `[NEG_INFINITY; 8]`.
    pub em_bands: [f32; 8],
}

/// FL bins — five buckets covering the cruise altitude range. Tracks
/// the plan's documented FL250 / FL280 / FL310 / FL350 / FL390+ split.
pub fn fl_bin_of(alt_m: f32) -> u8 {
    let alt_ft = alt_m / 0.3048;
    match alt_ft {
        f if f < 26_500.0 => 0, // FL250
        f if f < 29_500.0 => 1, // FL280
        f if f < 32_500.0 => 2, // FL310
        f if f < 37_000.0 => 3, // FL350
        _ => 4,                 // FL390+
    }
}

/// Source registry positions. Adding a driver here keeps `source_id`
/// values stable across past extracts.
pub mod source_id {
    pub const ADSB_LOL_TAR: u8 = 0;
    pub const SCHEDULE_SYNTH: u8 = 1;
}

/// Origin tag — always 0 for now. Reserved for the schedule-synth and
/// interpolation drivers documented in the plan.
pub mod origin {
    pub const OBSERVED: u8 = 0;
    pub const INTERPOLATED: u8 = 1;
    pub const SCHEDULE_MODELED: u8 = 2;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fl_bin_boundaries() {
        assert_eq!(fl_bin_of(7_620.0), 0); // FL250
        assert_eq!(fl_bin_of(8_535.0), 1); // FL280
        assert_eq!(fl_bin_of(9_450.0), 2); // FL310
        assert_eq!(fl_bin_of(10_670.0), 3); // FL350
        assert_eq!(fl_bin_of(12_500.0), 4); // FL410
    }

    #[test]
    fn phase_round_trip() {
        for phase in [Phase::Ground, Phase::Airborne, Phase::Cruise] {
            assert_eq!(Phase::from_u8(phase.as_u8()), phase);
        }
    }
}
