//! Stage 2B cruise writer.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    ArrayRef, FixedSizeBinaryBuilder, Float32Builder, ListArray, StringBuilder, UInt64Builder,
    UInt8Builder,
};
use arrow::buffer::OffsetBuffer;
use arrow::datatypes::{DataType, Field};
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;
use crate::flight::CruiseBucket;

use super::write_record_batches;

pub fn write_cruise(path: &Path, rows: &[CruiseBucket], n_days: u16) -> Result<()> {
    let schema = arrow_schemas::with_n_days(arrow_schemas::cruise_schema(), n_days);
    let n = rows.len();
    let mut r8 = UInt64Builder::with_capacity(n);
    let mut class = UInt8Builder::with_capacity(n);
    let mut rep_pi = UInt8Builder::with_capacity(n);
    let mut fl_bin = UInt8Builder::with_capacity(n);
    let mut period = UInt8Builder::with_capacity(n);
    let mut flags = UInt8Builder::with_capacity(n);
    let mut sum_len = Float32Builder::with_capacity(n);
    let mut rep_len = Float32Builder::with_capacity(n);
    let mut rep_alt = Float32Builder::with_capacity(n);
    let mut rep_speed = Float32Builder::with_capacity(n);
    let mut source_id = UInt8Builder::with_capacity(n);
    let mut origin = UInt8Builder::with_capacity(n);

    let total_fids_capacity: usize = rows.iter().map(|r| r.cruise_flight_ids.len()).sum();
    let mut fid_off: Vec<i32> = Vec::with_capacity(n + 1);
    fid_off.push(0);
    let mut fid_vals = UInt64Builder::with_capacity(total_fids_capacity);
    let mut typecode_vals = FixedSizeBinaryBuilder::with_capacity(total_fids_capacity, 4);
    let mut callsign_vals = StringBuilder::with_capacity(total_fids_capacity, total_fids_capacity * 8);
    let mut total_fids = 0usize;

    for r in rows {
        r8.append_value(r.r8_hex);
        class.append_value(r.class);
        rep_pi.append_value(r.rep_profile_idx);
        fl_bin.append_value(r.fl_bin);
        period.append_value(r.period);
        flags.append_value(r.flags);
        sum_len.append_value(r.sum_length_m);
        rep_len.append_value(r.rep_len_m);
        rep_alt.append_value(r.rep_alt_m);
        rep_speed.append_value(r.rep_speed_kt);
        source_id.append_value(r.source_id);
        origin.append_value(r.origin);
        debug_assert_eq!(r.cruise_flight_ids.len(), r.cruise_aircraft_types.len());
        debug_assert_eq!(r.cruise_flight_ids.len(), r.cruise_callsigns.len());
        for ((&fid, tc), cs) in r
            .cruise_flight_ids
            .iter()
            .zip(r.cruise_aircraft_types.iter())
            .zip(r.cruise_callsigns.iter())
        {
            fid_vals.append_value(fid);
            typecode_vals.append_value(tc)?;
            callsign_vals.append_value(cs);
        }
        total_fids += r.cruise_flight_ids.len();
        fid_off.push(total_fids as i32);
    }
    // List offsets are shared across the three parallel per-fid arrays
    // because the fid count per row is identical for all three.
    let offset_buf = OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(fid_off));
    let fid_list = ListArray::new(
        Arc::new(Field::new("item", DataType::UInt64, false)),
        offset_buf.clone(),
        Arc::new(fid_vals.finish()),
        None,
    );
    let typecode_list = ListArray::new(
        Arc::new(Field::new("item", DataType::FixedSizeBinary(4), false)),
        offset_buf.clone(),
        Arc::new(typecode_vals.finish()),
        None,
    );
    let callsign_list = ListArray::new(
        Arc::new(Field::new("item", DataType::Utf8, false)),
        offset_buf,
        Arc::new(callsign_vals.finish()),
        None,
    );

    let columns: Vec<ArrayRef> = vec![
        Arc::new(r8.finish()),
        Arc::new(class.finish()),
        Arc::new(rep_pi.finish()),
        Arc::new(fl_bin.finish()),
        Arc::new(period.finish()),
        Arc::new(flags.finish()),
        Arc::new(sum_len.finish()),
        Arc::new(rep_len.finish()),
        Arc::new(rep_alt.finish()),
        Arc::new(rep_speed.finish()),
        Arc::new(fid_list),
        Arc::new(typecode_list),
        Arc::new(callsign_list),
        Arc::new(source_id.finish()),
        Arc::new(origin.finish()),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    write_record_batches(path, &schema, &[batch])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arrow_io::read_record_batches;
    use tempfile::tempdir;

    #[test]
    fn cruise_round_trip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("cruise.arrow");
        let cs = vec![CruiseBucket {
            r8_hex: 0xABC,
            class: 5,
            rep_profile_idx: 7,
            fl_bin: 3,
            period: 0,
            flags: 1,
            sum_length_m: 5000.0,
            rep_len_m: 1500.0,
            rep_alt_m: 11_000.0,
            rep_speed_kt: 460.0,
            cruise_flight_ids: vec![1, 2, 3],
            cruise_aircraft_types: vec![*b"A320", *b"B738", *b"E190"],
            cruise_callsigns: vec!["CSA001".into(), "RYR123".into(), "LH1234".into()],
            source_id: 0,
            origin: 0,
        }];
        write_cruise(&p, &cs, 1).unwrap();
        let (_, batches) = read_record_batches(&p).unwrap();
        assert_eq!(batches[0].num_rows(), 1);
    }

    /// `cruise_aircraft_types` and `cruise_callsigns` are parallel-indexed
    /// against `cruise_flight_ids` — downstream lookups (`fid_meta` in
    /// noise-compute) rely on this. Catch a drift between the writer's
    /// finalize order and the reader's column ordering early. `debug_assert`
    /// in the writer is stripped in release; this test guards in CI.
    #[test]
    fn cruise_per_fid_arrays_share_offsets() {
        use arrow::array::{Array, FixedSizeBinaryArray, ListArray, StringArray, UInt64Array};

        let dir = tempdir().unwrap();
        let p = dir.path().join("cruise.arrow");
        let cs = vec![
            CruiseBucket {
                r8_hex: 0x100,
                class: 1,
                rep_profile_idx: 2,
                fl_bin: 3,
                period: 0,
                flags: 1,
                sum_length_m: 1000.0,
                rep_len_m: 500.0,
                rep_alt_m: 10_000.0,
                rep_speed_kt: 450.0,
                cruise_flight_ids: vec![10, 20],
                cruise_aircraft_types: vec![*b"A320", *b"B738"],
                cruise_callsigns: vec!["CSA01".into(), "RYR02".into()],
                source_id: 0,
                origin: 0,
            },
            CruiseBucket {
                r8_hex: 0x200,
                class: 2,
                rep_profile_idx: 3,
                fl_bin: 4,
                period: 1,
                flags: 1,
                sum_length_m: 2000.0,
                rep_len_m: 800.0,
                rep_alt_m: 11_000.0,
                rep_speed_kt: 460.0,
                cruise_flight_ids: vec![30, 40, 50],
                cruise_aircraft_types: vec![*b"E190", *b"CRJ\0", *b"B777"],
                cruise_callsigns: vec!["LH03".into(), "AF04".into(), "BA05".into()],
                source_id: 0,
                origin: 0,
            },
        ];
        write_cruise(&p, &cs, 7).unwrap();

        let (_, batches) = read_record_batches(&p).unwrap();
        let batch = &batches[0];
        let fid_list = batch
            .column_by_name("cruise_flight_ids")
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap();
        let tc_list = batch
            .column_by_name("cruise_aircraft_types")
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap();
        let cs_list = batch
            .column_by_name("cruise_callsigns")
            .unwrap()
            .as_any()
            .downcast_ref::<ListArray>()
            .unwrap();

        for (row, expected) in cs.iter().enumerate() {
            let fids = fid_list.value(row);
            let fids = fids.as_any().downcast_ref::<UInt64Array>().unwrap();
            let tcs = tc_list.value(row);
            let tcs = tcs.as_any().downcast_ref::<FixedSizeBinaryArray>().unwrap();
            let css = cs_list.value(row);
            let css = css.as_any().downcast_ref::<StringArray>().unwrap();
            assert_eq!(fids.len(), expected.cruise_flight_ids.len());
            assert_eq!(tcs.len(), expected.cruise_aircraft_types.len());
            assert_eq!(css.len(), expected.cruise_callsigns.len());
            for i in 0..fids.len() {
                assert_eq!(fids.value(i), expected.cruise_flight_ids[i]);
                assert_eq!(tcs.value(i), expected.cruise_aircraft_types[i]);
                assert_eq!(css.value(i), expected.cruise_callsigns[i]);
            }
        }
    }
}
