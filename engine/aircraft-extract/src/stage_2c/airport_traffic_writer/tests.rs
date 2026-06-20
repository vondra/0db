use super::*;
use crate::airport_io::AERODROME_AEROWAY_TYPE;

#[test]
fn ops_kind_mapping_runway_taxi_only_skips_unknown() {
    assert_eq!(ops_kind_from_aeroway(0), Some(GROUND_OPS_KIND_RUNWAY_ROLL));
    assert_eq!(ops_kind_from_aeroway(1), Some(GROUND_OPS_KIND_TAXI));
    assert_eq!(ops_kind_from_aeroway(6), Some(GROUND_OPS_KIND_RUNWAY_ROLL));
    assert_eq!(ops_kind_from_aeroway(7), Some(GROUND_OPS_KIND_RUNWAY_ROLL));
    // Apron is an area feature (in airport_areas.arrow), never a
    // line — so aeroway_type=2 in airport_lines.arrow is corrupt.
    assert_eq!(ops_kind_from_aeroway(2), None);
    // 255 = "other" sentinel from osm-extract on parse failure.
    assert_eq!(ops_kind_from_aeroway(255), None);
}

#[test]
fn run_airport_traffic_empty_segments_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let by_r4 = tmp.path().join("segments_by_r4");
    let h3r4 = tmp.path().join("h3r4");
    std::fs::create_dir_all(&by_r4).unwrap();
    std::fs::create_dir_all(&h3r4).unwrap();
    let n = run_airport_traffic(&by_r4, &[], &h3r4, 14, 0, None).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn r4cache_load_concatenates_real_and_synth_lines() {
    use crate::synth_airport_io::{
        synth_osm_id_for, write_synth_airport_lines, SynthAirportLineRow, AIRSTRIP_AEROWAY_TYPE,
    };

    let dir = tempfile::tempdir().unwrap();
    let r4 = 0x841e_3550_0000_0000u64;
    let r4_dir = dir.path().join(r4_hex_str(r4));
    std::fs::create_dir_all(&r4_dir).unwrap();

    // Real OSM file is absent — Stage 1.5 writes the only line
    // for this R4. The synth line carries a re-attribution key
    // ("LKTEST"), so R4Cache must surface it WITHOUT consulting
    // `airport_areas` (the resolver would assign it differently).
    let synth_key = "LKTEST".to_string();
    let synth = SynthAirportLineRow {
        osm_id: synth_osm_id_for(50.1, 14.26),
        segment_idx: 0,
        airport_key: synth_key.clone(),
        start_lat: 50.1,
        start_lon: 14.26,
        end_lat: 50.105,
        end_lon: 14.27,
        length_m: 500.0,
        heading_deg: 60.0,
        aeroway_type: AIRSTRIP_AEROWAY_TYPE,
        name: "Auto airfield".to_string(),
    };
    let synth_path = r4_dir.join(SYNTH_LINES_FILE);
    write_synth_airport_lines(&synth_path, std::slice::from_ref(&synth)).unwrap();
    assert!(
        synth_path.exists(),
        "test setup: synth file must exist at {}",
        synth_path.display()
    );

    // Set up an unrelated nearby real aerodrome whose key we DO
    // NOT want assigned to the synth line — if R4Cache fell
    // through `resolve_airport_key`, this is what it would
    // attach. Catching this is the whole point of bypassing the
    // resolver for synth rows.
    let red_herring = AirportArea::new(
        999,
        AERODROME_AEROWAY_TYPE,
        "Red Herring".to_string(),
        "REDHERRING".to_string(),
        50.1,
        14.26,
        String::new(),
        1_000_000.0,
    );

    let cache = R4Cache::load(dir.path(), r4, &[red_herring]);
    assert_eq!(cache.lines.len(), 1, "synth line should be loaded");
    assert_eq!(
        cache.airport_keys[0], synth_key,
        "synth row must keep its pre-resolved airport_key (no re-resolution)"
    );
    assert_ne!(
        cache.airport_keys[0], "REDHERRING",
        "synth row must NOT be re-resolved via nearest_aerodrome_within"
    );
    // Synth osm_id sits in line_index keyed by (osm_id, segment_idx).
    let idx = cache
        .line_index
        .get(&(synth.osm_id, synth.segment_idx))
        .copied()
        .expect("synth (osm_id, segment_idx) must be indexed");
    assert_eq!(idx, 0);
}

