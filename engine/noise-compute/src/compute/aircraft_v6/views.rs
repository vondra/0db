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

/// One row of `airborne.arrow`. `flight_id` is the real ADS-B identity
/// (or a synth id from `flight_id::pack_synth` for TIS-B / anonymous);
/// the popup uses it for per-flight stats dedup.
#[derive(Clone, Copy, Debug)]
pub struct AirborneRowView<'a> {
    pub flight_id: u64,
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
}

/// One row of `ground.arrow` (post-Stage-2C-v2). `em_*_bands` carry
/// dB SPL per band per period — silent periods round-trip as
/// `f32::NEG_INFINITY`. Energy was summed in linear space inside
/// Stage 2C and converted back to dB; the popup must NOT divide by
/// `n_days` again because Stage 2C already daily-averaged via
/// `period_leq` inside `build_ground_ops_line_emission`.
#[derive(Clone, Copy, Debug)]
pub struct GroundRowView<'a> {
    pub osm_id: i64,
    pub airport_key: &'a str,
    pub ops_kind: u8,
    pub sub_bucket_idx: u16,
    pub em_day_bands: &'a [f32; 8],
    pub em_eve_bands: &'a [f32; 8],
    pub em_night_bands: &'a [f32; 8],
    pub n_observed_per_day: f32,
    pub n_modeled_per_day: f32,
    pub line_start_lat: f32,
    pub line_start_lon: f32,
    pub line_end_lat: f32,
    pub line_end_lon: f32,
    pub line_length_m: f32,
    pub source_id: u8,
    pub origin: u8,
}
