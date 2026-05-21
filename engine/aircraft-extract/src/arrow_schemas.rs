//! Arrow schemas for the five aircraft pipeline artifacts. Every schema
//! embeds `schema_version = SCHEMA_VERSION` in metadata so the reader
//! can refuse stale layouts instead of silently mis-decoding them.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Fields, Schema};

use crate::SCHEMA_VERSION;

/// Common metadata stamp. Per-schema callers append their own keys.
fn base_metadata(extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut md = HashMap::new();
    md.insert("schema_version".to_string(), SCHEMA_VERSION.to_string());
    for (k, v) in extra {
        md.insert(k.to_string(), v.to_string());
    }
    md
}

/// Returns a clone of `schema` with `n_days` metadata stamped. Used by
/// the writers to record the extraction window so the popup reader can
/// recover the correct period normalization without scanning date_ids.
pub fn with_n_days(schema: Arc<Schema>, n_days: u16) -> Arc<Schema> {
    let mut md = schema.metadata().clone();
    md.insert("n_days".to_string(), n_days.to_string());
    Arc::new((*schema).clone().with_metadata(md))
}

/// Stage 0 — `flights/<day>.arrow`. One row per (aircraft, day).
pub fn flights_schema() -> Arc<Schema> {
    let pt_struct = DataType::Struct(Fields::from(vec![
        Field::new("ts_offset_s", DataType::Float32, false),
        Field::new("lat", DataType::Float32, false),
        Field::new("lon", DataType::Float32, false),
        Field::new("alt_ft", DataType::Float32, false),
        Field::new("speed_kt", DataType::Float32, false),
        Field::new("track_deg", DataType::Float32, false),
        Field::new("baro_rate_fpm", DataType::Float32, false),
        Field::new("flags", DataType::UInt8, false),
    ]));
    let fields = vec![
        Field::new("flight_id", DataType::UInt64, false),
        Field::new("callsign", DataType::Utf8, false),
        Field::new("aircraft_type", DataType::FixedSizeBinary(4), false),
        Field::new("profile_idx", DataType::UInt8, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
        Field::new("veh_kind", DataType::UInt8, false),
        Field::new("gse_class", DataType::UInt8, false),
        Field::new("base_timestamp", DataType::Float64, false),
        Field::new(
            "points",
            DataType::List(Arc::new(Field::new("item", pt_struct, false))),
            false,
        ),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "flights")])))
}

/// Stage 1 — `segments/<day>.arrow`. One row per classified segment.
///
/// v15 adds `start_elev_m` / `end_elev_m` (Opt A): Stage 1 already
/// loops per-point elevations for AGL, so emitting these per-segment
/// is free; Stage 2A propagates them into airborne sub-segments.
pub fn segments_schema() -> Arc<Schema> {
    let fields = vec![
        Field::new("flight_id", DataType::UInt64, false),
        Field::new("callsign", DataType::Utf8, false),
        Field::new("aircraft_type", DataType::FixedSizeBinary(4), false),
        Field::new("profile_idx", DataType::UInt8, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
        Field::new("veh_kind", DataType::UInt8, false),
        Field::new("gse_class", DataType::UInt8, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("date_id", DataType::Int16, false),
        Field::new("phase", DataType::UInt8, false),
        Field::new("flags", DataType::UInt8, false),
        Field::new("start_lat", DataType::Float32, false),
        Field::new("start_lon", DataType::Float32, false),
        Field::new("start_alt_m", DataType::Float32, false),
        Field::new("end_lat", DataType::Float32, false),
        Field::new("end_lon", DataType::Float32, false),
        Field::new("end_alt_m", DataType::Float32, false),
        Field::new("speed_kt", DataType::Float32, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("agl_avg_m", DataType::Float32, false),
        Field::new("start_elev_m", DataType::Float32, false),
        Field::new("end_elev_m", DataType::Float32, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "segments")])))
}

