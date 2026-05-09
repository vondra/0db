//! Stage 2A airborne writer.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    Array, ArrayRef, FixedSizeBinaryBuilder, Float32Builder, Int16Builder, ListArray, StringBuilder,
    StructArray, UInt64Builder, UInt8Builder,
};
use arrow::buffer::OffsetBuffer;
use arrow::datatypes::{DataType, Field};
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;
use crate::flight::AirborneEvent;

use super::write_record_batches;

pub fn write_airborne(path: &Path, rows: &[AirborneEvent], n_days: u16) -> Result<()> {
    let schema = arrow_schemas::with_n_days(arrow_schemas::airborne_schema(), n_days);
    let n = rows.len();
    let mut flight_id = UInt64Builder::with_capacity(n);
    let mut callsign = StringBuilder::with_capacity(n, 8 * n);
    let mut aircraft_type = FixedSizeBinaryBuilder::with_capacity(n, 4);
    let mut profile_idx = UInt8Builder::with_capacity(n);
    let mut source_id = UInt8Builder::with_capacity(n);
    let mut origin = UInt8Builder::with_capacity(n);
    let mut total_len = Float32Builder::with_capacity(n);
    let mut bb_min_la = Float32Builder::with_capacity(n);
    let mut bb_max_la = Float32Builder::with_capacity(n);
    let mut bb_min_lo = Float32Builder::with_capacity(n);
    let mut bb_max_lo = Float32Builder::with_capacity(n);

    let sub_struct_fields = match schema.field_with_name("sub_segments")?.data_type() {
        DataType::List(item) => match item.data_type() {
            DataType::Struct(f) => f.clone(),
            other => anyhow::bail!("airborne sub_segments item not Struct ({other:?})"),
        },
        _ => unreachable!(),
    };
    let mut sub_off: Vec<i32> = Vec::with_capacity(n + 1);
    sub_off.push(0);
    let mut total_subs = 0usize;
    for r in rows {
        flight_id.append_value(r.flight_id);
        callsign.append_value(&r.callsign);
        aircraft_type.append_value(r.aircraft_type)?;
        profile_idx.append_value(r.profile_idx);
        source_id.append_value(r.source_id);
        origin.append_value(r.origin);
        total_len.append_value(r.total_length_m);
        bb_min_la.append_value(r.bbox_min_lat);
        bb_max_la.append_value(r.bbox_max_lat);
        bb_min_lo.append_value(r.bbox_min_lon);
        bb_max_lo.append_value(r.bbox_max_lon);
        total_subs += r.sub_segments.len();
        sub_off.push(total_subs as i32);
    }

    let mut sla = Float32Builder::with_capacity(total_subs);
    let mut slo = Float32Builder::with_capacity(total_subs);
    let mut sal = Float32Builder::with_capacity(total_subs);
    let mut ela = Float32Builder::with_capacity(total_subs);
    let mut elo = Float32Builder::with_capacity(total_subs);
    let mut eal = Float32Builder::with_capacity(total_subs);
    let mut speed = Float32Builder::with_capacity(total_subs);
    let mut length = Float32Builder::with_capacity(total_subs);
    let mut period = UInt8Builder::with_capacity(total_subs);
    let mut date_id = Int16Builder::with_capacity(total_subs);
    let mut flags = UInt8Builder::with_capacity(total_subs);
    for r in rows {
        for s in &r.sub_segments {
            sla.append_value(s.start_lat);
            slo.append_value(s.start_lon);
            sal.append_value(s.start_alt_m);
            ela.append_value(s.end_lat);
            elo.append_value(s.end_lon);
            eal.append_value(s.end_alt_m);
            speed.append_value(s.speed_kt);
            length.append_value(s.length_m);
            period.append_value(s.period);
            date_id.append_value(s.date_id);
            flags.append_value(s.flags);
        }
    }
    let sub_struct = StructArray::new(
        sub_struct_fields,
        vec![
            Arc::new(sla.finish()) as ArrayRef,
            Arc::new(slo.finish()),
            Arc::new(sal.finish()),
            Arc::new(ela.finish()),
            Arc::new(elo.finish()),
            Arc::new(eal.finish()),
            Arc::new(speed.finish()),
            Arc::new(length.finish()),
            Arc::new(period.finish()),
            Arc::new(date_id.finish()),
            Arc::new(flags.finish()),
        ],
        None,
    );
    let item_field = match schema.field_with_name("sub_segments")?.data_type() {
        DataType::List(item) => Arc::new(Field::new(
            item.name(),
            sub_struct.data_type().clone(),
            item.is_nullable(),
        )),
        _ => unreachable!(),
    };
    let sub_list = ListArray::new(
        item_field,
        OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(sub_off)),
        Arc::new(sub_struct),
        None,
    );

    let columns: Vec<ArrayRef> = vec![
        Arc::new(flight_id.finish()),
        Arc::new(callsign.finish()),
        Arc::new(aircraft_type.finish()),
        Arc::new(profile_idx.finish()),
        Arc::new(source_id.finish()),
        Arc::new(origin.finish()),
        Arc::new(sub_list),
        Arc::new(total_len.finish()),
        Arc::new(bb_min_la.finish()),
        Arc::new(bb_max_la.finish()),
        Arc::new(bb_min_lo.finish()),
        Arc::new(bb_max_lo.finish()),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    write_record_batches(path, &schema, &[batch])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arrow_io::read_record_batches;
    use crate::flight::AirborneSubSegment;
    use tempfile::tempdir;

    #[test]
    fn airborne_round_trip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("airborne.arrow");
        let evs = vec![AirborneEvent {
            flight_id: 1,
            callsign: "TVS100P".into(),
            aircraft_type: *b"A320",
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            sub_segments: vec![AirborneSubSegment {
                start_lat: 50.0,
                start_lon: 14.0,
                start_alt_m: 1000.0,
                end_lat: 50.001,
                end_lon: 14.001,
                end_alt_m: 1100.0,
                speed_kt: 250.0,
                length_m: 300.0,
                period: 0,
                date_id: 1,
                flags: 0,
            }],
            total_length_m: 300.0,
            bbox_min_lat: 50.0,
            bbox_max_lat: 50.001,
            bbox_min_lon: 14.0,
            bbox_max_lon: 14.001,
        }];
        write_airborne(&p, &evs, 1).unwrap();
        let (_, batches) = read_record_batches(&p).unwrap();
        assert_eq!(batches[0].num_rows(), 1);
    }
}
