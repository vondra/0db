//! Stage 2B cruise writer.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{ArrayRef, Float32Builder, ListArray, UInt64Builder, UInt8Builder};
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

    let mut fid_off: Vec<i32> = Vec::with_capacity(n + 1);
    fid_off.push(0);
    let mut total_fids = 0usize;
    let mut fid_vals = UInt64Builder::with_capacity(rows.iter().map(|r| r.cruise_flight_ids.len()).sum());

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
        for &fid in &r.cruise_flight_ids {
            fid_vals.append_value(fid);
        }
        total_fids += r.cruise_flight_ids.len();
        fid_off.push(total_fids as i32);
    }
    let fid_item_field = Arc::new(Field::new("item", DataType::UInt64, false));
    let fid_list = ListArray::new(
        fid_item_field,
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(fid_off)),
        Arc::new(fid_vals.finish()),
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
            source_id: 0,
            origin: 0,
        }];
        write_cruise(&p, &cs, 1).unwrap();
        let (_, batches) = read_record_batches(&p).unwrap();
        assert_eq!(batches[0].num_rows(), 1);
    }
}