/// Stage 2A — `h3r4/<hex>/airborne.arrow`. One row per (flight, R4)
/// crossing. `sub_segments` carries per-sub-segment period / date /
/// flags so a long crossing that straddles 19:00 still buckets right.
///
/// v15 (Opt A) adds five terrain elevation columns sampled at extract
/// time so the popup terrain gates can skip `SegmentTerrain::sample`
/// (5 raster lookups → 0 on the hot path). `terrain_start_elev_m` /
/// `terrain_end_elev_m` propagate from Stage 1's per-point elevation;
/// `terrain_q1_elev_m` / `terrain_mid_elev_m` / `terrain_q3_elev_m`
/// are sampled at Stage 2A from the sub-segment's 0.25 / 0.5 / 0.75
/// points. All three intermediate samples are stored explicitly: real
/// DEM terrain isn't linearly interpolated between endpoints, so a
/// sharp peak between ADS-B samples (LOWI / SEQM / KASE mountain
/// airports) can sit tens of metres above the linear ridge. /gg rev 2
/// flagged that storing only `mid` lets a narrow spike at frac=0.25 or
/// 0.75 sneak through the AGL gate (verified by 3-of-4 reviewers).
pub fn airborne_schema() -> Arc<Schema> {
    let sub_struct = DataType::Struct(Fields::from(vec![
        Field::new("start_lat", DataType::Float32, false),
        Field::new("start_lon", DataType::Float32, false),
        Field::new("start_alt_m", DataType::Float32, false),
        Field::new("end_lat", DataType::Float32, false),
        Field::new("end_lon", DataType::Float32, false),
        Field::new("end_alt_m", DataType::Float32, false),
        Field::new("speed_kt", DataType::Float32, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("date_id", DataType::Int16, false),
        Field::new("flags", DataType::UInt8, false),
        Field::new("terrain_start_elev_m", DataType::Float32, false),
        Field::new("terrain_q1_elev_m", DataType::Float32, false),
        Field::new("terrain_mid_elev_m", DataType::Float32, false),
        Field::new("terrain_q3_elev_m", DataType::Float32, false),
        Field::new("terrain_end_elev_m", DataType::Float32, false),
    ]));
    let fields = vec![
        Field::new("flight_id", DataType::UInt64, false),
        Field::new("callsign", DataType::Utf8, false),
        Field::new("aircraft_type", DataType::FixedSizeBinary(4), false),
        Field::new("profile_idx", DataType::UInt8, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
        Field::new(
            "sub_segments",
            DataType::List(Arc::new(Field::new("item", sub_struct, false))),
            false,
        ),
        Field::new("total_length_m", DataType::Float32, false),
        Field::new("bbox_min_lat", DataType::Float32, false),
        Field::new("bbox_max_lat", DataType::Float32, false),
        Field::new("bbox_min_lon", DataType::Float32, false),
        Field::new("bbox_max_lon", DataType::Float32, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "airborne")])))
}

/// Max number of `top_candidates` entries written per cruise row. Rev 2
/// of the cruise rewrite caps the per-bucket fid pool at 50 so per-row
/// size stays bounded by `O(K)` regardless of `n_days`. Ranking
/// dimension: source-side peak Lmax at 25 m (NPD `lookup_lmax`). Plan
/// §2.1 assumes Spearman ≥ 0.9 between source-side peak Lmax and the
/// popup's receiver-side rank; not yet measured in tests — tracked
/// for the LKPR full-year integration check. Tail fids below K=50 drop
/// out of band counters — documented regression.
pub const CRUISE_TOP_K: usize = 50;

/// Per-candidate struct stored in `top_candidates`. Identity-only fields
/// the popup needs for the table display (callsign, typecode) plus the
/// ranking dimension (`peak_lmax_25m_db` = NPD `lookup_lmax` at the
/// 25 m anchor for the loudest segment this fid contributed to the
/// bucket) and `altitude_m` (needed for CPA + slant recompute against
/// the popup receiver). Row-constant fields (period / date_id) are NOT
/// duplicated per candidate.
pub fn cruise_top_candidate_fields() -> Fields {
    Fields::from(vec![
        Field::new("flight_id", DataType::UInt64, false),
        Field::new("callsign", DataType::Utf8, false),
        Field::new("aircraft_type", DataType::FixedSizeBinary(4), false),
        Field::new("peak_lmax_25m_db", DataType::Float32, false),
        Field::new("altitude_m", DataType::Float32, false),
    ])
}

