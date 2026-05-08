//! Arrow schemas for the five v6 artifacts. Every schema embeds
//! `schema_version = "v6"` in metadata so a v4/v5 reader can refuse
//! to load the wrong layout instead of silently mis-decoding it.

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

/// Stage 2C — `h3r4/<hex>/ground.arrow`. One row per OSM aeroway × kind
/// × period × 100 m sub-bucket. Per-band linear emission `Lw` so the
/// popup can call the same `propagate_variants_full` kernel as roads.
pub fn ground_schema() -> Arc<Schema> {
    let bands_field = || {
        DataType::List(Arc::new(Field::new("item", DataType::Float32, false)))
    };
    let mix_struct = DataType::Struct(Fields::from(vec![
        Field::new("class", DataType::UInt8, false),
        Field::new("share", DataType::Float32, false),
        Field::new("rep_typecode", DataType::FixedSizeBinary(4), false),
    ]));
    let fields = vec![
        Field::new("osm_id", DataType::Int64, false),
        Field::new("airport_key", DataType::Utf8, false),
        Field::new("ops_kind", DataType::UInt8, false),
        Field::new("period", DataType::UInt8, false),
        Field::new("sub_bucket_idx", DataType::UInt16, false),
        Field::new("em_day_bands", bands_field(), false),
        Field::new("em_eve_bands", bands_field(), false),
        Field::new("em_night_bands", bands_field(), false),
        Field::new("n_observed_per_day", DataType::Float32, false),
        Field::new("n_modeled_per_day", DataType::Float32, false),
        Field::new(
            "profile_mix",
            DataType::List(Arc::new(Field::new("item", mix_struct, false))),
            false,
        ),
        Field::new("line_start_lat", DataType::Float32, false),
        Field::new("line_start_lon", DataType::Float32, false),
        Field::new("line_end_lat", DataType::Float32, false),
        Field::new("line_end_lon", DataType::Float32, false),
        Field::new("line_length_m", DataType::Float32, false),
        Field::new("source_id", DataType::UInt8, false),
        Field::new("origin", DataType::UInt8, false),
    ];
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[("kind", "ground")])))
}

/// Verify a loaded file's metadata matches v6. Reader-side guard so
/// stale v4/v5 files raise a loud error instead of silently producing
/// gibberish numbers.
pub fn assert_v6(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
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
    fn all_schemas_carry_v6_metadata() {
        for s in [
            flights_schema(),
            segments_schema(),
            airborne_schema(),
            cruise_schema(),
            ground_schema(),
        ] {
            let md = s.metadata();
            assert_eq!(md.get("schema_version").map(String::as_str), Some("v6"));
            assert!(md.contains_key("kind"));
        }
    }

    #[test]
    fn assert_v6_rejects_v5() {
        let md: HashMap<String, String> =
            [("schema_version".into(), "v5".into())].into_iter().collect();
        assert!(assert_v6(&md).is_err());
    }
}
