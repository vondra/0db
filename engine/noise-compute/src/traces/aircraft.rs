//! Per-row trace builders for the three aircraft sub-types.
//!
//! `SegmentTrace` covers ground / airborne / cruise via the
//! `aircraft_subtype` discriminator (1 = ground path, 2 = airborne
//! sub-segment, 3 = cruise R8 hex). Each builder pulls values the
//! engine already holds — no re-emission or re-propagation happens
//! here, only field shaping.

use crate::emission::aircraft::typecode_to_string;
use crate::propagation::iso9613;
use crate::types::{
    CruiseBucketBreakdown, EmissionTrace, LayerKind, LdenVariants, PathProfileTrace, PerPeriod,
    PropagationVariants, ScreeningTrace, SegmentTrace, TerrainTrace, VegetationTrace, NUM_BANDS,
};

use super::{
    baseline_trace, empty_path_profile, empty_screening_trace, empty_terrain_trace,
    empty_vegetation_trace, ground_trace, point_source_aloft_baseline, variants_to_lden,
    variants_to_received_bands,
};

/// Inputs for a ground-path trace.
pub struct BuildAircraftGroundPathTrace<'a> {
    pub aircraft_type: &'a [u8; 4],
    pub airport_key: &'a str,
    pub polyline: Vec<(f64, f64)>,
    pub length_m_per_kind: [f32; 3],
    pub closest_dist_m: f64,
    pub closest_d_slant_m: f64,
    pub closest_cp_lat: f64,
    pub closest_cp_lon: f64,
    pub closest_src_height_m: f64,
    pub closest_ground_g: f64,
    pub finite_line_corr_db: f64,
    pub reflection_boost_db: f64,
    pub variants: [PropagationVariants; 3],
    pub terrain: TerrainTrace,
    pub screening: ScreeningTrace,
    pub vegetation: VegetationTrace,
    pub path_profile: PathProfileTrace,
}

pub fn build_aircraft_ground_path_trace(
    inputs: BuildAircraftGroundPathTrace<'_>,
) -> SegmentTrace {
    let BuildAircraftGroundPathTrace {
        aircraft_type,
        airport_key,
        polyline,
        length_m_per_kind,
        closest_dist_m,
        closest_d_slant_m,
        closest_cp_lat,
        closest_cp_lon,
        closest_src_height_m,
        closest_ground_g,
        finite_line_corr_db,
        reflection_boost_db,
        variants,
        terrain,
        screening,
        vegetation,
        path_profile,
    } = inputs;

    let total_length_m = (length_m_per_kind[0] + length_m_per_kind[1] + length_m_per_kind[2]) as f64;
    let start = *polyline
        .first()
        .expect("ground path polyline non-empty: caller filters empty paths");
    let end = *polyline
        .last()
        .expect("ground path polyline non-empty: caller filters empty paths");

    SegmentTrace {
        kind: LayerKind::Aircraft,
        osm_id: None,
        segment_idx: 0,
        name: if airport_key.is_empty() {
            let typecode_str = typecode_to_string(aircraft_type);
            format!("Aircraft ground path {typecode_str}")
        } else {
            format!("Aircraft - {airport_key} ground")
        },
        subtype: "ground_ops".to_string(),
        is_dominant_of_group: false,
        start_lat: start.0,
        start_lon: start.1,
        end_lat: end.0,
        end_lon: end.1,
        cp_lat: closest_cp_lat,
        cp_lon: closest_cp_lon,
        length_m: total_length_m,
        dist_m: closest_dist_m,
        d_slant_m: closest_d_slant_m,
        bridge: false,
        tunnel: false,
        emission: EmissionTrace::AircraftGround {
            class: kind_label_from_lengths(length_m_per_kind),
            observed_movements: 1.0,
            modeled_movements: 0.0,
        },
        lw_bands: PerPeriod {
            day: [0.0; NUM_BANDS],
            evening: [0.0; NUM_BANDS],
            night: [0.0; NUM_BANDS],
        },
        lw_db_a: PerPeriod {
            day: 0.0,
            evening: 0.0,
            night: 0.0,
        },
        baseline: baseline_trace(
            closest_d_slant_m,
            closest_src_height_m,
            closest_ground_g,
            finite_line_corr_db,
            reflection_boost_db,
            iso9613::SourceGeometry::Line,
        ),
        path_profile,
        terrain,
        screening,
        vegetation,
        ground: ground_trace(closest_ground_g),
        received_bands: variants_to_received_bands(&variants),
        received_lden: variants_to_lden(&variants),
        aircraft_subtype: 1,
        polyline: Some(polyline),
        hex_polygon: None,
        cruise_buckets: None,
        length_m_per_kind: Some(length_m_per_kind),
    }
}

/// Pick a label from the per-kind length distribution. The longest
/// kind wins — a path with 70 % runway and 20 % taxi reads as
/// "runway" in the popup row label.
fn kind_label_from_lengths(lengths: [f32; 3]) -> &'static str {
    let mut best_idx = 0;
    let mut best_val = lengths[0];
    for (i, v) in lengths.iter().enumerate().skip(1) {
        if *v > best_val {
            best_val = *v;
            best_idx = i;
        }
    }
    match best_idx {
        0 => "runway",
        1 => "taxi",
        _ => "apron",
    }
}

/// Inputs for an airborne sub-segment trace.
pub struct BuildAircraftAirborneSubSegmentTrace<'a> {
    pub callsign: &'a str,
    pub aircraft_type: &'a [u8; 4],
    pub class_name: &'static str,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub cpa_distance_m: f64,
    pub altitude_m_at_cpa: f64,
    pub d_slant_m: f64,
    pub received_lden: f64,
}