/// Stage 2B — `h3r4/<hex>/cruise.arrow` (v14). One row per (R8, fl_bin,
/// class, period, is_dep) bucket. Per-fid lists (`cruise_flight_ids` /
/// `_aircraft_types` / `_callsigns`) of v13 are replaced by:
/// - `unique_count: UInt32` — distinct fids that contributed to the
///   bucket.
/// - `top_candidates: List<Struct>` — bounded top-K (K=50) ranked by
///   source-side peak Lmax at 25 m (NPD `lookup_lmax`).
pub fn cruise_schema() -> Arc<Schema> {
    let cand_struct = DataType::Struct(cruise_top_candidate_fields());
    let fields = vec![
        Field::new("r8_hex", DataType::UInt64, false),
        Field::new("class", DataType::UInt8, false),
        Field::new("rep_profile_idx", DataType::UInt8, false),
        Field::new("fl_bin", DataType::UInt8, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("flags", DataType::UInt8, false),
        Field::new("sum_length_m", DataType::Float32, false),
        Field::new("rep_len_m", DataType::Float32, false),
        Field::new("rep_alt_m", DataType::Float32, false),
        Field::new("rep_speed_kt", DataType::Float32, false),
        Field::new("unique_count", DataType::UInt32, false),
        Field::new(
            "top_candidates",
            DataType::List(Arc::new(Field::new("item", cand_struct, false))),
            false,
        ),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "cruise")])))
}

/// Airport traffic contract stamped into airport_traffic.arrow.
///
/// Counter-rows: one per (airport_key, osm_id, segment_idx, ops_kind,
/// is_departure, veh_kind, class_idx, period). `band_energy_lin` is
/// the daily-total linear Z-weighted energy at 25 m perpendicular
/// from this microsegment for this period (Σ per-event SEL across
/// the n_days window ÷ n_days at emission). Popup applies relative
/// propagation + A-weighting + ÷ period_s to get the period Leq.
///
/// v5 drops the per-row `flight_ids: List<UInt64>` (which scaled
/// linearly with `unique_rotations × n_days`) and replaces it with
/// scalar `unique_*_count` counters plus row-replicated
/// `microseg_unique_*` UNION counts. Airport-level unique counts move
/// to the per-popup `airport_summary.arrow` sidecar after a Stage 2C
/// reduce phase.
pub const AIRPORT_TRAFFIC_CONTRACT_V5: &str = "airport_traffic_v5";

/// Global airport summary sidecar contract (one row per airport_key,
/// truly unique counts across all R4s). Produced by Stage 2C v5
/// reduce phase from per-R4 `airport_summary_parts/` dumps.
pub const AIRPORT_SUMMARY_CONTRACT_V1: &str = "airport_summary_v1";

/// `geometry_kind` enum stamped on each airport_traffic row.
/// LINE: OSM runway / taxiway / stopway microsegment with real
/// start/end coords. AREA_GRID_POINT: pre-discretized apron point
/// (start == end). SYNTHETIC: row emitted by Stage 1.5 DBSCAN
/// auto-discovery for OSM-missing strips.
pub const GEOMETRY_KIND_LINE: u8 = 0;
pub const GEOMETRY_KIND_AREA_GRID_POINT: u8 = 1;
pub const GEOMETRY_KIND_SYNTHETIC: u8 = 2;

/// Number of GSE noise classes (LIGHT / MEDIUM / HEAVY) — exposed at
/// the schema layer so `airport_traffic.arrow` / sidecars can encode
/// per-class FixedSizeList<UInt32, NUM_GSE_CLASSES>. Mirrors
/// `noise_compute::emission::gse::NUM_GSE_CLASSES` but avoids the
/// runtime crate dep at schema-build time.
pub const NUM_GSE_CLASSES: i32 = 3;

/// `ops_kind` enum codomain size for per-kind unique-count arrays
/// (runway / taxi / apron — matches `GROUND_OPS_KIND_*` minus 1).
pub const NUM_OPS_KINDS: i32 = 3;

