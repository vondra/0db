//! Stage 1 — flights → segments. Per flight we sample DEM AGL,
//! truncate the bogus tail with [`crate::filters::validate_flight_trajectory`],
//! infer composite ground flags, classify phase, then build segments.
//!
//! Output: `segments/<day>.arrow` (one row per surviving segment).

use std::path::Path;

use anyhow::{Context, Result};
use rayon::prelude::*;

use crate::arrow_io::{read_record_batches, write_segments};
use crate::classify::{self, ClassifyInput};
use crate::filters;
use crate::flight::{typecode_bytes, Flight, FlightSegment};
use crate::ground_inference::ground_flags;
use crate::period::parse_date_id;
use crate::segment::{build_segments, SegmentMeta};
use crate::trace::TracePoint;
use noise_compute::types::RasterSampler;
use raster_reader::RealRasters;

/// Run Stage 1 for one day. Reads `input_dir/<day>.arrow`, writes
/// `output_dir/<day>.arrow`. Caller owns `rasters` so multi-day
/// orchestration can share one tile cache across days.
pub fn run_stage_1(
    input_dir: &Path,
    output_dir: &Path,
    day_str: &str,
    rasters: &RealRasters,
) -> Result<usize> {
    let in_path = input_dir.join(format!("{day_str}.arrow"));
    let flights = read_flights(&in_path)
        .with_context(|| format!("read flights {}", in_path.display()))?;
    let date_id = parse_date_id(day_str);

    // Pre-load DEM tiles covering the flight bbox so per-point lookups
    // are lock-free during rayon par_iter.
    if let Some(bbox) = bbox_of_flights(&flights) {
        rasters.dem.preload_bbox(bbox.0, bbox.1, bbox.2, bbox.3);
    }

    // Heavy work: per-flight AGL + truncate + ground + classify + segments.
    let segments: Vec<FlightSegment> = flights
        .par_iter()
        .flat_map_iter(|f| stage_1_one_flight(f, &rasters, date_id).into_iter())
        .collect();

    let out_path = output_dir.join(format!("{day_str}.arrow"));
    write_segments(&out_path, &segments)?;
    Ok(segments.len())
}

fn stage_1_one_flight(
    flight: &Flight,
    rasters: &RealRasters,
    date_id: i16,
) -> Vec<FlightSegment> {
    if flight.points.len() < 2 {
        return Vec::new();
    }

    let mut points = flight.points.clone();
    // Ground-flagged points pin AGL = 0 (and skip the DEM lookup); without
    // this, `validate_flight_trajectory` would read `0 - elev` for any
    // landing roll above ~300 m AMSL and truncate the whole tail.
    let mut agl_m: Vec<f32> = Vec::with_capacity(points.len());
    for p in &points {
        match p.airborne_alt_ft() {
            None => agl_m.push(0.0),
            Some(alt_ft) => {
                let elev = rasters.elevation(p.lat as f64, p.lon as f64) as f32;
                agl_m.push(alt_ft * 0.3048 - elev);
            }
        }
    }

    filters::validate_flight_trajectory(&mut points, &mut agl_m);
    if points.len() < 2 {
        return Vec::new();
    }

    let g_flags = ground_flags(&points, &agl_m);
    let phases = classify::classify_points(ClassifyInput {
        on_ground: &g_flags,
        agl_m: &agl_m,
    });

    let meta = SegmentMeta {
        flight_id: flight.flight_id,
        callsign: &flight.callsign,
        aircraft_type: typecode_bytes(&flight.aircraft_type),
        profile_idx: flight.profile_idx,
        source_id: flight.source_id,
        origin: flight.origin,
        veh_kind: flight.veh_kind,
        gse_class: flight.gse_class,
        date_id,
    };
    build_segments(&points, &agl_m, &phases, &meta)
}

fn bbox_of_flights(flights: &[Flight]) -> Option<(f64, f64, f64, f64)> {
    let mut min_lat = f64::MAX;
    let mut max_lat = f64::MIN;
    let mut min_lon = f64::MAX;
    let mut max_lon = f64::MIN;
    let mut any = false;
    for f in flights {
        for p in &f.points {
            min_lat = min_lat.min(p.lat as f64);
            max_lat = max_lat.max(p.lat as f64);
            min_lon = min_lon.min(p.lon as f64);
            max_lon = max_lon.max(p.lon as f64);
            any = true;
        }
    }
    if !any {
        return None;
    }
    Some((min_lat, max_lat, min_lon, max_lon))
}

