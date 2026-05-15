//! Reader + writer for `synth_airport_lines.arrow` and
//! `synth_airport_areas.arrow` — the Stage 1.5 sidecar that DBSCAN
//! auto-discovery writes per R4 for OSM-missing airfields. Stage 2C's
//! `R4Cache::load` chains both sets with the real OSM files.
//!
//! Identity, encoding, and the "synthetic high bit" invariant are
//! documented next to [`SYNTHETIC_OSM_ID_BIT`] below.

// This module ships in the first of 5 commits wiring DBSCAN
// auto-discovery into `run-all`. Commits 2-4 add the runner, Stage 2C
// concat, and run-all wiring respectively — until then the readers /
// writers / identity helpers are exercised only by the unit tests in
// this module. Drop the allow after commit 4 lands.
#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    Array, Float32Array, Float32Builder, Float64Array, Float64Builder, StringArray, StringBuilder,
    UInt16Array, UInt16Builder, UInt64Array, UInt64Builder, UInt8Array, UInt8Builder,
};
use arrow::record_batch::RecordBatch;
use h3o::{CellIndex, Resolution};

use crate::arrow_io::{read_all_batches, write_record_batches};
use crate::arrow_schemas::{synth_airport_areas_schema, synth_airport_lines_schema};
use crate::geo::lat_lon_to_cell;

/// High bit on `osm_id` marks the value as synthetic (emitted by
/// Stage 1.5 DBSCAN, not by OSM). Real OSM IDs — both ways and
/// relations — are written as positive `i64` in this codebase
/// (`osm-extract/main.rs:200,287` passes `way.id()` / `rel.id()`
/// directly, no negation), so the high bit is always 0 for real
/// rows. Flipping bit 63 cannot collide.
///
/// **Encoding**: `osm_id = SYNTHETIC_OSM_ID_BIT | u64::from(cell)`,
/// where `cell` is the H3 R11 index of the cluster centroid. R11
/// has ~25 m edge length; DBSCAN clusters with eps=200m, so one
/// cluster centroid maps to one cell. Cell-mode H3 indices have
/// bit 63 = 0, so the OR-set is non-destructive and reversible
/// (strip the bit to recover the original CellIndex).
///
/// **INVARIANT**: synthetic `osm_id` never crosses the Rust→JSON
/// boundary. Today `Contributor.osm_id` is `None` on the
/// airport_traffic popup path, so this holds trivially. Any future
/// SegmentTrace emitter for airport_traffic must mask the high bit
/// before serialisation — JS `Number` silently truncates `u64 > 2⁵³`.
pub(crate) const SYNTHETIC_OSM_ID_BIT: u64 = 1u64 << 63;

/// Aeroway-type sentinel for synthetic airstrip lines. Mirrors the
/// real OSM convention (`osm-extract/classify.rs::aeroway_type` —
/// 0=runway, 1=taxiway, 6=stopway, 7=airstrip).
pub(crate) const AIRSTRIP_AEROWAY_TYPE: u8 = 7;

/// Aeroway-type sentinel for the synthetic airport area row.
/// Same value as `airport_io::AERODROME_AEROWAY_TYPE` — re-stating
/// here keeps the synth module self-contained for callers that
/// don't pull `airport_io` in.
pub(crate) const SYNTH_AERODROME_AEROWAY_TYPE: u8 = 5;

/// Inner helper — converts a centroid to its H3 R11 cell. Shared by
/// both `synth_osm_id_for` and `synth_airport_key_for` so the two
/// encoders cannot drift (e.g. if a future commit changes the
/// resolution in one path and forgets the other).
fn synth_h3_r11(lat: f64, lon: f64) -> CellIndex {
    lat_lon_to_cell(lat, lon, Resolution::Eleven)
        .expect("DBSCAN centroid must be a finite, in-range lat/lon")
}

/// Encode a cluster centroid's H3-R11 cell into the synthetic
/// `osm_id` space. See [`SYNTHETIC_OSM_ID_BIT`] for the encoding.
pub(crate) fn synth_osm_id_for(lat: f64, lon: f64) -> u64 {
    SYNTHETIC_OSM_ID_BIT | u64::from(synth_h3_r11(lat, lon))
}

