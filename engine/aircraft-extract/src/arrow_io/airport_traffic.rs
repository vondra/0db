//! `airport_traffic.arrow` writer + reader (Phase 3 schema v1).
//!
//! One row per per-segment per-period traffic counter. Sparse —
//! only rows with `movements_per_day > 0` are emitted. Replaces
//! ground.arrow's per-rotation paths with per-segment counters that
//! don't scale with `n_days`. See [`crate::arrow_schemas::airport_traffic_schema`]
//! for the column list and the `airport_traffic_v1` contract.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    ArrayRef, FixedSizeListArray, Float32Array, Float32Builder, StringArray, StringBuilder,
    UInt16Array, UInt16Builder, UInt64Array, UInt64Builder, UInt8Array, UInt8Builder,
};
use arrow::datatypes::{DataType, Field};
use arrow::record_batch::RecordBatch;

use noise_compute::types::NUM_BANDS;

use crate::arrow_schemas;

use super::{read_all_batches, write_record_batches};

/// One traffic counter — sparse-only (caller filters movements_per_day > 0).
#[derive(Clone)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct AirportTrafficRow {
    pub airport_key: String,
    pub osm_id: u64,
    pub segment_idx: u16,
    /// 0 = line (runway/taxi/stopway), 1 = area_grid_point (apron),
    /// 2 = synthetic (DBSCAN auto-discovery).
    pub geometry_kind: u8,
    pub start_lat: f32,
    pub start_lon: f32,
    pub end_lat: f32,
    pub end_lon: f32,
    pub length_m: f32,
    /// 1 = runway, 2 = taxi, 3 = apron.
    pub ops_kind: u8,
    pub is_departure: u8,
    /// 0 = aircraft, 1 = GSE.
    pub veh_kind: u8,
    /// Indexes `noise_compute::emission::profiles_generated::CLASS_OF_PROFILE`
    /// when `veh_kind=0` (range 0..NUM_CLASSES=12), or
    /// `noise_compute::emission::gse::GSE_LW_BANDS_DB` when `veh_kind=1`
    /// (range 0..NUM_GSE_CLASSES=3).
    pub class_idx: u8,
    /// 0 = day, 1 = evening, 2 = night.
    pub period: u8,
    /// Movement count averaged over the n_days window. True count, not
    /// energy-weighted — caller multiplies by `band_energy_lin` at
    /// compute time.
    pub movements_per_day: f32,
    /// Per-band linear Z-weighted SEL at 25 m perpendicular distance
    /// for ONE MOVEMENT through this microsegment, event-integrated
    /// (NOT per-second — multiplying by movement duration would
    /// double-count). Already encodes speed adjustment, finite-line
    /// correction at the 25 m reference, departure bonus, and the
    /// aircraft per-event vs GSE kinematic-integral semantics chosen
    /// by `noise_compute::emission::airport_traffic`. A-weighting
    /// is applied receiver-side after frequency-dependent propagation.
    pub band_energy_lin: [f32; NUM_BANDS],
}