/// Stage 2C — `h3r4/<hex>/airport_traffic.arrow` (v5). One row per
/// per-segment per-period traffic counter. Per-row `flight_ids:
/// List<UInt64>` from v4 is replaced by:
/// - Per-row scalars: `unique_movement_count`, `unique_arr_count`,
///   `unique_dep_count`, `unique_gse_count_per_class`.
/// - Per-microsegment UNIONs (replicated on every row of the same
///   microsegment): `microseg_unique_count`, `microseg_unique_arr_count`,
///   `microseg_unique_dep_count`, `microseg_unique_gse_count_per_class`.
///
/// Airport-level UNION across R4s lives in the separate
/// `data/prepared/{year}/aircraft/airport_summary.arrow` sidecar.
pub fn airport_traffic_schema() -> Arc<Schema> {
    let gse_per_class = DataType::FixedSizeList(
        Arc::new(Field::new("item", DataType::UInt32, false)),
        NUM_GSE_CLASSES,
    );
    let fields = vec![
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("osm_id", DataType::UInt64, false),
        Field::new("segment_idx", DataType::UInt16, false),
        Field::new("geometry_kind", DataType::UInt8, false),
        Field::new("start_lat", DataType::Float32, false),
        Field::new("start_lon", DataType::Float32, false),
        Field::new("end_lat", DataType::Float32, false),
        Field::new("end_lon", DataType::Float32, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("ops_kind", DataType::UInt8, false),
        Field::new("is_departure", DataType::UInt8, false),
        Field::new("veh_kind", DataType::UInt8, false),
        Field::new("class_idx", DataType::UInt8, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("movements_per_day", DataType::Float32, false),
        // FixedSizeList enforces the 8-band invariant at the schema
        // level so the reader doesn't need a runtime `ensure!` guard.
        Field::new(
            "band_energy_lin",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, false)),
                noise_compute::types::NUM_BANDS as i32,
            ),
            false,
        ),
        // Per-row scalar unique counts replace the v4 `flight_ids:
        // List<UInt64>` payload. Each row carries ALL four counters;
        // only the per-row-key-relevant ones are non-zero (e.g.
        // arr_count populated only when (ops_kind=RUNWAY_ROLL,
        // is_departure=0, veh_kind=0)).
        Field::new("unique_movement_count", DataType::UInt32, false),
        Field::new("unique_arr_count", DataType::UInt32, false),
        Field::new("unique_dep_count", DataType::UInt32, false),
        Field::new(
            "unique_gse_count_per_class",
            gse_per_class.clone(),
            false,
        ),
        // Per-microsegment UNION (replicated across rows). Lets the
        // popup populate observed_movements_per_day per microsegment
        // without a UNION join over per-row scalars.
        Field::new("microseg_unique_count", DataType::UInt32, false),
        Field::new("microseg_unique_arr_count", DataType::UInt32, false),
        Field::new("microseg_unique_dep_count", DataType::UInt32, false),
        Field::new(
            "microseg_unique_gse_count_per_class",
            gse_per_class,
            false,
        ),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "airport_traffic"),
        ("airport_traffic_contract", AIRPORT_TRAFFIC_CONTRACT_V5),
    ])))
}

/// Verify a loaded airport_traffic.arrow file's metadata matches the
/// current [`AIRPORT_TRAFFIC_CONTRACT_V5`] contract. Older files MUST
/// be rejected — column layouts and `flight_ids` attribution
/// semantics differ across versions, so silent decoding would
/// produce wrong numbers downstream (historically: per-event-SEL
/// vs daily-total energy off by ~10·log10(n_days) ≈ 11.5 dB at
/// n_days=14, and longest-coverage attribution under-counting
/// per-microsegment movements roughly N× where N = avg microsegments
/// crossed per rotation).
pub fn assert_airport_traffic_contract_v5(
    metadata: &HashMap<String, String>,
) -> anyhow::Result<()> {
    match metadata.get("airport_traffic_contract").map(String::as_str) {
        Some(AIRPORT_TRAFFIC_CONTRACT_V5) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "airport_traffic_contract mismatch: expected {AIRPORT_TRAFFIC_CONTRACT_V5}, got {other}"
        )),
        None => Err(anyhow::anyhow!(
            "airport_traffic_contract metadata missing"
        )),
    }
}

/// Global airport_summary.arrow schema (one row per airport_key,
/// canonical truly-unique counts across all R4s). Output of Stage 2C
/// v5 reduce phase. Loaded once at popup query time; HashMap keyed by
/// airport_key.
pub fn airport_summary_schema() -> Arc<Schema> {
    let gse_per_class = DataType::FixedSizeList(
        Arc::new(Field::new("item", DataType::UInt32, false)),
        NUM_GSE_CLASSES,
    );
    let ops_per_kind = DataType::FixedSizeList(
        Arc::new(Field::new("item", DataType::UInt32, false)),
        NUM_OPS_KINDS,
    );
    let fields = vec![
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("airport_unique_arr_count", DataType::UInt32, false),
        Field::new("airport_unique_dep_count", DataType::UInt32, false),
        Field::new("airport_unique_gse_count_per_class", gse_per_class, false),
        Field::new("airport_unique_ops_count_per_kind", ops_per_kind, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "airport_summary"),
        ("airport_summary_contract", AIRPORT_SUMMARY_CONTRACT_V1),
    ])))
}

