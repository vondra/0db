//! Stage 1 segments writer + reader.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{
    ArrayRef, FixedSizeBinaryArray, FixedSizeBinaryBuilder, Float32Array, Float32Builder,
    Int16Array, Int16Builder, StringArray, StringBuilder, UInt64Array, UInt64Builder, UInt8Array,
    UInt8Builder,
};
use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;
use crate::flight::FlightSegment;

use super::{for_each_batch, write_record_batches};

/// Rows per record batch. A whole-day Stage 1 shard is ~100M segments; a
/// single batch would be ~8 GB resident on read, which Stage 2B's
/// batch-streaming reader can't bound (it streams whole batches). ~1M rows
/// ≈ 80 MB decoded keeps the per-batch read small. See [`for_each_batch`].
const WRITE_CHUNK_ROWS: usize = 1_000_000;

pub fn write_segments(path: &Path, rows: &[FlightSegment]) -> Result<()> {
    write_segments_chunked(path, rows, WRITE_CHUNK_ROWS)
}

fn write_segments_chunked(path: &Path, rows: &[FlightSegment], chunk_rows: usize) -> Result<()> {
    let schema = arrow_schemas::segments_schema();
    let batches = rows
        .chunks(chunk_rows.max(1))
        .map(|chunk| build_segments_batch(chunk, &schema))
        .collect::<Result<Vec<_>>>()?;
    write_record_batches(path, &schema, &batches)
}

/// Build one segments record batch from up to `WRITE_CHUNK_ROWS` rows.
fn build_segments_batch(rows: &[FlightSegment], schema: &Arc<Schema>) -> Result<RecordBatch> {
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
    let mut s_elev = Float32Builder::with_capacity(n);
    let mut e_elev = Float32Builder::with_capacity(n);
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
        s_elev.append_value(r.start_elev_m);
        e_elev.append_value(r.end_elev_m);
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
        Arc::new(s_elev.finish()),
        Arc::new(e_elev.finish()),
    ];
    Ok(RecordBatch::try_new(schema.clone(), columns)?)
}

/// Decode one segments record batch — the per-batch half of
/// [`read_segments`], reused by the streaming [`for_each_segment_batch`].
fn segments_from_batch(b: &RecordBatch) -> Result<Vec<FlightSegment>> {
    let mut out = Vec::with_capacity(b.num_rows());
    // Scoped so the per-column array borrows of `b` drop before returning.
    {
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
        let s_elev = b
            .column_by_name("start_elev_m")
            .unwrap()
            .as_any()
            .downcast_ref::<Float32Array>()
            .unwrap();
        let e_elev = b
            .column_by_name("end_elev_m")
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
                start_elev_m: s_elev.value(i),
                end_elev_m: e_elev.value(i),
            });
        }
    }
    Ok(out)
}

/// Stream a segments shard batch-by-batch, handing each batch's decoded
/// segments to `f` and dropping them before the next — peak RAM is one
/// batch, not the whole file. Stage 2B scans multi-GB day shards this way
/// instead of [`read_segments`] (which holds the entire file in RAM).
/// Decode a record batch at most this many rows at a time. A legacy
/// single-batch day shard holds ~100M rows in ONE batch; decoding it whole
/// would materialise ~8 GB of `FlightSegment`s at once (on top of the ~8 GB
/// arrow batch), so slice it. Newer shards are written in `WRITE_CHUNK_ROWS`
/// batches and decode in one slice. ~256k rows ≈ 20 MB decoded.
const READ_CHUNK_ROWS: usize = 262_144;

pub(crate) fn for_each_segment_batch(
    path: &Path,
    f: impl FnMut(Vec<FlightSegment>) -> Result<()>,
) -> Result<()> {
    for_each_segment_slice(path, READ_CHUNK_ROWS, f)
}

fn for_each_segment_slice(
    path: &Path,
    slice_rows: usize,
    mut f: impl FnMut(Vec<FlightSegment>) -> Result<()>,
) -> Result<()> {
    for_each_batch(path, |b| {
        let n = b.num_rows();
        let mut off = 0;
        while off < n {
            let len = slice_rows.min(n - off);
            f(segments_from_batch(&b.slice(off, len))?)?;
            off += len;
        }
        Ok(())
    })
}

pub fn read_segments(path: &Path) -> Result<Vec<FlightSegment>> {
    let mut out = Vec::new();
    for_each_segment_batch(path, |mut segs| {
        out.append(&mut segs);
        Ok(())
    })?;
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
            start_elev_m: 250.0,
            end_elev_m: 280.0,
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
        assert!((r.start_elev_m - 250.0).abs() < 1e-3);
        assert!((r.end_elev_m - 280.0).abs() < 1e-3);
    }

    fn seg_with_id(id: u64) -> FlightSegment {
        FlightSegment {
            flight_id: id,
            callsign: String::new(),
            aircraft_type: *b"A320",
            profile_idx: 0,
            source_id: 0,
            origin: 0,
            veh_kind: 0,
            gse_class: 0,
            period: 0,
            date_id: 0,
            phase: Phase::Cruise,
            flags: 0,
            start_lat: 0.0,
            start_lon: 0.0,
            start_alt_m: 0.0,
            end_lat: 0.0,
            end_lon: 0.0,
            end_alt_m: 0.0,
            speed_kt: 0.0,
            length_m: 0.0,
            agl_avg_m: 0.0,
            start_elev_m: 0.0,
            end_elev_m: 0.0,
        }
    }

    /// A multi-batch file (the shape Stage 2B's streaming reader needs to
    /// bound memory) must round-trip in original row order, and
    /// `for_each_segment_batch` must yield one Vec per batch.
    #[test]
    fn write_chunks_into_streamable_batches() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("seg.arrow");
        let segs: Vec<FlightSegment> = (0..5u64).map(seg_with_id).collect();
        write_segments_chunked(&p, &segs, 2).unwrap(); // 5 rows / chunk 2 → 3 batches

        let mut nbatch = 0;
        for_each_batch(&p, |_| {
            nbatch += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(nbatch, 3, "5 rows / chunk 2 → 3 record batches");

        let ids: Vec<u64> = read_segments(&p)
            .unwrap()
            .iter()
            .map(|s| s.flight_id)
            .collect();
        assert_eq!(
            ids,
            vec![0, 1, 2, 3, 4],
            "read_segments concatenates in row order"
        );

        let mut streamed = Vec::new();
        for_each_segment_batch(&p, |b| {
            streamed.extend(b.iter().map(|s| s.flight_id));
            Ok(())
        })
        .unwrap();
        assert_eq!(streamed, vec![0, 1, 2, 3, 4]);
    }

    /// A single large batch (the legacy ~100M-row shard shape) must decode in
    /// row-slices — preserving order across slice boundaries — so it never
    /// materialises whole.
    #[test]
    fn single_batch_decodes_in_ordered_slices() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("seg.arrow");
        let segs: Vec<FlightSegment> = (0..5u64).map(seg_with_id).collect();
        write_segments_chunked(&p, &segs, 1000).unwrap(); // one batch of 5 rows

        let mut nbatch = 0;
        for_each_batch(&p, |_| {
            nbatch += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(nbatch, 1, "5 rows / chunk 1000 → one batch");

        let mut slices = 0;
        let mut ids = Vec::new();
        for_each_segment_slice(&p, 2, |s| {
            slices += 1;
            ids.extend(s.iter().map(|x| x.flight_id));
            Ok(())
        })
        .unwrap();
        assert_eq!(slices, 3, "one 5-row batch / slice 2 → 3 decode slices");
        assert_eq!(ids, vec![0, 1, 2, 3, 4]);
    }
}