/// Encode a cluster centroid's H3-R11 cell into the `airport_key`
/// string. Format: `auto-<15-hex-chars>`. Stable across re-extracts
/// for centroids that fall in the same R11 cell.
pub(crate) fn synth_airport_key_for(lat: f64, lon: f64) -> String {
    format!("auto-{}", synth_h3_r11(lat, lon))
}

/// Display name surfaced in the popup as
/// `"Aircraft - <name> ground ops"`. Format:
/// `"Auto airfield <lat>,<lon> (<length_m> m, <visits> visits)"`.
/// Concrete enough that a user recognises it as a strip and can
/// visually locate it on the map via the coordinate prefix.
pub(crate) fn synth_display_name(lat: f64, lon: f64, length_m: f32, visits: u32) -> String {
    format!("Auto airfield {lat:.2},{lon:.2} ({length_m:.0} m, {visits} visits)")
}

/// One row of `synth_airport_lines.arrow`. Carries an explicit
/// `airport_key` because synthetic clusters have no icao/iata/name
/// to derive identity from (unlike real OSM aerodromes).
#[derive(Debug, Clone)]
pub(crate) struct SynthAirportLineRow {
    pub osm_id: u64,
    pub segment_idx: u16,
    pub airport_key: String,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub heading_deg: f32,
    pub aeroway_type: u8,
    pub name: String,
}

/// One row of `synth_airport_areas.arrow`. Mirrors the relevant
/// columns of the real `airport_areas.arrow` (sans icao/iata/wkb)
/// so the rest of the pipeline can chain real + synth areas in
/// one iterator.
#[derive(Debug, Clone)]
pub(crate) struct SynthAirportAreaRow {
    pub osm_id: u64,
    pub airport_key: String,
    pub name: String,
    pub aeroway_type: u8,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub area_m2: f32,
}

/// Truncate-and-rewrite `synth_airport_lines.arrow` at `path`.
/// Routes through [`crate::arrow_io::write_record_batches`] for the
/// sibling-`.tmp` + rename atomicity guarantee and the
/// `create_dir_all` on the parent — so a missing R4 directory at
/// the destination is created on first emission.
pub(crate) fn write_synth_airport_lines(
    path: &Path,
    rows: &[SynthAirportLineRow],
) -> Result<()> {
    let n = rows.len();
    let schema = synth_airport_lines_schema();

    let mut osm_id = UInt64Builder::with_capacity(n);
    let mut seg_idx = UInt16Builder::with_capacity(n);
    let mut airport_key = StringBuilder::with_capacity(n, n * 24);
    let mut slat = Float64Builder::with_capacity(n);
    let mut slon = Float64Builder::with_capacity(n);
    let mut elat = Float64Builder::with_capacity(n);
    let mut elon = Float64Builder::with_capacity(n);
    let mut len = Float32Builder::with_capacity(n);
    let mut heading = Float32Builder::with_capacity(n);
    let mut atype = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 48);

    for r in rows {
        osm_id.append_value(r.osm_id);
        seg_idx.append_value(r.segment_idx);
        airport_key.append_value(&r.airport_key);
        slat.append_value(r.start_lat);
        slon.append_value(r.start_lon);
        elat.append_value(r.end_lat);
        elon.append_value(r.end_lon);
        len.append_value(r.length_m);
        heading.append_value(r.heading_deg);
        atype.append_value(r.aeroway_type);
        name.append_value(&r.name);
    }

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(seg_idx.finish()),
            Arc::new(airport_key.finish()),
            Arc::new(slat.finish()),
            Arc::new(slon.finish()),
            Arc::new(elat.finish()),
            Arc::new(elon.finish()),
            Arc::new(len.finish()),
            Arc::new(heading.finish()),
            Arc::new(atype.finish()),
            Arc::new(name.finish()),
        ],
    )?;

    write_record_batches(path, &schema, &[batch])
}

