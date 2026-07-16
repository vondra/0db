//! Read `airport_traffic.arrow` v6 files for a set of H3 R4 hex cells.
//! Mirrors the loader pattern in `source_loader.rs` (cruise) and
//! `source-reader/src/aircraft_v6/airport_traffic_view.rs`. Heatmap
//! has no NAPI dep on source-reader, so the loader lives here.
//!
//! v6 schema: per-row scalar unique counts + row-replicated
//! per-microsegment UNION counts; `band_energy_lin` is raw Σ over
//! n_days. The heatmap kernel reads only geometry + band energy, so
//! all unique-count fields surface as zero placeholders (kept for the
//! `CruiseRowView`-style row view contract).

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use arrow::array::{
    Array, FixedSizeListArray, Float32Array, StringArray, UInt16Array, UInt32Array, UInt64Array,
    UInt8Array,
};
use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{AirportTrafficRowView, NUM_GSE_CLASSES};
use noise_compute::types::NUM_BANDS;

/// Owns per-row buffers borrowed by [`Self::views`]. Schema mirrors
/// `aircraft-extract/src/arrow_io/airport_traffic.rs` v5.
pub struct AirportTrafficData {
    rows: Vec<OwnedRow>,
}

struct OwnedRow {
    airport_key: String,
    osm_id: u64,
    segment_idx: u16,
    geometry_kind: u8,
    start_lat: f32,
    start_lon: f32,
    end_lat: f32,
    end_lon: f32,
    length_m: f32,
    ops_kind: u8,
    is_departure: u8,
    veh_kind: u8,
    class_idx: u8,
    period: u8,
    band_energy_lin: [f32; 8],
    unique_movement_count: u32,
    unique_arr_count: u32,
    unique_dep_count: u32,
    unique_gse_count_per_class: [u32; NUM_GSE_CLASSES],
    microseg_unique_count: u32,
    microseg_unique_arr_count: u32,
    microseg_unique_dep_count: u32,
    microseg_unique_gse_count_per_class: [u32; NUM_GSE_CLASSES],
    microseg_unique_ga_count: u32,
    microseg_unique_ga_arr_count: u32,
    microseg_unique_ga_dep_count: u32,
}

impl AirportTrafficData {
    pub fn empty() -> Self {
        Self { rows: Vec::new() }
    }

    pub fn load_for_r4s(h3r4_dir: &Path, r4_hexes: &[u64]) -> Result<Self> {
        let mut rows = Vec::new();
        for &r4 in r4_hexes {
            crate::schema_check::read_arrow_for_r4(
                h3r4_dir,
                r4,
                "airport_traffic.arrow",
                crate::schema_check::check_airport_traffic_contract,
                |batch| absorb_batch(batch, &mut rows),
            )?;
        }
        Ok(Self { rows })
    }

    pub fn views(&self) -> Vec<AirportTrafficRowView<'_>> {
        self.rows
            .iter()
            .map(|r| AirportTrafficRowView {
                airport_key: &r.airport_key,
                osm_id: r.osm_id,
                segment_idx: r.segment_idx,
                geometry_kind: r.geometry_kind,
                start_lat: r.start_lat,
                start_lon: r.start_lon,
                end_lat: r.end_lat,
                end_lon: r.end_lon,
                length_m: r.length_m,
                ops_kind: r.ops_kind,
                is_departure: r.is_departure,
                veh_kind: r.veh_kind,
                class_idx: r.class_idx,
                period: r.period,
                band_energy_lin: &r.band_energy_lin,
                unique_movement_count: r.unique_movement_count,
                unique_arr_count: r.unique_arr_count,
                unique_dep_count: r.unique_dep_count,
                unique_gse_count_per_class: &r.unique_gse_count_per_class,
                microseg_unique_count: r.microseg_unique_count,
                microseg_unique_arr_count: r.microseg_unique_arr_count,
                microseg_unique_dep_count: r.microseg_unique_dep_count,
                microseg_unique_gse_count_per_class: &r.microseg_unique_gse_count_per_class,
                microseg_unique_ga_count: r.microseg_unique_ga_count,
                microseg_unique_ga_arr_count: r.microseg_unique_ga_arr_count,
                microseg_unique_ga_dep_count: r.microseg_unique_ga_dep_count,
            })
            .collect()
    }

    pub fn n_rows(&self) -> usize {
        self.rows.len()
    }
}