pub fn build_aircraft_airborne_subsegment_trace(
    inputs: BuildAircraftAirborneSubSegmentTrace<'_>,
) -> SegmentTrace {
    let typecode_str = typecode_to_string(inputs.aircraft_type);
    SegmentTrace {
        kind: LayerKind::Aircraft,
        osm_id: None,
        segment_idx: 0,
        name: if inputs.callsign.is_empty() {
            typecode_str.clone()
        } else {
            format!("{} ({typecode_str})", inputs.callsign)
        },
        subtype: "airborne".to_string(),
        is_dominant_of_group: false,
        start_lat: inputs.start_lat,
        start_lon: inputs.start_lon,
        end_lat: inputs.end_lat,
        end_lon: inputs.end_lon,
        cp_lat: 0.5 * (inputs.start_lat + inputs.end_lat),
        cp_lon: 0.5 * (inputs.start_lon + inputs.end_lon),
        length_m: 0.0,
        dist_m: inputs.cpa_distance_m,
        d_slant_m: inputs.d_slant_m,
        bridge: false,
        tunnel: false,
        emission: EmissionTrace::AircraftAirborne {
            class: inputs.class_name,
            callsign: inputs.callsign.to_string(),
            aircraft_type: typecode_str,
            cpa_distance_m: inputs.cpa_distance_m,
            altitude_m_at_cpa: inputs.altitude_m_at_cpa,
        },
        lw_bands: PerPeriod {
            day: [0.0; NUM_BANDS],
            evening: [0.0; NUM_BANDS],
            night: [0.0; NUM_BANDS],
        },
        lw_db_a: PerPeriod {
            day: 0.0,
            evening: 0.0,
            night: 0.0,
        },
        baseline: point_source_aloft_baseline(inputs.d_slant_m, inputs.altitude_m_at_cpa),
        path_profile: empty_path_profile(),
        terrain: empty_terrain_trace(),
        screening: empty_screening_trace(),
        vegetation: empty_vegetation_trace(),
        ground: ground_trace(0.0),
        received_bands: PerPeriod::silent_bands(),
        received_lden: LdenVariants::uniform(inputs.received_lden),
        aircraft_subtype: 2,
        polyline: None,
        hex_polygon: None,
        cruise_buckets: None,
        length_m_per_kind: None,
    }
}

/// Inputs for a cruise R8 hex aggregate trace.
pub struct BuildAircraftCruiseR8Trace {
    pub r8_hex: u64,
    pub n_unique_flights: u32,
    pub rep_alt_m: f32,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub d_slant_m: f64,
    pub received_lden: f64,
    pub cruise_buckets: Vec<CruiseBucketBreakdown>,
}

pub fn build_aircraft_cruise_r8_trace(inputs: BuildAircraftCruiseR8Trace) -> SegmentTrace {
    let r8_str = format!("{:015x}", inputs.r8_hex);
    let hex_polygon = h3_cell_boundary(inputs.r8_hex);

    SegmentTrace {
        kind: LayerKind::Aircraft,
        osm_id: None,
        segment_idx: 0,
        name: format!("Cruise R8 {r8_str}"),
        subtype: "cruise".to_string(),
        is_dominant_of_group: false,
        start_lat: inputs.centroid_lat,
        start_lon: inputs.centroid_lon,
        end_lat: inputs.centroid_lat,
        end_lon: inputs.centroid_lon,
        cp_lat: inputs.centroid_lat,
        cp_lon: inputs.centroid_lon,
        length_m: 0.0,
        dist_m: 0.0,
        d_slant_m: inputs.d_slant_m,
        bridge: false,
        tunnel: false,
        emission: EmissionTrace::AircraftCruise {
            r8_hex: r8_str,
            n_unique_flights: inputs.n_unique_flights,
            rep_alt_m: inputs.rep_alt_m,
        },
        lw_bands: PerPeriod {
            day: [0.0; NUM_BANDS],
            evening: [0.0; NUM_BANDS],
            night: [0.0; NUM_BANDS],
        },
        lw_db_a: PerPeriod {
            day: 0.0,
            evening: 0.0,
            night: 0.0,
        },
        baseline: point_source_aloft_baseline(inputs.d_slant_m, inputs.rep_alt_m as f64),
        path_profile: empty_path_profile(),
        terrain: empty_terrain_trace(),
        screening: empty_screening_trace(),
        vegetation: empty_vegetation_trace(),
        ground: ground_trace(0.0),
        received_bands: PerPeriod::silent_bands(),
        received_lden: LdenVariants::uniform(inputs.received_lden),
        aircraft_subtype: 3,
        polyline: None,
        hex_polygon: Some(hex_polygon),
        cruise_buckets: Some(inputs.cruise_buckets),
        length_m_per_kind: None,
    }
}

/// Boundary lat/lon of an H3 res-8 cell. Last vertex equals the
/// first to close the GeoJSON ring (W6).
fn h3_cell_boundary(r8_hex: u64) -> Vec<(f64, f64)> {
    use h3o::CellIndex;
    let Ok(cell) = CellIndex::try_from(r8_hex) else {
        return Vec::new();
    };
    let boundary = cell.boundary();
    let mut ring: Vec<(f64, f64)> = boundary.iter().map(|ll| (ll.lat(), ll.lng())).collect();
    if let Some(first) = ring.first().copied() {
        ring.push(first);
    }
    ring
}