/// Verify metadata on `airport_summary.arrow`. Missing or stale →
/// hard error (popup MUST refuse to compute airport arr/dep counts
/// without a current sidecar; per-row sum is forbidden, see plan §4.3).
pub fn assert_airport_summary_contract_v1(
    metadata: &HashMap<String, String>,
) -> anyhow::Result<()> {
    match metadata.get("airport_summary_contract").map(String::as_str) {
        Some(AIRPORT_SUMMARY_CONTRACT_V1) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "airport_summary_contract mismatch: expected {AIRPORT_SUMMARY_CONTRACT_V1}, got {other}"
        )),
        None => Err(anyhow::anyhow!(
            "airport_summary_contract metadata missing"
        )),
    }
}

/// Stage 1.5 — `h3r4/<hex>/synth_airport_lines.arrow`. One row per
/// ≤50 m microsegment of a DBSCAN-discovered runway / airstrip for
/// OSM-missing airfields. Mirrors `airport_lines.arrow` (the real-OSM
/// counterpart in `osm-extract/finalize.rs`) but adds an explicit
/// `airport_key` column — synthetic clusters have no icao/iata/name
/// to derive identity from, so the writer encodes the
/// content-addressed `auto-<H3-R11-hex>` key directly on the row.
///
/// `osm_id` is `UInt64` (not `Int64` like the real file) so the
/// `1<<63` synthetic high-bit pattern round-trips unambiguously.
pub fn synth_airport_lines_schema() -> Arc<Schema> {
    let fields = vec![
        Field::new("osm_id", DataType::UInt64, false),
        Field::new("segment_idx", DataType::UInt16, false),
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("start_lat", DataType::Float64, false),
        Field::new("start_lon", DataType::Float64, false),
        Field::new("end_lat", DataType::Float64, false),
        Field::new("end_lon", DataType::Float64, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new("heading_deg", DataType::Float32, false),
        Field::new("aeroway_type", DataType::UInt8, false),
        Field::new("name", DataType::Utf8, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "synth_airport_lines"),
    ])))
}

/// Stage 1.5 — `h3r4/<hex>/synth_airport_areas.arrow`. One row per
/// DBSCAN-discovered cluster (= one row per synth airport).
/// Independent of the real `airport_areas.arrow`, so Stage 2C can
/// chain both sets when resolving airport identity.
pub fn synth_airport_areas_schema() -> Arc<Schema> {
    let fields = vec![
        Field::new("osm_id", DataType::UInt64, false),
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("aeroway_type", DataType::UInt8, false),
        Field::new("centroid_lat", DataType::Float64, false),
        Field::new("centroid_lon", DataType::Float64, false),
        Field::new("area_m2", DataType::Float32, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "synth_airport_areas"),
    ])))
}

