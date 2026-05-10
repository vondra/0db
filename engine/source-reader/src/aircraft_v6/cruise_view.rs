//! Cruise row accumulator. Owns the per-row `cruise_flight_ids`
//! `Vec<u64>` that the v6 view borrows; cruise scalars are tiny so a
//! by-value copy per row is cheaper than tracking arrow buffer
//! lifetimes through the popup.

use arrow::array::*;
use noise_compute::compute::aircraft_v6::CruiseRowView;

use super::columns::{col_f32, col_list, col_u64, col_u8};

pub struct CruiseRowAccum {
    rows: Vec<OwnedCruiseRow>,
}

struct OwnedCruiseRow {
    r8_hex: u64,
    class: u8,
    rep_profile_idx: u8,
    fl_bin: u8,
    period: u8,
    flags: u8,
    sum_length_m: f32,
    rep_len_m: f32,
    rep_alt_m: f32,
    rep_speed_kt: f32,
    source_id: u8,
    origin: u8,
    cruise_flight_ids: Vec<u64>,
    cruise_aircraft_types: Vec<[u8; 4]>,
    cruise_callsigns: Vec<String>,
}

impl CruiseRowAccum {
    pub fn new(batches: &[arrow::record_batch::RecordBatch]) -> Self {
        let mut rows = Vec::new();
        for batch in batches {
            let n = batch.num_rows();
            if n == 0 {
                continue;
            }
            let Some(r8) = col_u64(batch, "r8_hex") else { continue };
            let Some(class) = col_u8(batch, "class") else { continue };
            let Some(rep_pi) = col_u8(batch, "rep_profile_idx") else { continue };
            let Some(fl_bin) = col_u8(batch, "fl_bin") else { continue };
            let Some(period) = col_u8(batch, "period") else { continue };
            let Some(flags) = col_u8(batch, "flags") else { continue };
            let Some(sum_len) = col_f32(batch, "sum_length_m") else { continue };
            let Some(rep_len) = col_f32(batch, "rep_len_m") else { continue };
            let Some(rep_alt) = col_f32(batch, "rep_alt_m") else { continue };
            let Some(rep_speed) = col_f32(batch, "rep_speed_kt") else { continue };
            let source_id = col_u8(batch, "source_id");
            let origin = col_u8(batch, "origin");
            let fid_list = col_list(batch, "cruise_flight_ids");
            let typecode_list = col_list(batch, "cruise_aircraft_types");
            let callsign_list = col_list(batch, "cruise_callsigns");
            for i in 0..n {
                let cruise_flight_ids: Vec<u64> = fid_list
                    .map(|fl| {
                        fl.value(i)
                            .as_any()
                            .downcast_ref::<UInt64Array>()
                            .map(|u| u.values().to_vec())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let cruise_aircraft_types: Vec<[u8; 4]> = typecode_list
                    .map(|tl| {
                        let arr = tl.value(i);
                        arr.as_any()
                            .downcast_ref::<FixedSizeBinaryArray>()
                            .map(|fb| {
                                (0..fb.len())
                                    .map(|j| {
                                        let mut buf = [0u8; 4];
                                        buf.copy_from_slice(fb.value(j));
                                        buf
                                    })
                                    .collect()
                            })
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let cruise_callsigns: Vec<String> = callsign_list
                    .map(|cl| {
                        let arr = cl.value(i);
                        arr.as_any()
                            .downcast_ref::<StringArray>()
                            .map(|sa| (0..sa.len()).map(|j| sa.value(j).to_string()).collect())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                rows.push(OwnedCruiseRow {
                    r8_hex: r8.value(i),
                    class: class.value(i),
                    rep_profile_idx: rep_pi.value(i),
                    fl_bin: fl_bin.value(i),
                    period: period.value(i),
                    flags: flags.value(i),
                    sum_length_m: sum_len.value(i),
                    rep_len_m: rep_len.value(i),
                    rep_alt_m: rep_alt.value(i),
                    rep_speed_kt: rep_speed.value(i),
                    source_id: source_id.map(|a| a.value(i)).unwrap_or(0),
                    origin: origin.map(|a| a.value(i)).unwrap_or(0),
                    cruise_flight_ids,
                    cruise_aircraft_types,
                    cruise_callsigns,
                });
            }
        }
        Self { rows }
    }

    pub fn views(&self) -> Vec<CruiseRowView<'_>> {
        self.rows
            .iter()
            .map(|r| CruiseRowView {
                r8_hex: r.r8_hex,
                class: r.class,
                rep_profile_idx: r.rep_profile_idx,
                fl_bin: r.fl_bin,
                period: r.period,
                flags: r.flags,
                sum_length_m: r.sum_length_m,
                rep_len_m: r.rep_len_m,
                rep_alt_m: r.rep_alt_m,
                rep_speed_kt: r.rep_speed_kt,
                source_id: r.source_id,
                origin: r.origin,
                cruise_flight_ids: &r.cruise_flight_ids,
                cruise_aircraft_types: &r.cruise_aircraft_types,
                cruise_callsigns: &r.cruise_callsigns,
            })
            .collect()
    }
}
