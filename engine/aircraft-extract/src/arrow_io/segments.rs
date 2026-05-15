//! Stage 1 segments writer + reader.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    ArrayRef, FixedSizeBinaryArray, FixedSizeBinaryBuilder, Float32Array, Float32Builder,
    Int16Array, Int16Builder, StringArray, StringBuilder, UInt64Array, UInt64Builder, UInt8Array,
    UInt8Builder,
};
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;
use crate::flight::FlightSegment;

use super::{read_all_batches, write_record_batches};

pub fn write_segments(path: &Path, rows: &[FlightSegment]) -> Result<()> {
    let schema = arrow_schemas::segments_schema();
    let n = rows.len();
    let mut flight_id = UInt64Builder::with_capacity(n);
    let mut callsign = StringBuilder::with_capacity(n, 8 * n);
    let mut aircraft_type = FixedSizeBinaryBuilder::with_capacity(n, 4);
    let mut profile_idx = UInt8Builder::with_capacity(n);
    let mut source_id = UInt8Builder::with_capacity(n);
    let mut origin = UInt8Builder::with_capacity(n);
    let mut veh_kind = UInt8Builder::with_capacity(n);
    let mut gse_class = UInt8Builder::with_capacity(n);
    let mut period = UInt8Builder::with_capacity(n);
    let mut date_id = Int16Builder::with_capacity(n);
    let mut phase = UInt8Builder::with_capacity(n);
    let mut flags = UInt8Builder::with_capacity(n);
    let mut sla = Float32Builder::with_capacity(n);
    let mut slo = Float32Builder::with_capacity(n);
    let mut sal = Float32Builder::with_capacity(n);
    let mut ela = Float32Builder::with_capacity(n);
    let mut elo = Float32Builder::with_capacity(n);
    let mut eal = Float32Builder::with_capacity(n);
    let mut speed = Float32Builder::with_capacity(n);
    let mut length = Float32Builder::with_capacity(n);
    let mut agl = Float32Builder::with_capacity(n);
    for r in rows {
        flight_id.append_value(r.flight_id);
        callsign.append_value(&r.callsign);
        aircraft_type.append_value(r.aircraft_type)?;
        profile_idx.append_value(r.profile_idx);
        source_id.append_value(r.source_id);
        origin.append_value(r.origin);
        veh_kind.append_value(r.veh_kind);
        gse_class.append_value(r.gse_class);
        period.append_value(r.period);
        date_id.append_value(r.date_id);
        phase.append_value(r.phase.as_u8());
        flags.append_value(r.flags);
        sla.append_value(r.start_lat);
        slo.append_value(r.start_lon);
        sal.append_value(r.start_alt_m);
        ela.append_value(r.end_lat);
        elo.append_value(r.end_lon);
        eal.append_value(r.end_alt_m);
        speed.append_value(r.speed_kt);
        length.append_value(r.length_m);
        agl.append_value(r.agl_avg_m);
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(flight_id.finish()),
        Arc::new(callsign.finish()),
        Arc::new(aircraft_type.finish()),
        Arc::new(profile_idx.finish()),
        Arc::new(source_id.finish()),
        Arc::new(origin.finish()),
        Arc::new(veh_kind.finish()),
        Arc::new(gse_class.finish()),
        Arc::new(period.finish()),
        Arc::new(date_id.finish()),
        Arc::new(phase.finish()),
        Arc::new(flags.finish()),
        Arc::new(sla.finish()),
        Arc::new(slo.finish()),
        Arc::new(sal.finish()),
        Arc::new(ela.finish()),
        Arc::new(elo.finish()),
        Arc::new(eal.finish()),
        Arc::new(speed.finish()),
        Arc::new(length.finish()),
        Arc::new(agl.finish()),
    ];
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    write_record_batches(path, &schema, &[batch])
}