/// Real OSM osm_ids are positive `i64` (high bit 0), synth ones
/// flip the high bit. The (osm_id, segment_idx) line_index must
/// stay collision-free across the union.
#[test]
fn r4cache_load_no_collisions_between_real_and_synth() {
    use crate::synth_airport_io::{
        synth_osm_id_for, write_synth_airport_lines, SynthAirportLineRow, AIRSTRIP_AEROWAY_TYPE,
        SYNTHETIC_OSM_ID_BIT,
    };

    let dir = tempfile::tempdir().unwrap();
    let r4 = 0x841e_3550_0000_0000u64;
    let r4_dir = dir.path().join(r4_hex_str(r4));
    std::fs::create_dir_all(&r4_dir).unwrap();

    let synth_osm_id = synth_osm_id_for(50.1, 14.26);
    let real_low_bits = synth_osm_id & !SYNTHETIC_OSM_ID_BIT;
    let real_osm_id_i64 = real_low_bits as i64;
    assert!(
        real_osm_id_i64 > 0,
        "low bits must round-trip as positive i64"
    );
    // Now actually fabricate a real airport_lines.arrow with an
    // OSM id whose low bits collide with the synth payload. If
    // R4Cache ever lost the high-bit distinction, the two would
    // end up at the same line_index key.
    write_real_airport_lines_arrow(
        &r4_dir.join("airport_lines.arrow"),
        &[FakeRealLine {
            osm_id: real_osm_id_i64,
            segment_idx: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            end_lat: 50.0,
            end_lon: 14.001,
            length_m: 71.5,
            aeroway_type: 0,
        }],
    );
    write_synth_airport_lines(
        &r4_dir.join(SYNTH_LINES_FILE),
        &[SynthAirportLineRow {
            osm_id: synth_osm_id,
            segment_idx: 0,
            airport_key: "auto-x".to_string(),
            start_lat: 50.1,
            start_lon: 14.26,
            end_lat: 50.105,
            end_lon: 14.27,
            length_m: 500.0,
            heading_deg: 60.0,
            aeroway_type: AIRSTRIP_AEROWAY_TYPE,
            name: "x".to_string(),
        }],
    )
    .unwrap();

    let cache = R4Cache::load(dir.path(), r4, &[]);
    assert_eq!(cache.lines.len(), 2, "real + synth both loaded");
    // Both index entries present — the high bit is the only
    // thing keeping (real_low_bits, 0) and (synth_osm_id, 0) apart.
    assert!(cache.line_index.contains_key(&(real_low_bits, 0u16)));
    assert!(cache.line_index.contains_key(&(synth_osm_id, 0u16)));
}

