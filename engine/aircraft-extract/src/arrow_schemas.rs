//! Arrow schemas for the five v7 artifacts. Every schema embeds
//! `schema_version = "v7"` in metadata so the reader can refuse old
//! v4/v5/v6 layouts instead of silently mis-decoding them.

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
/// `dB_sum_v7_1` means each `em_*_bands[i]` stores `10*log10(Σ 10^(x/10))`
/// — energies summed in linear space, written back as dB SPL — and silent
/// bands round-trip as `f32::NEG_INFINITY`. dB-band storage was chosen
/// because the popup's `propagate_variants_full` already consumes dB
/// band levels natively; storing linear would force extract→dB and
/// reader→linear conversions on every row. The tag also lets the reader
/// reject earlier ground.arrow files (pre-`dB_sum_v6_1`, where Stage 2C
/// summed dB values as if they were linear — mathematically wrong by
/// ~10 dB).
pub const GROUND_CONTRACT_DB_SUM_V7_1: &str = "dB_sum_v7_1";

/// Stage 2C — `h3r4/<hex>/ground.arrow`. One row per
/// (osm_id × ops_kind × sub_bucket_idx); period is *not* in the bucket
/// key — each row carries all three `em_day/eve/night_bands` so the
/// popup reads Lden from a single row, and silent periods round-trip as
/// `[NEG_INFINITY; 8]`. See [`GROUND_CONTRACT_DB_SUM_V7_1`] for energy
/// semantics.
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
    Arc::new(Schema::new(fields).with_metadata(base_metadata(&[
        ("kind", "ground"),
        ("ground_contract", GROUND_CONTRACT_DB_SUM_V7_1),
    ])))
}

/// Verify a loaded file's metadata matches the current
/// [`SCHEMA_VERSION`]. Reader-side guard so stale (pre-v7) files raise
/// a loud error instead of silently producing gibberish numbers.
pub fn assert_schema_v7(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
    match metadata.get("schema_version").map(String::as_str) {
        Some(SCHEMA_VERSION) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "schema_version mismatch: expected {SCHEMA_VERSION}, got {other}"
        )),
        None => Err(anyhow::anyhow!("schema_version metadata missing")),
    }
}

/// Verify ground.arrow metadata carries the `dB_sum_v7_1` energy
/// contract. Pre-v7 ground files lack this key (or carry the older
/// `dB_sum_v6_1`) — accepting them would feed the popup band levels
/// off by roughly 10 dB.
pub fn assert_ground_contract_v7_1(metadata: &HashMap<String, String>) -> anyhow::Result<()> {
    assert_schema_v7(metadata)?;
    match metadata.get("ground_contract").map(String::as_str) {
        Some(GROUND_CONTRACT_DB_SUM_V7_1) => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "ground_contract mismatch: expected {GROUND_CONTRACT_DB_SUM_V7_1}, got {other}"
        )),
        None => Err(anyhow::anyhow!(
            "ground_contract metadata missing — re-extract Stage 2C with C1 build"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_schemas_carry_v7_metadata() {
        for s in [
            flights_schema(),
            segments_schema(),
            airborne_schema(),
            cruise_schema(),
            ground_schema(),
        ] {
            let md = s.metadata();
            assert_eq!(md.get("schema_version").map(String::as_str), Some("v7"));
            assert!(md.contains_key("kind"));
        }
    }

    #[test]
    fn assert_schema_v7_rejects_old_versions() {
        for old in ["v4", "v5", "v6"] {
            let md: HashMap<String, String> =
                [("schema_version".into(), old.into())].into_iter().collect();
            assert!(assert_schema_v7(&md).is_err(), "expected reject for {old}");
        }
    }

    #[test]
    fn assert_schema_v7_rejects_missing_metadata() {
        let md: HashMap<String, String> = HashMap::new();
        assert!(assert_schema_v7(&md).is_err());
    }

    #[test]
    fn ground_schema_carries_ground_contract_metadata() {
        let s = ground_schema();
        assert_eq!(
            s.metadata().get("ground_contract").map(String::as_str),
            Some(GROUND_CONTRACT_DB_SUM_V7_1)
        );
    }

    #[test]
    fn ground_schema_drops_period_field() {
        let s = ground_schema();
        assert!(
            s.field_with_name("period").is_err(),
            "period must not appear in ground schema (each row carries em_day/eve/night)"
        );
    }

    #[test]
    fn assert_ground_contract_v7_1_rejects_pre_v7_files() {
        let md: HashMap<String, String> = [
            ("schema_version".into(), "v6".into()),
            ("kind".into(), "ground".into()),
        ]
        .into_iter()
        .collect();
        assert!(assert_ground_contract_v7_1(&md).is_err());
    }

    #[test]
    fn assert_ground_contract_v7_1_accepts_current_schema() {
        let s = ground_schema();
        assert!(assert_ground_contract_v7_1(s.metadata()).is_ok());
    }
}
