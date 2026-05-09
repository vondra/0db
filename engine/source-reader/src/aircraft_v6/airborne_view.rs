//! Airborne row accumulator. Each `OwnedAirborneRow` owns small
//! `Vec<T>` copies of one row's sub-segment columns so the
//! `AirborneRowView<'_>` we hand to `compute_aircraft_v6` borrows
//! into stable, Vec-backed memory rather than into the live
//! `Arc<RecordBatch>` arrow buffers (whose lifetime is tied to the
//! mmap kept alive by `HexData`). Owning per-row keeps the borrow
//! story simple at the cost of one shallow copy per popup query.

use arrow::array::*;
use noise_compute::compute::aircraft_v6::{AirborneRowView, BBox, SubSegmentSlice};

use super::columns::{col_f32, col_fixed_size_binary, col_list, col_str, col_u64, col_u8};

pub struct AirborneRowAccum {
    rows: Vec<OwnedAirborneRow>,
}

struct OwnedAirborneRow {
    flight_id: u64,
    callsign: String,
    aircraft_type: [u8; 4],
    profile_idx: u8,
    source_id: u8,
    origin: u8,
    sub_start_lat: Vec<f32>,
    sub_start_lon: Vec<f32>,
    sub_start_alt_m: Vec<f32>,
    sub_end_lat: Vec<f32>,
    sub_end_lon: Vec<f32>,
    sub_end_alt_m: Vec<f32>,
    sub_speed_kt: Vec<f32>,
    sub_length_m: Vec<f32>,
    sub_period: Vec<u8>,
    sub_date_id: Vec<i16>,
    sub_flags: Vec<u8>,
    bbox: BBox,
}

struct SubSegmentColumns<'a> {
    start_lat: &'a Float32Array,
    start_lon: &'a Float32Array,
    start_alt_m: &'a Float32Array,
    end_lat: &'a Float32Array,
    end_lon: &'a Float32Array,
    end_alt_m: &'a Float32Array,
    speed_kt: &'a Float32Array,
    length_m: &'a Float32Array,
    period: &'a UInt8Array,
    date_id: &'a Int16Array,
    flags: &'a UInt8Array,
}

impl<'a> SubSegmentColumns<'a> {
    fn from_struct(s: &'a StructArray) -> Option<Self> {
        let f = |name: &str| s.column_by_name(name);
        Some(SubSegmentColumns {
            start_lat: f("start_lat")?.as_any().downcast_ref::<Float32Array>()?,
            start_lon: f("start_lon")?.as_any().downcast_ref::<Float32Array>()?,
            start_alt_m: f("start_alt_m")?.as_any().downcast_ref::<Float32Array>()?,
            end_lat: f("end_lat")?.as_any().downcast_ref::<Float32Array>()?,
            end_lon: f("end_lon")?.as_any().downcast_ref::<Float32Array>()?,
            end_alt_m: f("end_alt_m")?.as_any().downcast_ref::<Float32Array>()?,
            speed_kt: f("speed_kt")?.as_any().downcast_ref::<Float32Array>()?,
            length_m: f("length_m")?.as_any().downcast_ref::<Float32Array>()?,
            period: f("period")?.as_any().downcast_ref::<UInt8Array>()?,
            date_id: f("date_id")?.as_any().downcast_ref::<Int16Array>()?,
            flags: f("flags")?.as_any().downcast_ref::<UInt8Array>()?,
        })
    }
}

impl AirborneRowAccum {
    pub fn new(batches: &[arrow::record_batch::RecordBatch]) -> Self {
        let mut rows = Vec::new();
        for batch in batches {
            let n = batch.num_rows();
            if n == 0 {
                continue;
            }
            let Some(flight_id) = col_u64(batch, "flight_id") else { continue };
            let Some(callsign) = col_str(batch, "callsign") else { continue };
            let Some(aircraft_type) = col_fixed_size_binary(batch, "aircraft_type") else { continue };
            let Some(profile_idx) = col_u8(batch, "profile_idx") else { continue };
            let Some(source_id) = col_u8(batch, "source_id") else { continue };
            let origin = col_u8(batch, "origin");
            let Some(bb_min_lat) = col_f32(batch, "bbox_min_lat") else { continue };
            let Some(bb_max_lat) = col_f32(batch, "bbox_max_lat") else { continue };
            let Some(bb_min_lon) = col_f32(batch, "bbox_min_lon") else { continue };
            let Some(bb_max_lon) = col_f32(batch, "bbox_max_lon") else { continue };
            let Some(sub_list) = col_list(batch, "sub_segments") else { continue };
            let Some(sub_struct) = sub_list.values().as_any().downcast_ref::<StructArray>() else {
                continue;
            };
            let Some(s) = SubSegmentColumns::from_struct(sub_struct) else { continue };
            let offsets = sub_list.value_offsets();
            for i in 0..n {
                let lo = offsets[i] as usize;
                let hi = offsets[i + 1] as usize;
                let mut typecode = [0u8; 4];
                typecode.copy_from_slice(aircraft_type.value(i));
                rows.push(OwnedAirborneRow {
                    flight_id: flight_id.value(i),
                    callsign: callsign.value(i).to_string(),
                    aircraft_type: typecode,
                    profile_idx: profile_idx.value(i),
                    source_id: source_id.value(i),
                    origin: origin.map(|a| a.value(i)).unwrap_or(0),
                    sub_start_lat: s.start_lat.values()[lo..hi].to_vec(),
                    sub_start_lon: s.start_lon.values()[lo..hi].to_vec(),
                    sub_start_alt_m: s.start_alt_m.values()[lo..hi].to_vec(),
                    sub_end_lat: s.end_lat.values()[lo..hi].to_vec(),
                    sub_end_lon: s.end_lon.values()[lo..hi].to_vec(),
                    sub_end_alt_m: s.end_alt_m.values()[lo..hi].to_vec(),
                    sub_speed_kt: s.speed_kt.values()[lo..hi].to_vec(),
                    sub_length_m: s.length_m.values()[lo..hi].to_vec(),
                    sub_period: s.period.values()[lo..hi].to_vec(),
                    sub_date_id: s.date_id.values()[lo..hi].to_vec(),
                    sub_flags: s.flags.values()[lo..hi].to_vec(),
                    bbox: BBox {
                        min_lat: bb_min_lat.value(i),
                        max_lat: bb_max_lat.value(i),
                        min_lon: bb_min_lon.value(i),
                        max_lon: bb_max_lon.value(i),
                    },
                });
            }
        }
        Self { rows }
    }

    pub fn views(&self) -> Vec<AirborneRowView<'_>> {
        self.rows
            .iter()
            .map(|r| AirborneRowView {
                flight_id: r.flight_id,
                callsign: r.callsign.as_str(),
                aircraft_type: &r.aircraft_type,
                profile_idx: r.profile_idx,
                source_id: r.source_id,
                origin: r.origin,
                sub_segments: SubSegmentSlice {
                    start_lat: &r.sub_start_lat,
                    start_lon: &r.sub_start_lon,
                    start_alt_m: &r.sub_start_alt_m,
                    end_lat: &r.sub_end_lat,
                    end_lon: &r.sub_end_lon,
                    end_alt_m: &r.sub_end_alt_m,
                    speed_kt: &r.sub_speed_kt,
                    length_m: &r.sub_length_m,
                    period: &r.sub_period,
                    date_id: &r.sub_date_id,
                    flags: &r.sub_flags,
                },
                bbox: r.bbox,
            })
            .collect()
    }
}