/// End-to-end test: a real OSM line and a synth line in the same
/// R4 must both end up in `R4Cache.lines`, with the real one
/// resolved via `nearest_aerodrome_within` (so its key picks up
/// the `airport_areas` hit) and the synth one keeping its
/// pre-resolved key. Without this test the "real first, then
/// synth, both indexed correctly" invariant is not exercised
/// anywhere in the suite.
#[test]
fn r4cache_load_unions_real_and_synth_with_correct_keys() {
    use crate::synth_airport_io::{
        synth_osm_id_for, write_synth_airport_lines, SynthAirportLineRow, AIRSTRIP_AEROWAY_TYPE,
    };

    let dir = tempfile::tempdir().unwrap();
    let r4 = 0x841e_3550_0000_0000u64;
    let r4_dir = dir.path().join(r4_hex_str(r4));
    std::fs::create_dir_all(&r4_dir).unwrap();

    // Real OSM line — id 42, geometry inside LKPR's polygon.
    write_real_airport_lines_arrow(
        &r4_dir.join("airport_lines.arrow"),
        &[FakeRealLine {
            osm_id: 42,
            segment_idx: 0,
            start_lat: 50.10,
            start_lon: 14.26,
            end_lat: 50.10,
            end_lon: 14.261,
            length_m: 71.5,
            aeroway_type: 0,
        }],
    );
    // Synth line — different location, distinct H3 cell.
    let synth_osm_id = synth_osm_id_for(50.5, 14.0);
    write_synth_airport_lines(
        &r4_dir.join(SYNTH_LINES_FILE),
        &[SynthAirportLineRow {
            osm_id: synth_osm_id,
            segment_idx: 0,
            airport_key: "auto-synthetic".to_string(),
            start_lat: 50.5,
            start_lon: 14.0,
            end_lat: 50.501,
            end_lon: 14.0,
            length_m: 100.0,
            heading_deg: 0.0,
            aeroway_type: AIRSTRIP_AEROWAY_TYPE,
            name: "synth".to_string(),
        }],
    )
    .unwrap();

    // An aerodrome polygon close to the real line so the
    // resolver attaches its key — the synth line is far enough
    // away that even with the polygon-radius window, it should
    // not be re-resolved into LKPR.
    let lkpr = AirportArea::new(
        12345,
        AERODROME_AEROWAY_TYPE,
        "Praha".to_string(),
        "LKPR".to_string(),
        50.10,
        14.26,
        String::new(),
        10_000_000.0,
    );

    let cache = R4Cache::load(dir.path(), r4, &[lkpr]);
    assert_eq!(cache.lines.len(), 2, "real + synth both loaded");
    // Real first (it's pushed first in the loop), so index 0 is
    // the real line resolved to LKPR.
    assert_eq!(cache.airport_keys[0], "LKPR");
    // Synth comes second; its key is the pre-resolved synth one,
    // not re-resolved into LKPR.
    assert_eq!(cache.airport_keys[1], "auto-synthetic");
    // Both indexed.
    assert_eq!(cache.line_index.get(&(42, 0)), Some(&0));
    assert_eq!(cache.line_index.get(&(synth_osm_id, 0)), Some(&1));
}

