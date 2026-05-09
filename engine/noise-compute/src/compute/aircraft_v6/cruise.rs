//! Convert `CruiseRowView`s into `AircraftSegment`s the existing
//! airborne kernel can ingest. Each cruise R8 bucket becomes a single
//! `AircraftSegment` whose `count_weight = sum_length_m / rep_len_m`
//! captures the bucket's per-day flight density, and whose
//! `cruise_flight_ids` carries the real fids the popup uses for
//! identity dedup across R8 cells.

use h3o::{CellIndex, LatLng};

use crate::compute::aircraft_v6::views::CruiseRowView;
use crate::flight_id::pack_synth;
use crate::types::AircraftSegment;

/// Slant floor (m) — clamps the receiver-overhead degenerate case to
/// avoid `1 / d²` blowing up when the cruise representative point sits
/// directly above the receiver. 5 m matches Doc 29 §A.2 minimum
/// non-zero CPA.
pub const SLANT_FLOOR_M: f64 = 5.0;

/// Expand cruise rows into one `AircraftSegment` per row. The synth
/// segment is drawn through the R8 cell centre at `rep_alt_m`
/// altitude and `rep_len_m` length along the cell-side bearing.
pub fn expand(rows: &[CruiseRowView<'_>]) -> Vec<AircraftSegment> {
    let mut out = Vec::with_capacity(rows.len());
    for (idx, row) in rows.iter().enumerate() {
        let Some((lat, lon)) = r8_cell_center(row.r8_hex) else {
            continue;
        };
        let half_len_m = (row.rep_len_m as f64 * 0.5).max(SLANT_FLOOR_M);
        let lat_off = half_len_m / crate::constants::M_PER_DEG_LAT;
        let lon_off = half_len_m / crate::constants::m_per_deg_lon(lat.to_radians());
        // Density-multiplied count weight: a bucket carrying
        // `sum_length_m` of track over R8 represents
        // `sum_length / rep_len` flights through this cell during the
        // extraction window. `compute_aircraft` multiplies the
        // segment energy by `count_weight` after the per-flight loop.
        let density = if row.rep_len_m > 0.0 {
            (row.sum_length_m / row.rep_len_m).max(1.0)
        } else {
            1.0
        };
        out.push(AircraftSegment {
            flight_id: pack_synth(idx as u64),
            profile_idx: row.rep_profile_idx,
            is_departure: false,
            on_ground: false,
            period: row.period,
            date_id: 0,
            start_lat: lat - lat_off,
            start_lon: lon - lon_off,
            start_alt_m: row.rep_alt_m,
            end_lat: lat + lat_off,
            end_lon: lon + lon_off,
            end_alt_m: row.rep_alt_m,
            speed_kt: row.rep_speed_kt,
            segment_length_m: row.rep_len_m.max(SLANT_FLOOR_M as f32),
            count_weight: density,
            surface_model: false,
            ground_context: 0,
            ground_ops_kind: 0,
            source_id: row.source_id as u16,
            cruise_flight_ids: row.cruise_flight_ids.to_vec(),
        });
    }
    out
}

fn r8_cell_center(r8_hex: u64) -> Option<(f64, f64)> {
    let cell = CellIndex::try_from(r8_hex).ok()?;
    let ll: LatLng = cell.into();
    Some((ll.lat(), ll.lng()))
}
