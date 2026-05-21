//! Typed column views over v6 popup arrow rows. These deliberately
//! borrow plain Rust slices (`&[f32]` etc.) so noise-compute keeps
//! zero arrow / IPC dependencies — source-reader extracts the slices
//! from `Arc<RecordBatch>` clones and hands them off here.

/// Per-row borrow over an airborne sub-segment list. All slices have
/// the same length; sub-segment `i` is fully described by index `i`
/// across every slice.
///
/// `terrain_*_elev_m` are pre-sampled at extract time (Opt A v15) so
/// the popup terrain gates can skip `SegmentTerrain::sample` (5 raster
/// lookups per sub-segment, mutex-serialised). Start / end propagate
/// from Stage 1's per-point elevation; q1, mid, q3 are sampled at
/// Stage 2A from the sub-segment's 0.25 / 0.5 / 0.75 points. All three
/// intermediate elevations are stored explicitly: real DEM isn't
/// linearly interpolated between endpoints, so a sharp peak at
/// frac=0.25 or 0.75 (LOWI / SEQM / KASE mountain airports) can sit
/// tens of metres above any linear estimate.
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
    pub terrain_start_elev_m: &'a [f32],
    pub terrain_q1_elev_m: &'a [f32],
    pub terrain_mid_elev_m: &'a [f32],
    pub terrain_q3_elev_m: &'a [f32],
    pub terrain_end_elev_m: &'a [f32],
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

/// Number of GSE noise classes (LIGHT / MEDIUM / HEAVY). Mirrored
/// here so the popup view + heatmap loader pick up array sizes
/// without depending on `emission::gse` for a pure data shape.
pub const NUM_GSE_CLASSES: usize = 3;

/// One row of `airport_traffic.arrow` v5. Per-band daily-total linear
/// Z-weighted energy at 25 m perpendicular from this OSM microsegment
/// for the row's period (writer divides Σ per-event SEL by `n_days`).
/// Popup applies relative propagation + `A_WEIGHTING` then divides by
/// `period_s` for the period Leq.
///
/// v5 replaces v4's `flight_ids: List<UInt64>` with scalar
/// `unique_*_count` counters plus row-replicated per-microsegment
/// UNION `microseg_unique_*` counts. Airport-level UNION counts now
/// live in the separate `airport_summary.arrow` sidecar (consumed via
/// [`crate::compute::aircraft_v6::airport_traffic::AirportSummaryEntry`]).
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
    /// Distinct fids that crossed this row, regardless of
    /// `ops_kind / is_departure / veh_kind`.
    pub unique_movement_count: u32,
    /// Distinct fids on rows keyed as runway-roll arrivals; zero
    /// elsewhere.
    pub unique_arr_count: u32,
    /// Analogous for departures.
    pub unique_dep_count: u32,
    /// Per-GSE-class distinct fids; populated only on `veh_kind=1`
    /// rows.
    pub unique_gse_count_per_class: &'a [u32; NUM_GSE_CLASSES],
    /// UNION across ALL rows of this `(osm_id, segment_idx)`. Same
    /// value on every row of the microsegment — popup reads first
    /// row's value to populate per-microseg observed_movements.
    pub microseg_unique_count: u32,
    pub microseg_unique_arr_count: u32,
    pub microseg_unique_dep_count: u32,
    pub microseg_unique_gse_count_per_class: &'a [u32; NUM_GSE_CLASSES],
}

/// One row of `airborne.arrow`. `flight_id` is the real ADS-B identity
/// (or a synth id from `flight_id::pack_synth` for TIS-B / anonymous);
/// the popup uses it for per-flight stats dedup. `callsign` and
/// `aircraft_type` give the popup display the real flight number /
/// ICAO typecode (M1) instead of a profile-anchor placeholder.
///
/// `aircraft_type` is held by value (`[u8; 4]`, 4 bytes) rather than
/// `&'a [u8; 4]`: the source-reader / heatmap loaders read it via
/// `FixedSizeBinaryArray::value(i)` (which yields `&[u8]` without
/// fixed-size typing), so storing inline avoids a self-borrowing
/// `Vec<[u8; 4]>` shim in the accumulator. Per Opt C (plan §3).
#[derive(Clone, Copy, Debug)]
pub struct AirborneRowView<'a> {
    pub flight_id: u64,
    pub callsign: &'a str,
    pub aircraft_type: [u8; 4],
    pub profile_idx: u8,
    pub source_id: u8,
    pub origin: u8,
    pub sub_segments: SubSegmentSlice<'a>,
    pub bbox: BBox,
}

/// One entry of `top_candidates` (v14). Identity + ranking dimension
/// only; row-constant fields (period / date_id) live on the parent
/// row. `peak_lmax_25m_db` is the source-side NPD `lookup_lmax` at
/// the 25 m anchor (rev 2 ranking dimension); `altitude_m` is the
/// segment's altitude at peak so the popup can recompute CPA / slant
/// against the receiver.
#[derive(Clone, Debug)]
pub struct CruiseTopCandidateView<'a> {
    pub flight_id: u64,
    pub callsign: &'a str,
    pub aircraft_type: &'a [u8; 4],
    pub peak_lmax_25m_db: f32,
    pub altitude_m: f32,
}

/// One row of `cruise.arrow` v14. R8 bucket aggregating `sum_length_m`
/// of cruise track at altitude `rep_alt_m`. v14 replaces v13's per-fid
/// lists with a bounded top-K `top_candidates` (ranked by source-side
/// peak Lmax at 25 m) + scalar `unique_count`.
///
/// Popup `band_stats` walks `top_candidates` into a per-fid HashMap
/// for dedup across R8 cells. Tail fids outside the top-K cap drop
/// out of band counters; documented regression.
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
    /// Number of distinct real fids that contributed to this bucket.
    /// Display-only — band counter dedup uses `top_candidates` instead.
    pub unique_count: u32,
    /// Bounded top-K identity slice ranked by `peak_lmax_25m_db` desc.
    pub top_candidates: &'a [CruiseTopCandidateView<'a>],
}

