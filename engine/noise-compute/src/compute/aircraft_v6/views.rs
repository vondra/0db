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

/// Per-vertex slice borrow over a ground path's polyline. All slices
/// have the same length; vertex `i` is fully described by index `i`
/// across every slice.
#[derive(Clone, Copy, Debug)]
pub struct GroundVertexSlice<'a> {
    pub lat: &'a [f32],
    pub lon: &'a [f32],
    pub alt_m: &'a [f32],
    pub speed_kt: &'a [f32],
    pub ts_offset_s: &'a [f32],
}

impl GroundVertexSlice<'_> {
    pub fn len(&self) -> usize {
        self.lat.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Per-leg slice borrow over a ground path. `em_bands_offsets` /
/// `em_bands_values` represent the leg-level `List<Float32>(8)` in
/// flat form: leg `i`'s 8-band emission is
/// `em_bands_values[em_bands_offsets[i]..em_bands_offsets[i+1]]`.
#[derive(Clone, Copy, Debug)]
pub struct GroundLegSlice<'a> {
    pub start_idx: &'a [u16],
    pub end_idx: &'a [u16],
    pub ops_kind: &'a [u8],
    pub count_weight: &'a [f32],
    pub length_m: &'a [f32],
    pub em_bands_values: &'a [f32],
    pub em_bands_offsets: &'a [i32],
}

impl GroundLegSlice<'_> {
    pub fn len(&self) -> usize {
        self.ops_kind.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn em_bands(&self, leg_idx: usize) -> &[f32] {
        let lo = self.em_bands_offsets[leg_idx] as usize;
        let hi = self.em_bands_offsets[leg_idx + 1] as usize;
        &self.em_bands_values[lo..hi]
    }
}

/// One row of `ground.arrow` (v10 raw-paths layout). Each row is one
/// aircraft × one contiguous ground path; `vertices` is the polyline
/// of `FlightSegment` endpoints (segN.start = segN-1.end), `legs[i]`
/// joins `vertices[start_idx]` to `vertices[end_idx]` with its own
/// 8-band emission (dB SPL; silent rows round-trip as
/// `f32::NEG_INFINITY`) and a `count_weight = 1 /
/// n_legs_of_this_kind_in_path` so summing across same-kind legs
/// reconstructs one movement's reference SEL energy.
#[derive(Clone, Copy, Debug)]
pub struct GroundPathView<'a> {
    pub flight_id: u64,
    pub callsign: &'a str,
    pub aircraft_type: &'a [u8; 4],
    pub profile_idx: u8,
    pub airport_key: &'a str,
    pub vertices: GroundVertexSlice<'a>,
    pub legs: GroundLegSlice<'a>,
    pub length_m_runway: f32,
    pub length_m_taxi: f32,
    pub length_m_apron: f32,
    /// 0 = day, 1 = evening, 2 = night.
    pub period_rep: u8,
    pub date_id: i16,
    pub is_departure: bool,
    pub source_id: u8,
    pub origin: u8,
}