/// Verify a loaded file's metadata matches the current
/// [`SCHEMA_VERSION`]. Reader-side guard so stale files raise a loud
/// error instead of silently producing gibberish numbers.
pub fn assert_schema_version(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
    match metadata.get("schema_version").map(String::as_str) {
        Some(SCHEMA_VERSION) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "schema_version mismatch: expected {SCHEMA_VERSION}, got {other}"
        )),
        None => Err(anyhow::anyhow!("schema_version metadata missing")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_schemas_carry_current_version_metadata() {
        for s in [
            flights_schema(),
            segments_schema(),
            airborne_schema(),
            cruise_schema(),
            airport_traffic_schema(),
            airport_summary_schema(),
            synth_airport_lines_schema(),
            synth_airport_areas_schema(),
        ] {
            let md = s.metadata();
            assert_eq!(
                md.get("schema_version").map(String::as_str),
                Some(SCHEMA_VERSION)
            );
            assert!(md.contains_key("kind"));
        }
    }

    #[test]
    fn synth_airport_schemas_carry_required_columns() {
        let lines = synth_airport_lines_schema();
        for required in [
            "osm_id", "segment_idx", "airport_key",
            "start_lat", "start_lon", "end_lat", "end_lon",
            "length_m", "heading_deg", "aeroway_type", "name",
        ] {
            assert!(
                lines.field_with_name(required).is_ok(),
                "synth_airport_lines schema must carry {required}"
            );
        }
        let areas = synth_airport_areas_schema();
        for required in [
            "osm_id", "airport_key", "name", "aeroway_type",
            "centroid_lat", "centroid_lon", "area_m2",
        ] {
            assert!(
                areas.field_with_name(required).is_ok(),
                "synth_airport_areas schema must carry {required}"
            );
        }
    }

    #[test]
    fn synth_airport_lines_osm_id_is_unsigned() {
        let lines = synth_airport_lines_schema();
        let field = lines.field_with_name("osm_id").unwrap();
        assert_eq!(
            field.data_type(),
            &DataType::UInt64,
            "synthetic osm_id must be UInt64 so the 1<<63 high-bit pattern round-trips"
        );
    }

    #[test]
    fn airport_traffic_schema_carries_contract_metadata() {
        let s = airport_traffic_schema();
        assert_eq!(
            s.metadata().get("airport_traffic_contract").map(String::as_str),
            Some(AIRPORT_TRAFFIC_CONTRACT_V5)
        );
    }

    #[test]
    fn airport_traffic_schema_has_required_columns() {
        let s = airport_traffic_schema();
        for required in [
            "airport_key", "osm_id", "segment_idx", "geometry_kind",
            "start_lat", "start_lon", "end_lat", "end_lon", "length_m",
            "ops_kind", "is_departure", "veh_kind", "class_idx", "period",
            "movements_per_day", "band_energy_lin",
            "unique_movement_count", "unique_arr_count", "unique_dep_count",
            "unique_gse_count_per_class",
            "microseg_unique_count", "microseg_unique_arr_count",
            "microseg_unique_dep_count", "microseg_unique_gse_count_per_class",
        ] {
            assert!(
                s.field_with_name(required).is_ok(),
                "airport_traffic schema must carry {required} column"
            );
        }
    }

    #[test]
    fn cruise_schema_has_v14_columns() {
        let s = cruise_schema();
        for required in [
            "r8_hex", "class", "rep_profile_idx", "fl_bin", "period",
            "flags", "sum_length_m", "rep_len_m", "rep_alt_m", "rep_speed_kt",
            "unique_count", "top_candidates", "source_id", "origin",
        ] {
            assert!(
                s.field_with_name(required).is_ok(),
                "cruise schema must carry {required} column"
            );
        }
        // v14 explicitly DROPS the per-fid lists.
        for dropped in ["cruise_flight_ids", "cruise_aircraft_types", "cruise_callsigns"] {
            assert!(
                s.field_with_name(dropped).is_err(),
                "cruise v14 schema must NOT carry the v13 {dropped} column"
            );
        }
    }

    #[test]
    fn airport_summary_schema_carries_contract_metadata() {
        let s = airport_summary_schema();
        assert_eq!(
            s.metadata().get("airport_summary_contract").map(String::as_str),
            Some(AIRPORT_SUMMARY_CONTRACT_V1)
        );
    }

    #[test]
    fn assert_airport_summary_contract_round_trip() {
        let s = airport_summary_schema();
        assert!(assert_airport_summary_contract_v1(s.metadata()).is_ok());
        let mut bogus = s.metadata().clone();
        bogus.insert(
            "airport_summary_contract".into(),
            "airport_summary_vBOGUS".into(),
        );
        assert!(assert_airport_summary_contract_v1(&bogus).is_err());
        bogus.remove("airport_summary_contract");
        assert!(assert_airport_summary_contract_v1(&bogus).is_err());
    }

    #[test]
    fn assert_schema_version_rejects_old_versions() {
        for old in ["v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12", "v13"] {
            let md: HashMap<String, String> =
                [("schema_version".into(), old.into())].into_iter().collect();
            assert!(
                assert_schema_version(&md).is_err(),
                "expected reject for {old}"
            );
        }
    }

    #[test]
    fn assert_schema_version_rejects_missing_metadata() {
        let md: HashMap<String, String> = HashMap::new();
        assert!(assert_schema_version(&md).is_err());
    }

}