pub fn read_segments(path: &Path) -> Result<Vec<FlightSegment>> {
    let (_, batches) = read_all_batches(path)?;
    let mut out = Vec::new();
    for b in batches {
        let flight_id = b
            .column_by_name("flight_id")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt64Array>()
            .unwrap();
        let callsign = b
            .column_by_name("callsign")
            .unwrap()
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        let aircraft_type = b
            .column_by_name("aircraft_type")
            .unwrap()
            .as_any()
            .downcast_ref::<FixedSizeBinaryArray>()
            .unwrap();
        let profile_idx = b
            .column_by_name("profile_idx")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let source_id = b
            .column_by_name("source_id")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let origin = b
            .column_by_name("origin")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let veh_kind = b
            .column_by_name("veh_kind")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let gse_class = b
            .column_by_name("gse_class")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let period = b
            .column_by_name("period")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let date_id = b
            .column_by_name("date_id")
            .unwrap()
            .as_any()
            .downcast_ref::<Int16Array>()
            .unwrap();
        let phase = b
            .column_by_name("phase")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let flags = b
            .column_by_name("flags")
            .unwrap()
            .as_any()
            .downcast_ref::<UInt8Array>()
            .unwrap();
        let sla = b
            .column_by_name("start_lat")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let slo = b
            .column_by_name("start_lon")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let sal = b
            .column_by_name("start_alt_m")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let ela = b
            .column_by_name("end_lat")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let elo = b
            .column_by_name("end_lon")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let eal = b
            .column_by_name("end_alt_m")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let speed = b
            .column_by_name("speed_kt")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let length = b
            .column_by_name("length_m")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let agl = b
            .column_by_name("agl_avg_m")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        for i in 0..b.num_rows() {
            let mut typecode = [0u8; 4];
            typecode.copy_from_slice(aircraft_type.value(i));
            out.push(FlightSegment {
                flight_id: flight_id.value(i),
                callsign: callsign.value(i).to_string(),
                aircraft_type: typecode,
                profile_idx: profile_idx.value(i),
                source_id: source_id.value(i),
                origin: origin.value(i),
                veh_kind: veh_kind.value(i),
                gse_class: gse_class.value(i),
                period: period.value(i),
                date_id: date_id.value(i),
                phase: crate::flight::Phase::from_u8(phase.value(i)),
                flags: flags.value(i),
                start_lat: sla.value(i),
                start_lon: slo.value(i),
                start_alt_m: sal.value(i),
                end_lat: ela.value(i),
                end_lon: elo.value(i),
                end_alt_m: eal.value(i),
                speed_kt: speed.value(i),
                length_m: length.value(i),
                agl_avg_m: agl.value(i),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flight::Phase;
    use tempfile::tempdir;

    #[test]
    fn segments_round_trip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("segments.arrow");
        let segs = vec![FlightSegment {
            flight_id: 0xDEAD_BEEF,
            callsign: "TVS100P".into(),
            aircraft_type: *b"A320",
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            // Distinct non-zero values catch builder/schema column-order
            // transposition (would otherwise round-trip identically when
            // both fields happen to default to 0).
            veh_kind: 1,
            gse_class: 2,
            period: 1,
            date_id: 1234,
            phase: Phase::Airborne,
            flags: 0b011,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 1000.0,
            end_lat: 50.001,
            end_lon: 14.001,
            end_alt_m: 1100.0,
            speed_kt: 250.0,
            length_m: 300.0,
            agl_avg_m: 700.0,
        }];
        write_segments(&p, &segs).unwrap();
        let read = read_segments(&p).unwrap();
        assert_eq!(read.len(), 1);
        let r = &read[0];
        assert_eq!(r.flight_id, 0xDEAD_BEEF);
        assert_eq!(r.callsign, "TVS100P");
        assert_eq!(&r.aircraft_type, b"A320");
        assert_eq!(r.phase, Phase::Airborne);
        assert!((r.length_m - 300.0).abs() < 1e-3);
        assert_eq!(r.veh_kind, 1);
        assert_eq!(r.gse_class, 2);
    }
}
