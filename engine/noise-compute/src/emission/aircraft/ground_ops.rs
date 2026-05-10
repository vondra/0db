//! Ground-operations emission model.
//!
//! Builds per-period (day/evening/night) octave-band emission for taxi,
//! runway-roll, and apron movements. Driven by the per-leg `ops_kind`
//! classifier in `segment_filters` and the per-class reference SEL table
//! generated from EASA ANP v2.3.

use std::f64::consts::PI;

use crate::constants::{ALPHA_ATM, A_WEIGHTING};
use crate::propagation::geo;
use crate::types::{default_receiver_altitude_m, AircraftSegment, NUM_BANDS, RasterSampler};

use super::doc29::{period_leq, PERIOD_SECONDS};
use super::npd::{noise_class_of, GROUND_OPS_REFERENCE_SEL_DB};
use super::segment_filters::{
    is_ground_ops_segment, meters_to_lat_deg, meters_to_lon_deg, resolve_ground_ops_kind,
    GROUND_OPS_KIND_APRON_MOVEMENT, GROUND_OPS_KIND_NONE, GROUND_OPS_KIND_RUNWAY_ROLL,
    GROUND_OPS_KIND_TAXI, GROUND_OPS_SOURCE_HEIGHT_M,
};

const SURFACE_RUNWAY_SPEED_KT: f32 = 70.0;
const SURFACE_TAXIWAY_SPEED_KT: f32 = 18.0;
const SURFACE_APRON_SPEED_KT: f32 = 12.0;
const GROUND_OPS_REF_OFFSET_M: f64 = 25.0;
const GROUND_OPS_SPEED_CLAMP_DB: f64 = 3.0;
const GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB: f64 = 2.0;
const GROUND_OPS_RUNWAY_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [17.0, 14.0, 11.0, 8.0, 5.0, 2.0, -1.0, -5.0];
const GROUND_OPS_TAXI_SPECTRUM_SHAPE: [f64; NUM_BANDS] = [14.0, 11.0, 8.0, 5.0, 2.0, 0.0, -3.0, -7.0];
const GROUND_OPS_APRON_SPECTRUM_SHAPE: [f64; NUM_BANDS] =
    [12.0, 9.0, 6.0, 3.0, 1.0, -1.0, -4.0, -8.0];
// `GROUND_OPS_REFERENCE_SEL_DB` is generated per-noise-class in
// `profiles_generated.rs`; re-exported via the npd submodule.

pub struct GroundOpsLineEmission {
    pub kind: u8,
    pub source_height_m: f64,
    pub max_radius_m: f64,
    pub emission_day: [f32; NUM_BANDS],
    pub emission_evening: [f32; NUM_BANDS],
    pub emission_night: [f32; NUM_BANDS],
}

#[derive(Clone, Copy)]
struct GroundOpsModel {
    ref_sel_db: f64,
    spectrum_shape: [f64; NUM_BANDS],
    max_radius_m: f64,
}

