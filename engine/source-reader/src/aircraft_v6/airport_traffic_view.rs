//! `AirportTrafficRowView<'_>` builder over `airport_traffic.arrow`
//! batches. Same lifetime story as the other v6 views — snapshot each
//! column into owned Rust memory so the kernel's `&'_` view doesn't
//! borrow into the mmap'd Arrow buffers.

use arrow::array::Array;
use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::AirportTrafficRowView;

use super::columns::{col_fixed_size_list, col_f32, col_str, col_u16, col_u64, col_u8};

const NUM_BANDS: usize = 8;

/// Owned column buffers for one airport_traffic.arrow batch slice.
/// Each `Vec` parallels the others — index `i` describes one row.
pub struct AirportTrafficRowAccum {
    airport_key: Vec<String>,
    osm_id: Vec<u64>,
    segment_idx: Vec<u16>,
    geometry_kind: Vec<u8>,
    start_lat: Vec<f32>,
    start_lon: Vec<f32>,
    end_lat: Vec<f32>,
    end_lon: Vec<f32>,
    length_m: Vec<f32>,
    ops_kind: Vec<u8>,
    is_departure: Vec<u8>,
    veh_kind: Vec<u8>,
    class_idx: Vec<u8>,
    period: Vec<u8>,
    movements_per_day: Vec<f32>,
    band_energy_lin: Vec<[f32; NUM_BANDS]>,
}

impl AirportTrafficRowAccum {
    pub fn new(batches: &[RecordBatch]) -> Self {
        let mut out = AirportTrafficRowAccum {
            airport_key: Vec::new(),
            osm_id: Vec::new(),
            segment_idx: Vec::new(),
            geometry_kind: Vec::new(),
            start_lat: Vec::new(),
            start_lon: Vec::new(),
            end_lat: Vec::new(),
            end_lon: Vec::new(),
            length_m: Vec::new(),
            ops_kind: Vec::new(),
            is_departure: Vec::new(),
            veh_kind: Vec::new(),
            class_idx: Vec::new(),
            period: Vec::new(),
            movements_per_day: Vec::new(),
            band_energy_lin: Vec::new(),
        };
        for batch in batches {
            out.absorb(batch);
        }
        out
    }

    fn absorb(&mut self, batch: &RecordBatch) {
        let n = batch.num_rows();
        let (
            Some(airport_key),
            Some(osm_id),
            Some(seg_idx),
            Some(geom_kind),
            Some(sla),
            Some(slo),
            Some(ela),
            Some(elo),
            Some(len_m),
            Some(ops_kind),
            Some(is_dep),
            Some(veh_kind),
            Some(class_idx),
            Some(period),
            Some(mpd),
            Some(bands),
        ) = (
            col_str(batch, "airport_key"),
            col_u64(batch, "osm_id"),
            col_u16(batch, "segment_idx"),
            col_u8(batch, "geometry_kind"),
            col_f32(batch, "start_lat"),
            col_f32(batch, "start_lon"),
            col_f32(batch, "end_lat"),
            col_f32(batch, "end_lon"),
            col_f32(batch, "length_m"),
            col_u8(batch, "ops_kind"),
            col_u8(batch, "is_departure"),
            col_u8(batch, "veh_kind"),
            col_u8(batch, "class_idx"),
            col_u8(batch, "period"),
            col_f32(batch, "movements_per_day"),
            col_fixed_size_list(batch, "band_energy_lin"),
        ) else {
            return;
        };
        if bands.value_length() != NUM_BANDS as i32 {
            return;
        }
        let band_values = bands.values();
        let Some(band_f32) = band_values.as_any().downcast_ref::<arrow::array::Float32Array>()
        else {
            return;
        };
        let band_buf = band_f32.values();
        self.airport_key.reserve(n);
        self.band_energy_lin.reserve(n);
        for i in 0..n {
            self.airport_key.push(airport_key.value(i).to_string());
            self.osm_id.push(osm_id.value(i));
            self.segment_idx.push(seg_idx.value(i));
            self.geometry_kind.push(geom_kind.value(i));
            self.start_lat.push(sla.value(i));
            self.start_lon.push(slo.value(i));
            self.end_lat.push(ela.value(i));
            self.end_lon.push(elo.value(i));
            self.length_m.push(len_m.value(i));
            self.ops_kind.push(ops_kind.value(i));
            self.is_departure.push(is_dep.value(i));
            self.veh_kind.push(veh_kind.value(i));
            self.class_idx.push(class_idx.value(i));
            self.period.push(period.value(i));
            self.movements_per_day.push(mpd.value(i));
            let lo = i * NUM_BANDS;
            let mut row_bands = [0.0f32; NUM_BANDS];
            row_bands.copy_from_slice(&band_buf[lo..lo + NUM_BANDS]);
            self.band_energy_lin.push(row_bands);
        }
    }

    pub fn views(&self) -> Vec<AirportTrafficRowView<'_>> {
        (0..self.airport_key.len())
            .map(|i| AirportTrafficRowView {
                airport_key: &self.airport_key[i],
                osm_id: self.osm_id[i],
                segment_idx: self.segment_idx[i],
                geometry_kind: self.geometry_kind[i],
                start_lat: self.start_lat[i],
                start_lon: self.start_lon[i],
                end_lat: self.end_lat[i],
                end_lon: self.end_lon[i],
                length_m: self.length_m[i],
                ops_kind: self.ops_kind[i],
                is_departure: self.is_departure[i],
                veh_kind: self.veh_kind[i],
                class_idx: self.class_idx[i],
                period: self.period[i],
                movements_per_day: self.movements_per_day[i],
                band_energy_lin: &self.band_energy_lin[i],
            })
            .collect()
    }
}