/// Touch-semantics regression: one ground leg crossing three
/// adjacent runway microsegments must insert its `flight_id` into
/// ALL three resulting rows, in lock-step with the proportional
/// band-energy accumulation.
#[test]
fn flight_ids_touch_every_intersected_microseg() {
    use crate::arrow_io::{read_airport_traffic, write_segments};
    use crate::flight::{FlightSegment, Phase};
    use std::collections::HashSet;
    let tmp = tempfile::tempdir().unwrap();
    let by_r4_dir = tmp.path().join("segments_by_r4");
    let h3r4_dir = tmp.path().join("h3r4");
    // Three abutting 100 m east-west microsegments at constant lat,
    // sharing one osm_id with segment_idx 0/1/2. Endpoints chosen
    // so leg → microseg #0 from lon_0..lon_1, #1 from lon_1..lon_2,
    // #2 from lon_2..lon_3, all on lat=50.0.
    let lat = 50.0_f64;
    // ~100 m east at lat=50° corresponds to ~0.001397° lon.
    let dlon = 0.001397_f64;
    let lon0 = 14.0;
    let lon1 = lon0 + dlon;
    let lon2 = lon0 + 2.0 * dlon;
    let lon3 = lon0 + 3.0 * dlon;
    let mid_lat = lat;
    let mid_lon = (lon0 + lon3) * 0.5;
    let r4 = cell_u64(mid_lat, mid_lon, Resolution::Four).expect("valid r4");
    let r4_h3r4_dir = h3r4_dir.join(r4_hex_str(r4));
    let r4_input_dir = by_r4_dir.join(r4_hex_str(r4));
    std::fs::create_dir_all(&r4_h3r4_dir).unwrap();
    std::fs::create_dir_all(&r4_input_dir).unwrap();
    write_real_airport_lines_arrow(
        &r4_h3r4_dir.join("airport_lines.arrow"),
        &[
            FakeRealLine {
                osm_id: 42,
                segment_idx: 0,
                start_lat: lat,
                start_lon: lon0,
                end_lat: lat,
                end_lon: lon1,
                length_m: 100.0,
                aeroway_type: 0,
            },
            FakeRealLine {
                osm_id: 42,
                segment_idx: 1,
                start_lat: lat,
                start_lon: lon1,
                end_lat: lat,
                end_lon: lon2,
                length_m: 100.0,
                aeroway_type: 0,
            },
            FakeRealLine {
                osm_id: 42,
                segment_idx: 2,
                start_lat: lat,
                start_lon: lon2,
                end_lat: lat,
                end_lon: lon3,
                length_m: 100.0,
                aeroway_type: 0,
            },
        ],
    );

    // One ground leg crossing all three microsegments end-to-end.
    // `flight_id = 0xDEADBEEF` is the marker we assert against.
    let leg = FlightSegment {
        flight_id: 0xDEAD_BEEF_u64,
        callsign: "TEST123".to_string(),
        aircraft_type: *b"B738",
        profile_idx: 23, // narrowbody jet
        source_id: 0,
        origin: 0,
        veh_kind: 0, // aircraft
        gse_class: 0,
        period: 0, // day
        date_id: 0,
        phase: Phase::Ground,
        flags: 0,
        start_lat: lat as f32,
        start_lon: lon0 as f32,
        start_alt_m: 0.0,
        end_lat: lat as f32,
        end_lon: lon3 as f32,
        end_alt_m: 0.0,
        speed_kt: 90.0,
        length_m: 300.0,
        agl_avg_m: 0.0,
        start_elev_m: 0.0,
        end_elev_m: 0.0,
    };

    // Aerodrome with key "LKTEST" so the writer attaches it to all
    // three lines. Polygon covers the test geometry.
    let aerodrome = AirportArea::new(
        1,
        AERODROME_AEROWAY_TYPE,
        "Test Aerodrome".to_string(),
        "LKTEST".to_string(),
        lat,
        lon0 + 1.5 * dlon,
        String::new(),
        100_000_000.0,
    );

    write_segments(&r4_input_dir.join("ground.arrow"), &[leg]).unwrap();

    let n = run_airport_traffic(
        &by_r4_dir,
        std::slice::from_ref(&aerodrome),
        &h3r4_dir,
        1,
        365,
        None,
    )
    .unwrap();
    assert!(n > 0, "writer must populate at least one R4");

    let traffic_path = r4_h3r4_dir.join("airport_traffic.arrow");
    assert!(traffic_path.exists(), "airport_traffic.arrow must exist");
    let rows = read_airport_traffic(&traffic_path).unwrap();

    // Filter to rows for our osm_id (writer may also write rows
    // tied to other osm_ids if any line happened to be picked up).
    let our_rows: Vec<_> = rows.iter().filter(|r| r.osm_id == 42).collect();
    let seg_idxs: HashSet<u16> = our_rows.iter().map(|r| r.segment_idx).collect();
    assert_eq!(
        seg_idxs,
        HashSet::from([0u16, 1, 2]),
        "all three microsegments must have a row under v5 touch semantics; got {seg_idxs:?}"
    );

    // v5 swap: per-row `flight_ids: List<UInt64>` collapsed to
    // scalar `unique_movement_count` (single rotation = count 1).
    // Per-microsegment UNION via `microseg_unique_count` (also 1).
    for r in &our_rows {
        assert_eq!(
            r.unique_movement_count, 1,
            "microsegment {} must show one unique movement (v5 scalar); got {}",
            r.segment_idx, r.unique_movement_count,
        );
        assert_eq!(
            r.microseg_unique_count, 1,
            "microsegment {} row-replicated UNION must show one unique movement; got {}",
            r.segment_idx, r.microseg_unique_count,
        );
        // The B738 is a non-GA jet, so the GA-class split must be
        // empty — the non-GA union above carries it (delta 2).
        assert_eq!(
            r.microseg_unique_ga_count, 0,
            "B738 (non-GA jet) must NOT land in the GA microseg split"
        );
        assert!(
            r.band_energy_lin.iter().any(|b| *b > 0.0),
            "microsegment {} must have positive band_energy_lin",
            r.segment_idx,
        );
    }
}