/// Truncate-and-rewrite `synth_airport_areas.arrow` at `path`. Same
/// atomic + parent-create behaviour as [`write_synth_airport_lines`].
pub(crate) fn write_synth_airport_areas(
    path: &Path,
    rows: &[SynthAirportAreaRow],
) -> Result<()> {
    let n = rows.len();
    let schema = synth_airport_areas_schema();

    let mut osm_id = UInt64Builder::with_capacity(n);
    let mut airport_key = StringBuilder::with_capacity(n, n * 24);
    let mut name = StringBuilder::with_capacity(n, n * 48);
    let mut atype = UInt8Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut area = Float32Builder::with_capacity(n);

    for r in rows {
        osm_id.append_value(r.osm_id);
        airport_key.append_value(&r.airport_key);
        name.append_value(&r.name);
        atype.append_value(r.aeroway_type);
        clat.append_value(r.centroid_lat);
        clon.append_value(r.centroid_lon);
        area.append_value(r.area_m2);
    }

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(airport_key.finish()),
            Arc::new(name.finish()),
            Arc::new(atype.finish()),
            Arc::new(clat.finish()),
            Arc::new(clon.finish()),
            Arc::new(area.finish()),
        ],
    )?;

    write_record_batches(path, &schema, &[batch])
}

fn col_u64<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a UInt64Array> {
    b.column_by_name(n)?.as_any().downcast_ref()
}
fn col_u16<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a UInt16Array> {
    b.column_by_name(n)?.as_any().downcast_ref()
}
fn col_u8<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a UInt8Array> {
    b.column_by_name(n)?.as_any().downcast_ref()
}
fn col_str<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a StringArray> {
    b.column_by_name(n)?.as_any().downcast_ref()
}
fn col_f64<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a Float64Array> {
    b.column_by_name(n)?.as_any().downcast_ref()
}
fn col_f32<'a>(b: &'a RecordBatch, n: &str) -> Option<&'a Float32Array> {
    b.column_by_name(n)?.as_any().downcast_ref()
}

/// Read `synth_airport_lines.arrow`. Missing file → empty vec (the
/// per-R4 sidecar is absent when Stage 1.5 found no clusters there).
/// Routes through [`crate::arrow_io::read_all_batches`] for the
/// `schema_version` guard — stale files raise loudly instead of
/// silently decoding as zero rows.
pub(crate) fn read_synth_airport_lines(path: &Path) -> Result<Vec<SynthAirportLineRow>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let (_schema, batches) = read_all_batches(path)?;
    for batch in batches {
        let n = batch.num_rows();
        let (
            Some(osm_id),
            Some(seg),
            Some(key),
            Some(sla),
            Some(slo),
            Some(ela),
            Some(elo),
            Some(len),
            Some(hd),
            Some(at),
            Some(name),
        ) = (
            col_u64(&batch, "osm_id"),
            col_u16(&batch, "segment_idx"),
            col_str(&batch, "airport_key"),
            col_f64(&batch, "start_lat"),
            col_f64(&batch, "start_lon"),
            col_f64(&batch, "end_lat"),
            col_f64(&batch, "end_lon"),
            col_f32(&batch, "length_m"),
            col_f32(&batch, "heading_deg"),
            col_u8(&batch, "aeroway_type"),
            col_str(&batch, "name"),
        )
        else {
            anyhow::bail!(
                "synth_airport_lines.arrow at {} is missing required columns; \
                 re-extract the aircraft pipeline",
                path.display()
            );
        };
        for i in 0..n {
            out.push(SynthAirportLineRow {
                osm_id: osm_id.value(i),
                segment_idx: seg.value(i),
                airport_key: key.value(i).to_string(),
                start_lat: sla.value(i),
                start_lon: slo.value(i),
                end_lat: ela.value(i),
                end_lon: elo.value(i),
                length_m: len.value(i),
                heading_deg: hd.value(i),
                aeroway_type: at.value(i),
                name: name.value(i).to_string(),
            });
        }
    }
    Ok(out)
}

