//! Typed column views over v6 popup arrow rows. These deliberately
//! borrow plain Rust slices (`&[f32]` etc.) so noise-compute keeps
//! zero arrow / IPC dependencies — source-reader extracts the slices
//! from `Arc<RecordBatch>` clones and hands them off here.

/// Per-row borrow over an airborne sub-segment list. All slices have
/// the same length; sub-segment `i` is fully described by index `i`
/// across every slice.
#[derive(Clone, Copy, Debug)]
pub struct SubSegmentSlice<'a> {
    pub start_lat: &'a [f32],
    pub start_lon: &'a [f32],
    pub start_alt_m: &'a [f32],
    pub end_lat: &'a [f32],
    pub end_lon: &'a [f32],
    pub end_alt_m: &'a [f32],
    pub speed_kt: &'a [f32],
    pub length_m: &'a [f32],
    pub period: &'a [u8],
    pub date_id: &'a [i16],
    pub flags: &'a [u8],
}

impl SubSegmentSlice<'_> {
    pub fn len(&self) -> usize {
        self.start_lat.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Axis-aligned lat/lon bbox over a row's sub-segments. Pre-stored so
/// the popup can prune airborne rows whose envelope is outside the
/// receiver's reach radius without expanding sub-segment columns.
#[derive(Clone, Copy, Debug)]
pub struct BBox {
    pub min_lat: f32,
    pub max_lat: f32,
    pub min_lon: f32,
    pub max_lon: f32,
}

/// One row of `airport_traffic.arrow` (v3 contract). Per-band
/// **daily total** linear Z-weighted energy at 25 m perpendicular from
/// this OSM microsegment for the row's period (writer divides
/// Σ per-event SEL by `n_days`). Phase 4 popup applies relative
/// propagation + `A_WEIGHTING` then divides by `period_s` for the
/// period Leq. `movements_per_day` is **per-microsegment display
/// only**: airport-total movements require UNION over `flight_ids`
/// across rows.
#[derive(Clone, Copy, Debug)]
pub struct AirportTrafficRowView<'a> {
    pub airport_key: &'a str,
    pub osm_id: u64,
    pub segment_idx: u16,
    pub geometry_kind: u8,
    pub start_lat: f32,
    pub start_lon: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    pub length_m: f32,
    pub ops_kind: u8,
    pub is_departure: u8,
    pub veh_kind: u8,
    pub class_idx: u8,
    pub period: u8,
    pub movements_per_day: f32,
    pub band_energy_lin: &'a [f32; 8],
    /// Sorted unique `flight_id`s attributed to this microsegment
    /// for this period (longest-coverage attribution from Stage 2C).
    /// Caller UNIONs across rows for airport-level unique movement
    /// counts.
    pub flight_ids: &'a [u64],
}

/// One row of `airborne.arrow`. `flight_id` is the real ADS-B identity
/// (or a synth id from `flight_id::pack_synth` for TIS-B / anonymous);
/// the popup uses it for per-flight stats dedup. `callsign` and
/// `aircraft_type` give the popup display the real flight number /
/// ICAO typecode (M1) instead of a profile-anchor placeholder.
#[derive(Clone, Copy, Debug)]
pub struct AirborneRowView<'a> {
    pub flight_id: u64,
    pub callsign: &'a str,
    pub aircraft_type: &'a [u8; 4],
    pub profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    pub sub_segments: SubSegmentSlice<'a>,
    pub bbox: BBox,
}

/// One row of `cruise.arrow` — an R8 bucket aggregating `sum_length_m`
/// of cruise track at altitude `rep_alt_m`. `cruise_flight_ids` are
/// the real fids that contributed segments to this bucket; popup
/// dedups by them across R8 cells (one transit crossing many R8s
/// must count as one flight in the band counters).
#[derive(Clone, Debug)]
pub struct CruiseRowView<'a> {
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
    pub source_id: u8,
    pub origin: u8,
    pub cruise_flight_ids: &'a [u64],
    /// Parallel-indexed against `cruise_flight_ids`. Empty for pre-v11
    /// readers that didn't write these columns.
    pub cruise_aircraft_types: &'a [[u8; 4]],
    pub cruise_callsigns: &'a [String],
}