/// Minimal `airport_lines.arrow` row writer for tests. Mirrors
/// the subset of `osm-extract::finalize::write_airport_lines`
/// columns that `read_airport_lines` parses, so a fabricated
/// fixture round-trips correctly through Stage 2C's reader.
pub(crate) fn write_real_airport_lines_arrow(path: &Path, rows: &[FakeRealLine]) {
    use arrow::array::{
        Float32Builder, Float64Builder, Int16Builder, Int64Builder, StringBuilder, UInt8Builder,
    };
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use std::collections::HashMap;
    use std::sync::Arc;

    let schema = Arc::new(
        Schema::new(vec![
            Field::new("osm_id", DataType::Int64, false),
            Field::new("segment_idx", DataType::Int16, false),
            Field::new("start_lat", DataType::Float64, false),
            Field::new("start_lon", DataType::Float64, false),
            Field::new("end_lat", DataType::Float64, false),
            Field::new("end_lon", DataType::Float64, false),
            Field::new("length_m", DataType::Float32, false),
            Field::new("heading_deg", DataType::Float32, false),
            Field::new("aeroway_type", DataType::UInt8, false),
            Field::new("ref", DataType::Utf8, true),
            Field::new("surface", DataType::Utf8, true),
            Field::new("width_m", DataType::Float32, true),
        ])
        .with_metadata({
            let mut md = HashMap::new();
            md.insert(
                "schema_version".to_string(),
                crate::SCHEMA_VERSION.to_string(),
            );
            md
        }),
    );

    let n = rows.len();
    let mut osm_id = Int64Builder::with_capacity(n);
    let mut seg_idx = Int16Builder::with_capacity(n);
    let mut sla = Float64Builder::with_capacity(n);
    let mut slo = Float64Builder::with_capacity(n);
    let mut ela = Float64Builder::with_capacity(n);
    let mut elo = Float64Builder::with_capacity(n);
    let mut len = Float32Builder::with_capacity(n);
    let mut heading = Float32Builder::with_capacity(n);
    let mut atype = UInt8Builder::with_capacity(n);
    let mut ref_col = StringBuilder::with_capacity(n, 0);
    let mut surface = StringBuilder::with_capacity(n, 0);
    let mut width = Float32Builder::with_capacity(n);
    for r in rows {
        osm_id.append_value(r.osm_id);
        seg_idx.append_value(r.segment_idx);
        sla.append_value(r.start_lat);
        slo.append_value(r.start_lon);
        ela.append_value(r.end_lat);
        elo.append_value(r.end_lon);
        len.append_value(r.length_m);
        heading.append_value(0.0);
        atype.append_value(r.aeroway_type);
        ref_col.append_null();
        surface.append_null();
        width.append_null();
    }
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(seg_idx.finish()),
            Arc::new(sla.finish()),
            Arc::new(slo.finish()),
            Arc::new(ela.finish()),
            Arc::new(elo.finish()),
            Arc::new(len.finish()),
            Arc::new(heading.finish()),
            Arc::new(atype.finish()),
            Arc::new(ref_col.finish()),
            Arc::new(surface.finish()),
            Arc::new(width.finish()),
        ],
    )
    .unwrap();
    crate::arrow_io::write_record_batches(path, &schema, &[batch]).unwrap();
}

pub(crate) struct FakeRealLine {
    pub osm_id: i64,
    pub segment_idx: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub aeroway_type: u8,
}