pub fn build_ground_ops_line_emission(
    seg: &AircraftSegment,
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Option<GroundOpsLineEmission> {
    if !is_ground_ops_segment(seg, rasters) || n_days == 0 {
        return None;
    }

    let kind = resolve_ground_ops_kind(seg);
    if kind == GROUND_OPS_KIND_NONE {
        return None;
    }
    let model = ground_ops_model(seg, kind);

    let ((ref_lat, ref_lon), ref_dist_m, ref_fraction) = ground_ops_reference_point(seg);
    let cp = geo::closest_point_on_segment(
        ref_lat,
        ref_lon,
        seg.start_lat,
        seg.start_lon,
        seg.end_lat,
        seg.end_lon,
    );
    let cp_elev = rasters.elevation(cp.lat, cp.lon) + GROUND_OPS_SOURCE_HEIGHT_M;
    let ref_ground_elev = rasters.elevation(ref_lat, ref_lon);
    let ref_receiver_alt = default_receiver_altitude_m(ref_ground_elev);
    let d_slant = geo::slant_dist(ref_dist_m, cp_elev, ref_receiver_alt).max(1.0);
    let flc = geo::finite_line_correction(seg.segment_length_m as f64, ref_dist_m, ref_fraction);
    let geo_div = 10.0 * (2.0 * PI * d_slant).log10();
    let d_over_1000 = d_slant / 1000.0;
    let leq_ref = period_leq(
        (model.ref_sel_db * std::f64::consts::LN_10 * 0.1).exp() * seg.count_weight.max(0.0) as f64,
        n_days as f64,
        PERIOD_SECONDS[seg.period.min(2) as usize],
    );
    if !leq_ref.is_finite() {
        return None;
    }

    let template_total = template_a_weighted_total(model.spectrum_shape, d_over_1000);
    let total_emission = leq_ref + geo_div - flc - template_total;
    let active = std::array::from_fn(|i| {
        (total_emission + model.spectrum_shape[i]) as f32
    });
    let silent = [f32::NEG_INFINITY; NUM_BANDS];
    let (emission_day, emission_evening, emission_night) = match seg.period.min(2) {
        0 => (active, silent, silent),
        1 => (silent, active, silent),
        _ => (silent, silent, active),
    };

    Some(GroundOpsLineEmission {
        kind,
        source_height_m: GROUND_OPS_SOURCE_HEIGHT_M,
        max_radius_m: model.max_radius_m,
        emission_day,
        emission_evening,
        emission_night,
    })
}

fn ground_ops_reference_point(seg: &AircraftSegment) -> ((f64, f64), f64, f64) {
    let cp = geo::closest_point_on_segment(
        (seg.start_lat + seg.end_lat) * 0.5,
        (seg.start_lon + seg.end_lon) * 0.5,
        seg.start_lat,
        seg.start_lon,
        seg.end_lat,
        seg.end_lon,
    );
    let cp_lat = cp.lat;
    let cp_lon = cp.lon;
    let dx_m = geo::flat_dist(cp_lat, cp_lon, cp_lat, seg.end_lon)
        * if seg.end_lon >= seg.start_lon { 1.0 } else { -1.0 };
    let dy_m = geo::flat_dist(cp_lat, cp_lon, seg.end_lat, cp_lon)
        * if seg.end_lat >= seg.start_lat { 1.0 } else { -1.0 };
    let seg_len_m = (dx_m * dx_m + dy_m * dy_m).sqrt().max(1.0);
    let nx_m = -dy_m / seg_len_m;
    let ny_m = dx_m / seg_len_m;
    let ref_lat = cp_lat + meters_to_lat_deg(ny_m * GROUND_OPS_REF_OFFSET_M);
    let ref_lon = cp_lon + meters_to_lon_deg(cp_lat, nx_m * GROUND_OPS_REF_OFFSET_M);
    ((ref_lat, ref_lon), GROUND_OPS_REF_OFFSET_M, cp.fraction)
}

fn ground_ops_max_radius_m(kind: u8) -> f64 {
    // Sized so a realistic-loudest operation leaves ≤ 20 dB Lden at cutoff
    // (free-field, flat ground) — i.e. below rural-night background.
    match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => crate::constants::GROUND_OPS_RUNWAY_MAX_RADIUS,
        GROUND_OPS_KIND_TAXI => crate::constants::GROUND_OPS_TAXI_MAX_RADIUS,
        GROUND_OPS_KIND_APRON_MOVEMENT => crate::constants::GROUND_OPS_APRON_MAX_RADIUS,
        _ => crate::constants::GROUND_OPS_APRON_MAX_RADIUS,
    }
}

fn template_a_weighted_total(shape: [f64; NUM_BANDS], d_over_1000: f64) -> f64 {
    let c = std::f64::consts::LN_10 * 0.1;
    let energy: f64 = (0..NUM_BANDS)
        .map(|i| (shape[i] - ALPHA_ATM[i] * d_over_1000 + A_WEIGHTING[i]) * c)
        .map(f64::exp)
        .sum();
    10.0 * energy.max(1e-30).log10()
}