fn absorb_batch(batch: &RecordBatch, rows: &mut Vec<OwnedRow>) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    let airport_key = col_str(batch, "airport_key")?;
    let osm_id = col_u64(batch, "osm_id")?;
    let seg_idx = col_u16(batch, "segment_idx")?;
    let geom_kind = col_u8(batch, "geometry_kind")?;
    let slat = col_f32(batch, "start_lat")?;
    let slon = col_f32(batch, "start_lon")?;
    let elat = col_f32(batch, "end_lat")?;
    let elon = col_f32(batch, "end_lon")?;
    let length = col_f32(batch, "length_m")?;
    let ops_kind = col_u8(batch, "ops_kind")?;
    let is_dep = col_u8(batch, "is_departure")?;
    let veh_kind = col_u8(batch, "veh_kind")?;
    let class_idx = col_u8(batch, "class_idx")?;
    let period = col_u8(batch, "period")?;
    let band_lin = col_fixed_list(batch, "band_energy_lin")?;
    let unique_mov = col_u32(batch, "unique_movement_count")?;
    let unique_arr = col_u32(batch, "unique_arr_count")?;
    let unique_dep = col_u32(batch, "unique_dep_count")?;
    let gse_list = col_fixed_list(batch, "unique_gse_count_per_class")?;
    let microseg_unique = col_u32(batch, "microseg_unique_count")?;
    let microseg_unique_arr = col_u32(batch, "microseg_unique_arr_count")?;
    let microseg_unique_dep = col_u32(batch, "microseg_unique_dep_count")?;
    let microseg_gse_list = col_fixed_list(batch, "microseg_unique_gse_count_per_class")?;
    let microseg_unique_ga = col_u32(batch, "microseg_unique_ga_count")?;
    let microseg_unique_ga_arr = col_u32(batch, "microseg_unique_ga_arr_count")?;
    let microseg_unique_ga_dep = col_u32(batch, "microseg_unique_ga_dep_count")?;

    if band_lin.value_length() != NUM_BANDS as i32 {
        bail!(
            "band_energy_lin expected {} values, got {}",
            NUM_BANDS,
            band_lin.value_length()
        );
    }
    let band_f = band_lin
        .values()
        .as_any()
        .downcast_ref::<Float32Array>()
        .ok_or_else(|| anyhow!("band_energy_lin child not Float32"))?;
    let band_buf = band_f.values();
    // FixedSizeListArray.values() returns the full underlying child
    // buffer; respect the list's own offset so a sliced batch reads the
    // right window. IPC file readers yield un-sliced batches today but
    // an upstream `RecordBatch::slice` would otherwise misalign reads.
    let band_base = band_lin.offset() * NUM_BANDS;

    if gse_list.value_length() != NUM_GSE_CLASSES as i32 {
        bail!(
            "unique_gse_count_per_class expected {} values, got {}",
            NUM_GSE_CLASSES,
            gse_list.value_length()
        );
    }
    if microseg_gse_list.value_length() != NUM_GSE_CLASSES as i32 {
        bail!(
            "microseg_unique_gse_count_per_class expected {} values, got {}",
            NUM_GSE_CLASSES,
            microseg_gse_list.value_length()
        );
    }
    let gse_u32 = gse_list
        .values()
        .as_any()
        .downcast_ref::<UInt32Array>()
        .ok_or_else(|| anyhow!("unique_gse_count_per_class child not UInt32"))?;
    let microseg_gse_u32 = microseg_gse_list
        .values()
        .as_any()
        .downcast_ref::<UInt32Array>()
        .ok_or_else(|| anyhow!("microseg_unique_gse_count_per_class child not UInt32"))?;
    let gse_buf = gse_u32.values();
    let microseg_gse_buf = microseg_gse_u32.values();
    let gse_base = gse_list.offset() * NUM_GSE_CLASSES;
    let microseg_gse_base = microseg_gse_list.offset() * NUM_GSE_CLASSES;

    for i in 0..n {
        let mut band = [0.0f32; NUM_BANDS];
        let lo_b = band_base + i * NUM_BANDS;
        band.copy_from_slice(&band_buf[lo_b..lo_b + NUM_BANDS]);
        let lo_g = gse_base + i * NUM_GSE_CLASSES;
        let lo_mg = microseg_gse_base + i * NUM_GSE_CLASSES;
        let mut row_gse = [0u32; NUM_GSE_CLASSES];
        row_gse.copy_from_slice(&gse_buf[lo_g..lo_g + NUM_GSE_CLASSES]);
        let mut row_microseg_gse = [0u32; NUM_GSE_CLASSES];
        row_microseg_gse.copy_from_slice(&microseg_gse_buf[lo_mg..lo_mg + NUM_GSE_CLASSES]);

        rows.push(OwnedRow {
            airport_key: airport_key.value(i).to_string(),
            osm_id: osm_id.value(i),
            segment_idx: seg_idx.value(i),
            geometry_kind: geom_kind.value(i),
            start_lat: slat.value(i),
            start_lon: slon.value(i),
            end_lat: elat.value(i),
            end_lon: elon.value(i),
            length_m: length.value(i),
            ops_kind: ops_kind.value(i),
            is_departure: is_dep.value(i),
            veh_kind: veh_kind.value(i),
            class_idx: class_idx.value(i),
            period: period.value(i),
            band_energy_lin: band,
            unique_movement_count: unique_mov.value(i),
            unique_arr_count: unique_arr.value(i),
            unique_dep_count: unique_dep.value(i),
            unique_gse_count_per_class: row_gse,
            microseg_unique_count: microseg_unique.value(i),
            microseg_unique_arr_count: microseg_unique_arr.value(i),
            microseg_unique_dep_count: microseg_unique_dep.value(i),
            microseg_unique_gse_count_per_class: row_microseg_gse,
            microseg_unique_ga_count: microseg_unique_ga.value(i),
            microseg_unique_ga_arr_count: microseg_unique_ga_arr.value(i),
            microseg_unique_ga_dep_count: microseg_unique_ga_dep.value(i),
        });
    }
    Ok(())
}