/// Read `synth_airport_areas.arrow`. Missing file → empty vec.
pub(crate) fn read_synth_airport_areas(path: &Path) -> Result<Vec<SynthAirportAreaRow>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let (_schema, batches) = read_all_batches(path)?;
    for batch in batches {
        let n = batch.num_rows();
        let (
            Some(osm_id),
            Some(key),
            Some(name),
            Some(at),
            Some(clat),
            Some(clon),
            Some(area),
        ) = (
            col_u64(&batch, "osm_id"),
            col_str(&batch, "airport_key"),
            col_str(&batch, "name"),
            col_u8(&batch, "aeroway_type"),
            col_f64(&batch, "centroid_lat"),
            col_f64(&batch, "centroid_lon"),
            col_f32(&batch, "area_m2"),
        )
        else {
            anyhow::bail!(
                "synth_airport_areas.arrow at {} is missing required columns; \
                 re-extract the aircraft pipeline",
                path.display()
            );
        };
        for i in 0..n {
            out.push(SynthAirportAreaRow {
                osm_id: osm_id.value(i),
                airport_key: key.value(i).to_string(),
                name: name.value(i).to_string(),
                aeroway_type: at.value(i),
                centroid_lat: clat.value(i),
                centroid_lon: clon.value(i),
                area_m2: area.value(i),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn synth_osm_id_high_bit_set() {
        let id = synth_osm_id_for(50.1, 14.26);
        assert_eq!(
            id & SYNTHETIC_OSM_ID_BIT,
            SYNTHETIC_OSM_ID_BIT,
            "bit 63 must be set on every synthetic osm_id"
        );
    }

    #[test]
    fn synth_osm_id_preserves_full_cell_index() {
        // Reversibility: stripping the high bit must recover the
        // original CellIndex. This guards against any future change
        // that re-introduces a payload mask.
        let cell = synth_h3_r11(50.1, 14.26);
        let id = synth_osm_id_for(50.1, 14.26);
        let recovered = id & !SYNTHETIC_OSM_ID_BIT;
        assert_eq!(recovered, u64::from(cell));
    }

    #[test]
    fn synth_osm_id_deterministic_for_same_centroid() {
        // Stability claim: identical (lat, lon) → identical id on
        // every call. DBSCAN clusters with eps=200m, so a single
        // cluster's centroid is computed once per re-extract — the
        // stability guarantee is "same centroid coords → same id",
        // not "any two points within 25 m → same id" (which is
        // false near hex boundaries).
        let a = synth_osm_id_for(50.10000, 14.26000);
        let b = synth_osm_id_for(50.10000, 14.26000);
        assert_eq!(a, b);
    }

    #[test]
    fn synth_osm_id_distinct_for_far_centroids() {
        let a = synth_osm_id_for(50.1, 14.26);
        let b = synth_osm_id_for(50.5, 14.26);
        assert_ne!(a, b);
    }

    #[test]
    fn airport_key_format_and_resolution() {
        let key = synth_airport_key_for(50.1, 14.26);
        assert!(key.starts_with("auto-"));
        let suffix = key.strip_prefix("auto-").unwrap();
        let cell = CellIndex::from_str(suffix)
            .expect("airport_key suffix must parse back into a CellIndex");
        assert_eq!(
            cell.resolution(),
            Resolution::Eleven,
            "airport_key must encode an R11 cell — guards against drift in synth_h3_r11"
        );
    }

    #[test]
    fn airport_key_deterministic_for_same_centroid() {
        let a = synth_airport_key_for(50.10000, 14.26000);
        let b = synth_airport_key_for(50.10000, 14.26000);
        assert_eq!(a, b);
    }

    #[test]
    fn osm_id_and_airport_key_describe_same_cell() {
        // Shared synth_h3_r11 helper means osm_id and airport_key
        // cannot encode different cells. Verify the invariant
        // explicitly so any future drift fires loudly.
        let id = synth_osm_id_for(50.1, 14.26);
        let key = synth_airport_key_for(50.1, 14.26);
        let suffix = key.strip_prefix("auto-").unwrap();
        let cell = CellIndex::from_str(suffix).unwrap();
        assert_eq!(id & !SYNTHETIC_OSM_ID_BIT, u64::from(cell));
    }

    #[test]
    fn display_name_includes_lat_lon_length_visits() {
        let name = synth_display_name(50.1234, 14.2567, 820.0, 142);
        assert!(name.contains("50.12"));
        assert!(name.contains("14.26"));
        assert!(name.contains("820"));
        assert!(name.contains("142"));
    }

    fn sample_lines_row(seg_idx: u16) -> SynthAirportLineRow {
        SynthAirportLineRow {
            osm_id: synth_osm_id_for(50.1, 14.26),
            segment_idx: seg_idx,
            airport_key: synth_airport_key_for(50.1, 14.26),
            start_lat: 50.1,
            start_lon: 14.26,
            end_lat: 50.105,
            end_lon: 14.27,
            length_m: 500.0,
            heading_deg: 60.0,
            aeroway_type: AIRSTRIP_AEROWAY_TYPE,
            name: synth_display_name(50.1, 14.26, 500.0, 88),
        }
    }

    fn sample_areas_row() -> SynthAirportAreaRow {
        SynthAirportAreaRow {
            osm_id: synth_osm_id_for(50.1, 14.26),
            airport_key: synth_airport_key_for(50.1, 14.26),
            name: synth_display_name(50.1, 14.26, 500.0, 88),
            aeroway_type: SYNTH_AERODROME_AEROWAY_TYPE,
            centroid_lat: 50.1,
            centroid_lon: 14.26,
            area_m2: 25000.0,
        }
    }

    #[test]
    fn write_then_read_lines_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("synth_airport_lines.arrow");
        let rows = vec![sample_lines_row(0), sample_lines_row(1)];
        write_synth_airport_lines(&path, &rows).unwrap();
        let back = read_synth_airport_lines(&path).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].osm_id, rows[0].osm_id);
        assert_eq!(back[0].airport_key, rows[0].airport_key);
        assert_eq!(back[1].segment_idx, 1);
        assert_eq!(back[0].name, rows[0].name);
        assert_eq!(back[0].aeroway_type, AIRSTRIP_AEROWAY_TYPE);
    }

    #[test]
    fn write_then_read_areas_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("synth_airport_areas.arrow");
        let row = sample_areas_row();
        write_synth_airport_areas(&path, std::slice::from_ref(&row)).unwrap();
        let back = read_synth_airport_areas(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].airport_key, row.airport_key);
        assert_eq!(back[0].area_m2, row.area_m2);
        assert_eq!(back[0].aeroway_type, SYNTH_AERODROME_AEROWAY_TYPE);
    }

    #[test]
    fn read_missing_file_returns_empty_vec() {
        let tmp = tempfile::tempdir().unwrap();
        let lines = read_synth_airport_lines(&tmp.path().join("absent.arrow")).unwrap();
        let areas = read_synth_airport_areas(&tmp.path().join("absent.arrow")).unwrap();
        assert!(lines.is_empty());
        assert!(areas.is_empty());
    }

    #[test]
    fn write_overwrite_replaces_lines_does_not_append() {
        // Truncate-and-rewrite invariant: a second write at the
        // same path must replace previous content, not extend it.
        // Atomicity is provided by `arrow_io::write_record_batches`;
        // this test pins the behavioural contract callers depend on.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("synth_airport_lines.arrow");
        write_synth_airport_lines(
            &path,
            &[sample_lines_row(0), sample_lines_row(1), sample_lines_row(2)],
        )
        .unwrap();
        assert_eq!(read_synth_airport_lines(&path).unwrap().len(), 3);
        write_synth_airport_lines(&path, &[sample_lines_row(0)]).unwrap();
        assert_eq!(read_synth_airport_lines(&path).unwrap().len(), 1);
    }

    #[test]
    fn write_overwrite_replaces_areas_does_not_append() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("synth_airport_areas.arrow");
        let one = sample_areas_row();
        let two = vec![sample_areas_row(), sample_areas_row()];
        write_synth_airport_areas(&path, &two).unwrap();
        assert_eq!(read_synth_airport_areas(&path).unwrap().len(), 2);
        write_synth_airport_areas(&path, std::slice::from_ref(&one)).unwrap();
        assert_eq!(read_synth_airport_areas(&path).unwrap().len(), 1);
    }

    #[test]
    fn write_creates_missing_parent_dir() {
        // `arrow_io::write_record_batches` runs `create_dir_all`
        // before writing — Stage 1.5 emits into per-R4 dirs that
        // may not exist yet (no OSM data → no prior aircraft files).
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("84/1e3/5ff");
        write_synth_airport_lines(
            &nested.join("synth_airport_lines.arrow"),
            &[sample_lines_row(0)],
        )
        .unwrap();
        assert!(nested.join("synth_airport_lines.arrow").exists());
    }

    #[test]
    fn synthetic_high_bit_disjoint_from_real_osm_ids() {
        // Real OSM IDs (both ways and relations) are positive `i64`
        // in this codebase (`osm-extract/main.rs:200,287`), so their
        // high bit is always 0. The synth encoding must never collide.
        let real_ids: [u64; 4] = [1, 1_234_567, i64::MAX as u64, (i64::MAX as u64) - 1];
        let synth = synth_osm_id_for(50.1, 14.26);
        for r in real_ids {
            assert_eq!(r & SYNTHETIC_OSM_ID_BIT, 0);
            assert_ne!(synth, r);
        }
    }
}