fn ground_ops_model(seg: &AircraftSegment, kind: u8) -> GroundOpsModel {
    let kind_idx = ground_ops_kind_index(kind);
    let class_idx = noise_class_of(seg.profile_idx) as usize;
    let mut ref_sel_db = GROUND_OPS_REFERENCE_SEL_DB[class_idx][kind_idx];
    if kind == GROUND_OPS_KIND_RUNWAY_ROLL && seg.is_departure {
        ref_sel_db += GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB;
    }

    let nominal_speed_kt = match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => SURFACE_RUNWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_TAXI => SURFACE_TAXIWAY_SPEED_KT as f64,
        GROUND_OPS_KIND_APRON_MOVEMENT => SURFACE_APRON_SPEED_KT as f64,
        _ => SURFACE_APRON_SPEED_KT as f64,
    };
    if seg.speed_kt > 1.0 {
        let speed_adjust_db = 10.0 * ((seg.speed_kt as f64) / nominal_speed_kt.max(1.0)).log10();
        ref_sel_db += speed_adjust_db.clamp(-GROUND_OPS_SPEED_CLAMP_DB, GROUND_OPS_SPEED_CLAMP_DB);
    }

    let spectrum_shape = match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => GROUND_OPS_RUNWAY_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_TAXI => GROUND_OPS_TAXI_SPECTRUM_SHAPE,
        GROUND_OPS_KIND_APRON_MOVEMENT => GROUND_OPS_APRON_SPECTRUM_SHAPE,
        _ => GROUND_OPS_APRON_SPECTRUM_SHAPE,
    };

    GroundOpsModel {
        ref_sel_db,
        spectrum_shape,
        max_radius_m: ground_ops_max_radius_m(kind),
    }
}

fn ground_ops_kind_index(kind: u8) -> usize {
    match kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => 0,
        GROUND_OPS_KIND_TAXI => 1,
        GROUND_OPS_KIND_APRON_MOVEMENT => 2,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::super::npd::profile_idx;
    use super::super::segment_filters::GROUND_CONTEXT_AIRPORT_LINE;
    use super::*;
    use crate::sources::AIRCRAFT_ADSB_SOURCE_ID;

    #[test]
    fn test_ground_ops_model_uses_kind_specific_reference_sel() {
        let pidx = profile_idx("B738");
        let cls = noise_class_of(pidx) as usize;
        let exp_runway = GROUND_OPS_REFERENCE_SEL_DB[cls][0];
        let exp_taxi = GROUND_OPS_REFERENCE_SEL_DB[cls][1];
        let exp_apron = GROUND_OPS_REFERENCE_SEL_DB[cls][2];

        let mut seg = AircraftSegment {
            flight_id: 1,
            profile_idx: pidx,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 0.0,
            end_lat: 50.005,
            end_lon: 14.0,
            end_alt_m: 0.0,
            speed_kt: SURFACE_RUNWAY_SPEED_KT,
            segment_length_m: 550.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_RUNWAY_ROLL,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };

        let runway_arr = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_arr.ref_sel_db - exp_runway).abs() < 0.01);
        assert_eq!(runway_arr.max_radius_m, 5_000.0);

        seg.is_departure = true;
        let runway_dep = ground_ops_model(&seg, GROUND_OPS_KIND_RUNWAY_ROLL);
        assert!((runway_dep.ref_sel_db - (exp_runway + GROUND_OPS_RUNWAY_DEPARTURE_BONUS_DB)).abs() < 0.01);

        seg.speed_kt = SURFACE_TAXIWAY_SPEED_KT;
        let taxi = ground_ops_model(&seg, GROUND_OPS_KIND_TAXI);
        assert!((taxi.ref_sel_db - exp_taxi).abs() < 0.01);
        assert_eq!(taxi.max_radius_m, 3_000.0);

        seg.speed_kt = SURFACE_APRON_SPEED_KT;
        let apron = ground_ops_model(&seg, GROUND_OPS_KIND_APRON_MOVEMENT);
        assert!((apron.ref_sel_db - exp_apron).abs() < 0.01);
        assert_eq!(apron.max_radius_m, 1_500.0);
    }

    #[test]
    fn test_ground_ops_model_speed_adjust_is_clamped() {
        let fast_seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 6,
            is_departure: false,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 0.0,
            end_lat: 50.002,
            end_lon: 14.0,
            end_alt_m: 0.0,
            speed_kt: 240.0,
            segment_length_m: 220.0,
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_TAXI,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };
        let slow_seg = AircraftSegment {
            speed_kt: 1.5,
            ..fast_seg.clone()
        };

        let fast = ground_ops_model(&fast_seg, GROUND_OPS_KIND_TAXI);
        let slow = ground_ops_model(&slow_seg, GROUND_OPS_KIND_TAXI);

        let cls = noise_class_of(fast_seg.profile_idx) as usize;
        let exp_taxi = GROUND_OPS_REFERENCE_SEL_DB[cls][1];
        assert!((fast.ref_sel_db - (exp_taxi + GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
        assert!((slow.ref_sel_db - (exp_taxi - GROUND_OPS_SPEED_CLAMP_DB)).abs() < 0.01);
    }
}