fn col_u64<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt64Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_u32<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt32Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_u8<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt8Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_u16<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a UInt16Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_f32<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a Float32Array> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_str<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a StringArray> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}
fn col_fixed_list<'a>(b: &'a RecordBatch, n: &str) -> Result<&'a FixedSizeListArray> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref())
        .ok_or_else(|| anyhow!("missing or wrong-typed column {n}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Float32Array};
    use arrow::datatypes::{DataType, Field, Fields, Schema};
    use std::sync::Arc;

    fn fixed_list_f32(name: &str, len: i32, values: Vec<f32>) -> (Field, ArrayRef) {
        let item = Arc::new(Field::new("item", DataType::Float32, false));
        let arr = FixedSizeListArray::new(
            item.clone(),
            len,
            Arc::new(Float32Array::from(values)),
            None,
        );
        (
            Field::new(name, DataType::FixedSizeList(item, len), false),
            Arc::new(arr) as ArrayRef,
        )
    }

    fn fixed_list_u32(name: &str, len: i32, values: Vec<u32>) -> (Field, ArrayRef) {
        let item = Arc::new(Field::new("item", DataType::UInt32, false));
        let arr =
            FixedSizeListArray::new(item.clone(), len, Arc::new(UInt32Array::from(values)), None);
        (
            Field::new(name, DataType::FixedSizeList(item, len), false),
            Arc::new(arr) as ArrayRef,
        )
    }

    /// One-row traffic batch. `band_len` overrides band_energy_lin length
    /// (use NUM_BANDS for valid, smaller for length-drift test).
    fn batch_with(band_len: i32, drop_column: Option<&str>) -> RecordBatch {
        let n_b = band_len as usize;
        let mut fields_arrs: Vec<(Field, ArrayRef)> = vec![
            (
                Field::new("airport_key", DataType::Utf8, false),
                Arc::new(StringArray::from(vec!["LKPR"])) as ArrayRef,
            ),
            (
                Field::new("osm_id", DataType::UInt64, false),
                Arc::new(UInt64Array::from(vec![42u64])) as ArrayRef,
            ),
            (
                Field::new("segment_idx", DataType::UInt16, false),
                Arc::new(UInt16Array::from(vec![7u16])) as ArrayRef,
            ),
            (
                Field::new("geometry_kind", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![1u8])) as ArrayRef,
            ),
            (
                Field::new("start_lat", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![50.1f32])) as ArrayRef,
            ),
            (
                Field::new("start_lon", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![14.3f32])) as ArrayRef,
            ),
            (
                Field::new("end_lat", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![50.11f32])) as ArrayRef,
            ),
            (
                Field::new("end_lon", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![14.31f32])) as ArrayRef,
            ),
            (
                Field::new("length_m", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![123.0f32])) as ArrayRef,
            ),
            (
                Field::new("ops_kind", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])) as ArrayRef,
            ),
            (
                Field::new("is_departure", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![1u8])) as ArrayRef,
            ),
            (
                Field::new("veh_kind", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])) as ArrayRef,
            ),
            (
                Field::new("class_idx", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![3u8])) as ArrayRef,
            ),
            (
                Field::new("period", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])) as ArrayRef,
            ),
            fixed_list_f32("band_energy_lin", band_len, vec![0.0f32; n_b]),
            (
                Field::new("unique_movement_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![10u32])) as ArrayRef,
            ),
            (
                Field::new("unique_arr_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![5u32])) as ArrayRef,
            ),
            (
                Field::new("unique_dep_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![5u32])) as ArrayRef,
            ),
            fixed_list_u32(
                "unique_gse_count_per_class",
                NUM_GSE_CLASSES as i32,
                vec![0u32; NUM_GSE_CLASSES],
            ),
            (
                Field::new("microseg_unique_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![10u32])) as ArrayRef,
            ),
            (
                Field::new("microseg_unique_arr_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![5u32])) as ArrayRef,
            ),
            (
                Field::new("microseg_unique_dep_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![5u32])) as ArrayRef,
            ),
            fixed_list_u32(
                "microseg_unique_gse_count_per_class",
                NUM_GSE_CLASSES as i32,
                vec![0u32; NUM_GSE_CLASSES],
            ),
            (
                Field::new("microseg_unique_ga_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![2u32])) as ArrayRef,
            ),
            (
                Field::new("microseg_unique_ga_arr_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![1u32])) as ArrayRef,
            ),
            (
                Field::new("microseg_unique_ga_dep_count", DataType::UInt32, false),
                Arc::new(UInt32Array::from(vec![1u32])) as ArrayRef,
            ),
        ];
        if let Some(name) = drop_column {
            fields_arrs.retain(|(f, _)| f.name() != name);
        }
        let fields: Fields = Fields::from(
            fields_arrs
                .iter()
                .map(|(f, _)| f.clone())
                .collect::<Vec<_>>(),
        );
        let arrs: Vec<ArrayRef> = fields_arrs.into_iter().map(|(_, a)| a).collect();
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrs).unwrap()
    }

    #[test]
    fn traffic_valid_loads() {
        let batch = batch_with(NUM_BANDS as i32, None);
        let mut rows = Vec::new();
        absorb_batch(&batch, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ops_kind, 0);
    }

    #[test]
    fn traffic_missing_required_column_bails() {
        let batch = batch_with(NUM_BANDS as i32, Some("ops_kind"));
        let err = absorb_batch(&batch, &mut Vec::new()).unwrap_err();
        assert!(
            format!("{err:#}").contains("ops_kind"),
            "error must name dropped column: {err:#}"
        );
    }

    #[test]
    fn traffic_band_wrong_length_bails() {
        let batch = batch_with(7, None);
        let err = absorb_batch(&batch, &mut Vec::new()).unwrap_err();
        let s = format!("{err:#}");
        assert!(s.contains("band_energy_lin"), "msg names column: {s}");
        assert!(s.contains("7"), "msg names actual length: {s}");
    }
}
