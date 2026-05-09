//! Arrow schemas for the five v10 artifacts. Every schema embeds
//! `schema_version = "v10"` in metadata so the reader can refuse old
//! v4..v9 layouts instead of silently mis-decoding them.

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
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "cruise")])))
}

/// Ground emission contract stamped into ground.arrow metadata.
///
/// `raw_paths_v10` means each row is one aircraft × one contiguous
/// ground path: a polyline of `vertices` plus per-leg `em_bands`,
/// `ops_kind`, and `count_weight = 1 / n_legs_of_this_kind_in_path`.
/// Energy is stored in dB SPL per leg (silent bands round-trip as
/// `f32::NEG_INFINITY`); applying `count_weight` while summing across
/// same-kind legs reconstructs one movement's reference SEL energy.
/// The tag lets the reader reject pre-v10 ground files where energy
/// was per-bucket-aggregated (`dB_sum_v7_1`) — feeding either contract
/// into the wrong consumer mis-counts movements by 10–20 dB.
pub const GROUND_CONTRACT_RAW_PATHS_V10: &str = "raw_paths_v10";

/// Stage 2C — `h3r4/<hex>/ground.arrow`. One row per aircraft × one
/// contiguous ground path. `vertices` are the consecutive
/// `FlightSegment` endpoints (segN.start = segN-1.end); `legs[i]`
/// joins `vertices[start_idx]` to `vertices[end_idx]` with an
/// `ops_kind` (post-smoothing), a `count_weight = 1 /
/// n_legs_of_this_kind_in_path` for energy normalization, and
/// `em_bands` (8 floats, dB per Doc 29 octave centre — silent rows
/// round-trip as `f32::NEG_INFINITY`). The path header carries the
/// path's representative period and date so silent periods don't need
/// per-leg em_day/eve/night triples. See [`GROUND_CONTRACT_RAW_PATHS_V10`]
/// for energy semantics.
pub fn ground_schema() -> Arc<Schema> {
    let vertex_struct = DataType::Struct(Fields::from(vec![
        Field::new("lat", DataType::Float32, false),
        Field::new("lon", DataType::Float32, false),
        Field::new("alt_m", DataType::Float32, false),
        Field::new("speed_kt", DataType::Float32, false),
        Field::new("ts_offset_s", DataType::Float32, false),
    ]));
    let leg_struct = DataType::Struct(Fields::from(vec![
        Field::new("start_idx", DataType::UInt16, false),
        Field::new("end_idx", DataType::UInt16, false),
        Field::new("ops_kind", DataType::UInt8, false),
        Field::new("count_weight", DataType::Float32, false),
        Field::new("length_m", DataType::Float32, false),
        Field::new(
            "em_bands",
            DataType::List(Arc::new(Field::new("item", DataType::Float32, false))),
            false,
        ),
    ]));
    let fields = vec![
        Field::new("flight_id", DataType::UInt64, false),
        Field::new("callsign", DataType::Utf8, false),
        Field::new("aircraft_type", DataType::FixedSizeBinary(4), false),
        Field::new("profile_idx", DataType::UInt8, false),
        Field::new("airport_key", DataType::Utf8, false),
        Field::new(
            "vertices",
            DataType::List(Arc::new(Field::new("item", vertex_struct, false))),
            false,
        ),
        Field::new(
            "legs",
            DataType::List(Arc::new(Field::new("item", leg_struct, false))),
            false,
        ),
        Field::new("length_m_runway", DataType::Float32, false),
        Field::new("length_m_taxi", DataType::Float32, false),
        Field::new("length_m_apron", DataType::Float32, false),
        Field::new("period_rep", DataType::UInt8, false),
        Field::new("date_id", DataType::Int16, false),
        Field::new("is_departure", DataType::UInt8, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "ground"),
        ("ground_contract", GROUND_CONTRACT_RAW_PATHS_V10),
    ])))
}

/// Verify a loaded file's metadata matches the current
/// [`SCHEMA_VERSION`]. Reader-side guard so stale (pre-v10) files raise
/// a loud error instead of silently producing gibberish numbers.
pub fn assert_schema_v10(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
    match metadata.get("schema_version").map(String::as_str) {
        Some(SCHEMA_VERSION) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "schema_version mismatch: expected {SCHEMA_VERSION}, got {other}"
        )),
        None => Err(anyhow::anyhow!("schema_version metadata missing")),
    }
}

/// Verify ground.arrow metadata carries the `raw_paths_v10` contract.
/// Pre-v10 ground files carry `dB_sum_v7_1` (per-bucket aggregated
/// energy) — accepting them in the v10 reader would mis-interpret
/// per-bucket sums as per-leg energies and over-count by 10–20 dB.
pub fn assert_ground_contract_v10(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
    assert_schema_v10(metadata)?;
    match metadata.get("ground_contract").map(String::as_str) {
        Some(GROUND_CONTRACT_RAW_PATHS_V10) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "ground_contract mismatch: expected {GROUND_CONTRACT_RAW_PATHS_V10}, got {other}"
        )),
        None => Err(anyhow::anyhow!(
            "ground_contract metadata missing — re-extract Stage 2C with the v10 build"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_schemas_carry_v10_metadata() {
        for s in [
            flights_schema(),
            segments_schema(),
            airborne_schema(),
            cruise_schema(),
            ground_schema(),
        ] {
            let md = s.metadata();
            assert_eq!(md.get("schema_version").map(String::as_str), Some("v10"));
            assert!(md.contains_key("kind"));
        }
    }

    #[test]
    fn assert_schema_v10_rejects_old_versions() {
        for old in ["v4", "v5", "v6", "v7", "v8", "v9"] {
            let md: HashMap<String, String> =
                [("schema_version".into(), old.into())].into_iter().collect();
            assert!(assert_schema_v10(&md).is_err(), "expected reject for {old}");
        }
    }

    #[test]
    fn assert_schema_v10_rejects_missing_metadata() {
        let md: HashMap<String, String> = HashMap::new();
        assert!(assert_schema_v10(&md).is_err());
    }

    #[test]
    fn ground_schema_carries_ground_contract_metadata() {
        let s = ground_schema();
        assert_eq!(
            s.metadata().get("ground_contract").map(String::as_str),
            Some(GROUND_CONTRACT_RAW_PATHS_V10)
        );
    }

    #[test]
    fn ground_schema_carries_path_columns() {
        let s = ground_schema();
        for required in ["vertices", "legs", "airport_key", "period_rep", "is_departure"] {
            assert!(
                s.field_with_name(required).is_ok(),
                "ground schema must carry {required} column"
            );
        }
        for retired in [
            "osm_id",
            "ops_kind",
            "sub_bucket_idx",
            "em_day_bands",
            "line_start_lat",
            "profile_mix",
        ] {
            assert!(
                s.field_with_name(retired).is_err(),
                "{retired} must NOT appear in v10 ground schema"
            );
        }
    }

    #[test]
    fn assert_ground_contract_v10_rejects_pre_v10_files() {
        let md: HashMap<String, String> = [
            ("schema_version".into(), "v9".into()),
            ("kind".into(), "ground".into()),
            ("ground_contract".into(), "dB_sum_v7_1".into()),
        ]
        .into_iter()
        .collect();
        assert!(assert_ground_contract_v10(&md).is_err());
    }

    #[test]
    fn assert_ground_contract_v10_accepts_current_schema() {
        let s = ground_schema();
        assert!(assert_ground_contract_v10(s.metadata()).is_ok());
    }
}