/// Read a Stage 0 flights file back into [`Flight`] structs. Matches the
/// schema produced by [`crate::stage_0::write_flights_at`].
pub fn read_flights(path: &Path) -> Result<Vec<Flight>> {
    use arrow::array::{
        Array, FixedSizeBinaryArray, Float32Array, Float64Array, ListArray, StringArray,
        StructArray, UInt64Array, UInt8Array,
    };

    let (_, batches) = read_record_batches(path)?;
    let mut out = Vec::new();
    for b in batches {
        let flight_id = b.column_by_name("flight_id").unwrap().as_any().downcast_ref::<UInt64Array>().unwrap();
        let callsign = b.column_by_name("callsign").unwrap().as_any().downcast_ref::<StringArray>().unwrap();
        let atype = b.column_by_name("aircraft_type").unwrap().as_any().downcast_ref::<FixedSizeBinaryArray>().unwrap();
        let prof = b.column_by_name("profile_idx").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let src = b.column_by_name("source_id").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let orig = b.column_by_name("origin").unwrap().as_any().downcast_ref::<UInt8Array>().unwrap();
        let base_ts = b.column_by_name("base_timestamp").unwrap().as_any().downcast_ref::<Float64Array>().unwrap();
        let pts_list = b.column_by_name("points").unwrap().as_any().downcast_ref::<ListArray>().unwrap();
        let pts_struct = pts_list.values().as_any().downcast_ref::<StructArray>().unwrap();
        let pt_ts = pts_struct.column(0).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_lat = pts_struct.column(1).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_lon = pts_struct.column(2).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_alt = pts_struct.column(3).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_speed = pts_struct.column(4).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_track = pts_struct.column(5).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_baro = pts_struct.column(6).as_any().downcast_ref::<Float32Array>().unwrap();
        let pt_flags = pts_struct.column(7).as_any().downcast_ref::<UInt8Array>().unwrap();
        let offsets = pts_list.value_offsets();

        for i in 0..b.num_rows() {
            let lo = offsets[i] as usize;
            let hi = offsets[i + 1] as usize;
            let mut points = Vec::with_capacity(hi - lo);
            let base = base_ts.value(i);
            for j in lo..hi {
                points.push(TracePoint {
                    timestamp: base + pt_ts.value(j) as f64,
                    lat: pt_lat.value(j),
                    lon: pt_lon.value(j),
                    alt_ft: pt_alt.value(j),
                    speed_kt: pt_speed.value(j),
                    track_deg: pt_track.value(j),
                    baro_rate_fpm: pt_baro.value(j),
                    flags: pt_flags.value(j),
                });
            }
            let bytes = atype.value(i);
            let aircraft_type = std::str::from_utf8(bytes)
                .unwrap_or("")
                .trim_end_matches(char::from(0))
                .to_string();
            out.push(Flight {
                flight_id: flight_id.value(i),
                callsign: callsign.value(i).to_string(),
                aircraft_type,
                profile_idx: prof.value(i),
                source_id: src.value(i),
                origin: orig.value(i),
                veh_kind: 0,
                gse_class: 0,
                points,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::FlightSource;
    use crate::source_adsb_tar::AdsbTarSource;
    use tempfile::tempdir;

    #[test]
    fn end_to_end_one_day_against_real_dem() {
        let cache = "/0db.app/v4.0-wt2/data/source/flights-cache/radius/praha-150km";
        let prepared = "/0db.app/v4.0-wt2/data/prepared";
        if !std::path::Path::new(cache).exists() || !std::path::Path::new(prepared).exists() {
            return;
        }

        let work = tempdir().unwrap();
        let stage0_dir = work.path().join("flights");
        let stage1_dir = work.path().join("segments");
        std::fs::create_dir_all(&stage0_dir).unwrap();
        std::fs::create_dir_all(&stage1_dir).unwrap();

        let sources: Vec<Box<dyn FlightSource>> =
            vec![Box::new(AdsbTarSource::new(cache))];
        crate::stage_0::run_stage_0(&sources, "2025-01-21", &stage0_dir).unwrap();

        let rasters = RealRasters::new(std::path::Path::new(prepared));
        let n = run_stage_1(
            &stage0_dir,
            &stage1_dir,
            "2025-01-21",
            &rasters,
        )
        .unwrap();
        assert!(n > 1000, "got only {n} segments");
        let path = stage1_dir.join("2025-01-21.arrow");
        assert!(path.exists());
    }
}
