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
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "segments")])))
}

/// Stage 2A — `h3r4/<hex>/airborne.arrow`. One row per (flight, R4)
/// crossing. `sub_segments` carries per-sub-segment period / date /
/// flags so a long crossing that straddles 19:00 still buckets right.
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

/// Stage 2B — `h3r4/<hex>/cruise.arrow`. One row per (R8, fl_bin,
/// class, period, is_dep) bucket.
pub fn cruise_schema() -> Arc<Schema> {
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
        Field::new(
            "cruise_flight_ids",
            DataType::List(Arc::new(Field::new("item", DataType::UInt64, false))),
            false,
        ),
        Field::new(
            "cruise_aircraft_types",
            DataType::List(Arc::new(Field::new(
                "item",
                DataType::FixedSizeBinary(4),
                false,
            ))),
            false,
        ),
        Field::new(
            "cruise_callsigns",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, false))),
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
/// the **daily total** linear Z-weighted energy at 25 m perpendicular
/// from this microsegment for this period (Stage 2C writer: Σ
/// per-event SEL across the n_days window, ÷ n_days at emission).
/// Phase 4 popup applies relative propagation + A-weighting + ÷
/// period_s to get the period Leq. `movements_per_day` is a true
/// display count of UNIQUE rotations attributed to this microsegment
/// (= `flight_ids.len() / n_days`, v3 dedup); caller MUST NOT
/// multiply it into the receiver chain — energy is already
/// integrated.
///
/// `_v3` bump: per-row `flight_ids: List<UInt64>` column carries the
/// sorted unique `flight_id`s attributed to this microsegment, and
/// `movements_per_day` is recomputed from `flight_ids.len()` instead
/// of the legacy per-FlightSegment-hit counter that over-counted by
/// 5–15× at busy airports.
///
/// `_v2` was the dimensional contract correction (per-movement SEL →
/// daily-total energy on 2026-05-15). `_v1` was per-movement SEL.
/// Older files MUST be rejected by
/// [`assert_airport_traffic_contract_v3`] to prevent silent
/// mis-decoding.
pub const AIRPORT_TRAFFIC_CONTRACT_V3: &str = "airport_traffic_v3";

/// `geometry_kind` enum stamped on each airport_traffic row.
/// LINE: OSM runway / taxiway / stopway microsegment with real
/// start/end coords. AREA_GRID_POINT: pre-discretized apron point
/// (start == end). SYNTHETIC: row emitted by Phase 5 DBSCAN
/// auto-discovery for OSM-missing strips.
pub const GEOMETRY_KIND_LINE: u8 = 0;
pub const GEOMETRY_KIND_AREA_GRID_POINT: u8 = 1;
pub const GEOMETRY_KIND_SYNTHETIC: u8 = 2;

/// Stage 2C — `h3r4/<hex>/airport_traffic.arrow`. One row per
/// per-segment per-period traffic counter (sparse on the
/// `(seg × class × period)` grid; `movements_per_day` may be `0.0`
/// when energy is non-zero, because each leg contributes the +1
/// movement only to the longest-coverage segment but spreads band
/// energy to every intersected segment). Per-microsegment counters
/// keep the file size near-constant in `n_days` (the dominant
/// per-counter-row part is fixed; `flight_ids` adds 8 B per unique
/// rotation observed, so the column scales linearly with activity,
/// not with the time window directly), replacing the legacy
/// per-rotation paths model retired in Phase 6.
pub fn airport_traffic_schema() -> Arc<Schema> {
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
        // Encoding-cost wise it also drops the per-row offsets buffer.
        Field::new(
            "band_energy_lin",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, false)),
                noise_compute::types::NUM_BANDS as i32,
            ),
            false,
        ),
        // Variable-length List — flight count per row depends on
        // airport activity (a quiet strip may have 1, LKPR runway
        // microsegment can have 100s in 14 d). Sorted ascending so
        // on-disk bytes are deterministic across re-extracts.
        Field::new(
            "flight_ids",
            DataType::List(Arc::new(Field::new("item", DataType::UInt64, false))),
            false,
        ),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "airport_traffic"),
        ("airport_traffic_contract", AIRPORT_TRAFFIC_CONTRACT_V3),
    ])))
}

/// Verify a loaded airport_traffic.arrow file's metadata matches the
/// current [`AIRPORT_TRAFFIC_CONTRACT_V3`] contract. Older files
/// (v1, v2) MUST be rejected — their column layout lacks `flight_ids`
/// and their `movements_per_day` carried a 5–15× over-count of real
/// rotations that would silently mislead any downstream display.
pub fn assert_airport_traffic_contract_v3(
    metadata: &HashMap<String, String>,
) -> anyhow::Result<()> {
    match metadata.get("airport_traffic_contract").map(String::as_str) {
        Some(AIRPORT_TRAFFIC_CONTRACT_V3) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "airport_traffic_contract mismatch: expected {AIRPORT_TRAFFIC_CONTRACT_V3}, got {other}"
        )),
        None => Err(anyhow::anyhow!(
            "airport_traffic_contract metadata missing"
        )),
    }
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
    fn airport_traffic_schema_carries_contract_metadata() {
        let s = airport_traffic_schema();
        assert_eq!(
            s.metadata().get("airport_traffic_contract").map(String::as_str),
            Some(AIRPORT_TRAFFIC_CONTRACT_V3)
        );
    }

    #[test]
    fn airport_traffic_schema_has_required_columns() {
        let s = airport_traffic_schema();
        for required in [
            "airport_key", "osm_id", "segment_idx", "geometry_kind",
            "start_lat", "start_lon", "end_lat", "end_lon", "length_m",
            "ops_kind", "is_departure", "veh_kind", "class_idx", "period",
            "movements_per_day", "band_energy_lin", "flight_ids",
        ] {
            assert!(
                s.field_with_name(required).is_ok(),
                "airport_traffic schema must carry {required} column"
            );
        }
    }

    #[test]
    fn assert_schema_version_rejects_old_versions() {
        for old in ["v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11"] {
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