/// Write one R4 hex's traffic counters. `n_days` stamps the extraction
/// window into schema metadata so the popup consumer can disambiguate
/// sparse rates (1 movement in 14 d vs 25 in 365 d both compress to
/// `movements_per_day ≈ 0.07`).
pub fn write_airport_traffic(
    path: &Path,
    rows: &[AirportTrafficRow],
    n_days: u16,
) -> Result<()> {
    let schema = arrow_schemas::with_n_days(arrow_schemas::airport_traffic_schema(), n_days);
    let n = rows.len();
    let mut airport_key = StringBuilder::with_capacity(n, 8 * n);
    let mut osm_id = UInt64Builder::with_capacity(n);
    let mut segment_idx = UInt16Builder::with_capacity(n);
    let mut geometry_kind = UInt8Builder::with_capacity(n);
    let mut start_lat = Float32Builder::with_capacity(n);
    let mut start_lon = Float32Builder::with_capacity(n);
    let mut end_lat = Float32Builder::with_capacity(n);
    let mut end_lon = Float32Builder::with_capacity(n);
    let mut length_m = Float32Builder::with_capacity(n);
    let mut ops_kind = UInt8Builder::with_capacity(n);
    let mut is_departure = UInt8Builder::with_capacity(n);
    let mut veh_kind = UInt8Builder::with_capacity(n);
    let mut class_idx = UInt8Builder::with_capacity(n);
    let mut period = UInt8Builder::with_capacity(n);
    let mut movements_per_day = Float32Builder::with_capacity(n);

    let mut band_values: Vec<f32> = Vec::with_capacity(n * NUM_BANDS);

    for r in rows {
        airport_key.append_value(&r.airport_key);
        osm_id.append_value(r.osm_id);
        segment_idx.append_value(r.segment_idx);
        geometry_kind.append_value(r.geometry_kind);
        start_lat.append_value(r.start_lat);
        start_lon.append_value(r.start_lon);
        end_lat.append_value(r.end_lat);
        end_lon.append_value(r.end_lon);
        length_m.append_value(r.length_m);
        ops_kind.append_value(r.ops_kind);
        is_departure.append_value(r.is_departure);
        veh_kind.append_value(r.veh_kind);
        class_idx.append_value(r.class_idx);
        period.append_value(r.period);
        movements_per_day.append_value(r.movements_per_day);
        band_values.extend_from_slice(&r.band_energy_lin);
    }

    let band_item_field = Arc::new(Field::new("item", DataType::Float32, false));
    let band_list = FixedSizeListArray::new(
        band_item_field,
        NUM_BANDS as i32,
        Arc::new(Float32Array::from(band_values)),
        None,
    );

    let columns: Vec<ArrayRef> = vec![
        Arc::new(airport_key.finish()),
        Arc::new(osm_id.finish()),
        Arc::new(segment_idx.finish()),
        Arc::new(geometry_kind.finish()),
        Arc::new(start_lat.finish()),
        Arc::new(start_lon.finish()),
        Arc::new(end_lat.finish()),
        Arc::new(end_lon.finish()),
        Arc::new(length_m.finish()),
        Arc::new(ops_kind.finish()),
        Arc::new(is_departure.finish()),
        Arc::new(veh_kind.finish()),
        Arc::new(class_idx.finish()),
        Arc::new(period.finish()),
        Arc::new(movements_per_day.finish()),
        Arc::new(band_list),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    write_record_batches(path, &schema, &[batch])
}

pub fn read_airport_traffic(path: &Path) -> Result<Vec<AirportTrafficRow>> {
    let (schema, batches) = read_all_batches(path)?;
    arrow_schemas::assert_airport_traffic_contract_v1(schema.metadata())?;
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let mut out = Vec::with_capacity(total_rows);
    for b in batches {
        let airport_key = b.column_by_name("airport_key").unwrap().as_any().downcast_ref::<StringArray>().unwrap();
        let osm_id = b.column_by_name("osm_id").unwrap().as_any().downcast_ref::<UInt64Array>().unwrap();
        let segment_idx = b.column_by_name("segment_idx").unwrap().as_any().downcast_ref::<UInt16Array>().unwrap();
        let geometry_kind = b.column_by_name("geometry_kind").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let start_lat = b.column_by_name("start_lat").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let start_lon = b.column_by_name("start_lon").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let end_lat = b.column_by_name("end_lat").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let end_lon = b.column_by_name("end_lon").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let length_m = b.column_by_name("length_m").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let ops_kind = b.column_by_name("ops_kind").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let is_departure = b.column_by_name("is_departure").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let veh_kind = b.column_by_name("veh_kind").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let class_idx = b.column_by_name("class_idx").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let period = b.column_by_name("period").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let movements_per_day = b.column_by_name("movements_per_day").unwrap().as_any().downcast_ref::<Float32Array>().unwrap();
        let band_list = b.column_by_name("band_energy_lin").unwrap().as_any().downcast_ref::<FixedSizeListArray>().unwrap();
        let band_values = band_list.values().as_any().downcast_ref::<Float32Array>().unwrap();
        let band_buf = band_values.values();

        for i in 0..b.num_rows() {
            let lo = i * NUM_BANDS;
            let mut bands = [0.0f32; NUM_BANDS];
            bands.copy_from_slice(&band_buf[lo..lo + NUM_BANDS]);
            out.push(AirportTrafficRow {
                airport_key: airport_key.value(i).to_string(),
                osm_id: osm_id.value(i),
                segment_idx: segment_idx.value(i),
                geometry_kind: geometry_kind.value(i),
                start_lat: start_lat.value(i),
                start_lon: start_lon.value(i),
                end_lat: end_lat.value(i),
                end_lon: end_lon.value(i),
                length_m: length_m.value(i),
                ops_kind: ops_kind.value(i),
                is_departure: is_departure.value(i),
                veh_kind: veh_kind.value(i),
                class_idx: class_idx.value(i),
                period: period.value(i),
                movements_per_day: movements_per_day.value(i),
                band_energy_lin: bands,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_row() -> AirportTrafficRow {
        AirportTrafficRow {
            airport_key: "LKPR".into(),
            osm_id: 42,
            segment_idx: 7,
            geometry_kind: arrow_schemas::GEOMETRY_KIND_LINE,
            start_lat: 50.105,
            start_lon: 14.260,
            end_lat: 50.106,
            end_lon: 14.262,
            length_m: 250.0,
            ops_kind: 1, // runway
            is_departure: 1,
            veh_kind: 0,
            class_idx: 2, // WING_B738
            period: 0, // day
            movements_per_day: 12.5,
            // 8 strictly distinct values — a transposition of any two
            // positions changes the read-back, so the round-trip test
            // catches column-ordering bugs in the builder vec.
            band_energy_lin: [1.0e6, 2.0e6, 3.0e6, 4.0e6, 5.0e6, 6.0e6, 7.0e6, 8.0e6],
        }
    }

    #[test]
    fn round_trip_preserves_all_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("airport_traffic.arrow");
        let rows = vec![sample_row()];
        write_airport_traffic(&path, &rows, 14).unwrap();
        let read = read_airport_traffic(&path).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0], rows[0], "every field must round-trip exactly");
    }

    #[test]
    fn round_trip_two_rows_distinguishable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("airport_traffic.arrow");
        let mut row_gse = sample_row();
        row_gse.veh_kind = 1;
        row_gse.class_idx = 2; // HEAVY
        row_gse.airport_key = "strip:871e3558effffff".into();
        row_gse.movements_per_day = 3.0;
        // Distinct per-row band values so an offset-arithmetic bug
        // (row 0's bands written into row 1's slot or vice versa)
        // would surface as a value mismatch — without this, identical
        // bands across rows mask multi-row offset boundary errors.
        row_gse.band_energy_lin = [10.0e6, 20.0e6, 30.0e6, 40.0e6, 50.0e6, 60.0e6, 70.0e6, 80.0e6];
        let rows = vec![sample_row(), row_gse.clone()];
        write_airport_traffic(&path, &rows, 14).unwrap();
        let read = read_airport_traffic(&path).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0], rows[0], "row 0 round-trip");
        assert_eq!(read[1], rows[1], "row 1 round-trip");
    }

    #[test]
    fn empty_rows_writes_valid_arrow_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("airport_traffic.arrow");
        write_airport_traffic(&path, &[], 14).unwrap();
        let read = read_airport_traffic(&path).unwrap();
        assert!(read.is_empty());
    }

    #[test]
    fn n_days_metadata_stamped() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("airport_traffic.arrow");
        write_airport_traffic(&path, &[sample_row()], 365).unwrap();
        let (schema, _) = crate::arrow_io::read_record_batches(&path).unwrap();
        assert_eq!(
            schema.metadata().get("n_days").map(String::as_str),
            Some("365")
        );
    }

    #[test]
    fn reader_rejects_wrong_contract() {
        // Synthetic file written with bogus contract metadata must be
        // rejected by `assert_airport_traffic_contract_v1` — guards
        // against silently mis-decoding a future v2 schema with a
        // v1 binary.
        use crate::arrow_io::write_record_batches;
        use std::sync::Arc;
        let dir = tempdir().unwrap();
        let path = dir.path().join("bogus.arrow");
        let schema_v1 = arrow_schemas::airport_traffic_schema();
        let mut md = schema_v1.metadata().clone();
        md.insert("airport_traffic_contract".into(), "bogus_v9".into());
        let bogus = Arc::new((*schema_v1).clone().with_metadata(md));
        let empty_batch = RecordBatch::new_empty(bogus.clone());
        write_record_batches(&path, &bogus, &[empty_batch]).unwrap();
        let err = read_airport_traffic(&path).unwrap_err();
        assert!(
            err.to_string().contains("airport_traffic_contract"),
            "expected contract-mismatch error, got: {err}"
        );
    }
}
