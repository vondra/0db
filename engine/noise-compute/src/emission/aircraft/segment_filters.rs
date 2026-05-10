//! Per-segment validity filters and ground-context helpers.
//!
//! These predicates classify each ADS-B segment into one of three buckets:
//! * **Ground** — taxi/runway/apron, near terrain or under airport context.
//! * **Valid airborne** — physically plausible flight (above terrain, sane speed).
//! * **Stale ground** — extractor missed an `on_ground` flag; runtime fallback
//!   rejects via low-AGL test.
//!
//! Both popup and pipeline run these gates before invoking the energy
//! kernel. `SegmentTerrain` caches DEM samples so repeated callers don't
//! double-tap the raster sampler.

use crate::types::{AircraftSegment, RasterSampler};

use super::npd::{is_helicopter_profile, noise_class_of, IS_JET};

/// Runtime fallback for stale prepared ADS-B data that still contains taxi or
/// runway-roll segments. The authoritative fix is extractor-side `on_ground`
/// filtering, but until the full dataset is rebuilt we also reject segments
/// whose both endpoints stay close to local terrain.
pub const GROUND_STALE_MAX_AGL_M: f64 = 15.0;
pub const AIRPORT_GROUND_MAX_AGL_M: f64 = 60.0;
pub const GROUND_CONTEXT_NONE: u8 = 0;
pub const GROUND_CONTEXT_AIRPORT_LINE: u8 = 1;
pub const GROUND_OPS_KIND_NONE: u8 = 0;
pub const GROUND_OPS_KIND_RUNWAY_ROLL: u8 = 1;
pub const GROUND_OPS_KIND_TAXI: u8 = 2;
pub const GROUND_OPS_KIND_APRON_MOVEMENT: u8 = 3;
pub const GROUND_OPS_SOURCE_HEIGHT_M: f64 = 4.0;

pub fn is_ground_ops_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    seg.surface_model || is_airport_ground_segment(seg, rasters)
}

pub fn resolve_ground_ops_kind(seg: &AircraftSegment) -> u8 {
    if seg.ground_ops_kind != GROUND_OPS_KIND_NONE {
        seg.ground_ops_kind
    } else if seg.ground_context != GROUND_CONTEXT_NONE || seg.on_ground || seg.surface_model {
        ground_ops_kind_fallback(seg)
    } else {
        GROUND_OPS_KIND_NONE
    }
}

/// Speed/length-based ops_kind classifier. Used by Stage 2C ground path
/// extraction to assign per-leg `ops_kind` from the leg's observed
/// speed and length:
///
/// * `speed_kt ≥ 40 OR segment_length_m ≥ 500` → `RUNWAY_ROLL`
///   (takeoff acceleration arc has high avg speed OR a long ground
///   stretch even when avg speed is averaged down by an early phase).
/// * `speed_kt ≥ 8` → `TAXI`.
/// * else → `APRON_MOVEMENT` (slow / stationary movements).
///
/// Helicopters never get `RUNWAY_ROLL` — a helicopter accelerating
/// through 40 kt on a helipad is rotor-thrust-driven, not the turbofan
/// T/O profile RUNWAY_ROLL is calibrated for. Cap helicopters at TAXI.
pub fn ground_ops_kind_fallback(seg: &AircraftSegment) -> u8 {
    if is_helicopter_profile(seg.profile_idx) {
        return if seg.speed_kt >= 8.0 {
            GROUND_OPS_KIND_TAXI
        } else {
            GROUND_OPS_KIND_APRON_MOVEMENT
        };
    }
    if seg.speed_kt >= 40.0 || seg.segment_length_m >= 500.0 {
        GROUND_OPS_KIND_RUNWAY_ROLL
    } else if seg.speed_kt >= 8.0 {
        GROUND_OPS_KIND_TAXI
    } else {
        GROUND_OPS_KIND_APRON_MOVEMENT
    }
}

/// Cached terrain elevations sampled at five points along a segment
/// (start, end, midpoint, ¼, ¾). Lets the popup hot loop run
/// `is_ground_stale`, `is_valid_airborne`, and the kernel's Filter D
/// cuts off one batch of `rasters.elevation()` calls instead of nine
/// (start/end appear in all three predicates).
#[derive(Clone, Copy, Debug)]
pub struct SegmentTerrain {
    pub start_elev: f64,
    pub end_elev: f64,
    pub mid_elev: f64,
    pub q1_elev: f64,
    pub q3_elev: f64,
}

impl SegmentTerrain {
    pub fn sample(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> Self {
        let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
        let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
        let q1_lat = seg.start_lat * 0.75 + seg.end_lat * 0.25;
        let q1_lon = seg.start_lon * 0.75 + seg.end_lon * 0.25;
        let q3_lat = seg.start_lat * 0.25 + seg.end_lat * 0.75;
        let q3_lon = seg.start_lon * 0.25 + seg.end_lon * 0.75;
        SegmentTerrain {
            start_elev: rasters.elevation(seg.start_lat, seg.start_lon),
            end_elev: rasters.elevation(seg.end_lat, seg.end_lon),
            mid_elev: rasters.elevation(mid_lat, mid_lon),
            q1_elev: rasters.elevation(q1_lat, q1_lon),
            q3_elev: rasters.elevation(q3_lat, q3_lon),
        }
    }
}

/// Filter obviously-invalid airborne ADS-B segments.
/// Returns false for segments that pipeline AND popup should skip:
/// - Max altitude below terrain - 30m (underground / radar echo)
/// - Jet-like profile (not Turboprop, not LightGA/helicopter) flying < 80 kt (impossible)
/// - Jet-like profile < 150m AGL outside any airport context (radar echo / decode error)
///
/// Used by both pipeline and popup.
pub fn is_valid_airborne_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.on_ground || seg.ground_context != GROUND_CONTEXT_NONE {
        return true;
    }

    let is_fixed_wing_jet = IS_JET[noise_class_of(seg.profile_idx) as usize];

    if is_fixed_wing_jet && (seg.speed_kt as f64) < 80.0 {
        return false;
    }

    let mid_lat = (seg.start_lat + seg.end_lat) * 0.5;
    let mid_lon = (seg.start_lon + seg.end_lon) * 0.5;
    let terrain_mid = rasters.elevation(mid_lat, mid_lon);
    let max_alt = (seg.start_alt_m as f64).max(seg.end_alt_m as f64);

    if max_alt < terrain_mid - 30.0 {
        return false;
    }

    // Endpoint AGL < -30 m handles subsea-level airports (Schiphol -4m, Atyrau
    // -22m, Caspian-basin sites) via DEM-relative terrain rather than global MSL.
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    if start_agl < -30.0 || end_agl < -30.0 {
        return false;
    }

    let sl = seg.start_lat as f64;
    let sn = seg.start_lon as f64;
    let el = seg.end_lat as f64;
    let en = seg.end_lon as f64;
    let sa = seg.start_alt_m as f64;
    let ea = seg.end_alt_m as f64;
    for frac in [0.25_f64, 0.75] {
        let lat = sl + (el - sl) * frac;
        let lon = sn + (en - sn) * frac;
        let alt = sa + (ea - sa) * frac;
        if alt < rasters.elevation(lat, lon) - 30.0 {
            return false;
        }
    }

    if !is_fixed_wing_jet {
        return true;
    }

    // Jet < 150m AGL outside airport: radar echo or altitude decode error.
    if max_alt < terrain_mid + 150.0 {
        return false;
    }

    true
}

pub fn is_ground_stale_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.on_ground {
        return seg.ground_context == GROUND_CONTEXT_NONE;
    }
    if seg.ground_context != GROUND_CONTEXT_NONE {
        return false;
    }
    is_low_agl_segment_raw(seg, rasters)
}

pub fn is_low_agl_segment_raw(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    start_agl <= GROUND_STALE_MAX_AGL_M && end_agl <= GROUND_STALE_MAX_AGL_M
}

/// `is_ground_stale_segment` reading elevations from a `SegmentTerrain` cache.
pub fn is_ground_stale_with_terrain(seg: &AircraftSegment, terrain: &SegmentTerrain) -> bool {
    if seg.on_ground {
        return seg.ground_context == GROUND_CONTEXT_NONE;
    }
    if seg.ground_context != GROUND_CONTEXT_NONE {
        return false;
    }
    let start_agl = seg.start_alt_m as f64 - terrain.start_elev;
    let end_agl = seg.end_alt_m as f64 - terrain.end_elev;
    start_agl <= GROUND_STALE_MAX_AGL_M && end_agl <= GROUND_STALE_MAX_AGL_M
}

/// `is_valid_airborne_segment` reading elevations from a `SegmentTerrain` cache.
pub fn is_valid_airborne_with_terrain(seg: &AircraftSegment, terrain: &SegmentTerrain) -> bool {
    if seg.on_ground || seg.ground_context != GROUND_CONTEXT_NONE {
        return true;
    }
    let is_fixed_wing_jet = IS_JET[noise_class_of(seg.profile_idx) as usize];
    if is_fixed_wing_jet && (seg.speed_kt as f64) < 80.0 {
        return false;
    }
    let max_alt = (seg.start_alt_m as f64).max(seg.end_alt_m as f64);
    if max_alt < terrain.mid_elev - 30.0 {
        return false;
    }
    let start_agl = seg.start_alt_m as f64 - terrain.start_elev;
    let end_agl = seg.end_alt_m as f64 - terrain.end_elev;
    if start_agl < -30.0 || end_agl < -30.0 {
        return false;
    }
    let sa = seg.start_alt_m as f64;
    let ea = seg.end_alt_m as f64;
    let q1_alt = sa * 0.75 + ea * 0.25;
    let q3_alt = sa * 0.25 + ea * 0.75;
    if q1_alt < terrain.q1_elev - 30.0 || q3_alt < terrain.q3_elev - 30.0 {
        return false;
    }
    if !is_fixed_wing_jet {
        return true;
    }
    max_alt >= terrain.mid_elev + 150.0
}

pub fn is_airport_ground_segment(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> bool {
    if seg.ground_context == GROUND_CONTEXT_NONE {
        return false;
    }
    if seg.on_ground {
        return true;
    }
    let (start_agl, end_agl) = segment_agl(seg, rasters);
    start_agl <= AIRPORT_GROUND_MAX_AGL_M && end_agl <= AIRPORT_GROUND_MAX_AGL_M
}

fn segment_agl(seg: &AircraftSegment, rasters: &dyn RasterSampler) -> (f64, f64) {
    let start_agl = seg.start_alt_m as f64 - rasters.elevation(seg.start_lat, seg.start_lon);
    let end_agl = seg.end_alt_m as f64 - rasters.elevation(seg.end_lat, seg.end_lon);
    (start_agl, end_agl)
}

/// Meters → degrees of latitude (constant ≈ 110 540 m / deg, valid to
/// within ~0.6 % anywhere on Earth). Use for any latitude bounding box
/// where the exact geodesic isn't worth the cost.
pub fn meters_to_lat_deg(meters: f64) -> f64 {
    meters / 110_540.0
}

/// Meters → degrees of longitude at a given latitude. Includes a
/// `cos.max(0.2)` clamp that bounds the conversion factor at ~78°
/// latitude — above that the cosine collapses and the bbox would
/// over-fetch enormously. Aircraft cruise tracks live well below that
/// limit, so the clamp is a safety net rather than a routine concern.
pub fn meters_to_lon_deg(lat: f64, meters: f64) -> f64 {
    let cos_lat = lat.to_radians().cos().abs().max(0.2);
    meters / (111_320.0 * cos_lat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::AIRCRAFT_ADSB_SOURCE_ID;

    struct FlatGround;

    impl RasterSampler for FlatGround {
        fn elevation(&self, _lat: f64, _lon: f64) -> f64 {
            250.0
        }
        fn building_height(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
        fn building_enclosure(&self, _lat: f64, _lon: f64) -> f64 {
            0.0
        }
    }

    #[test]
    fn test_ground_stale_segment_filter() {
        let seg = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 252.0,
            end_lat: 50.001,
            end_lon: 14.001,
            end_alt_m: 259.0,
            speed_kt: 35.0,
            segment_length_m: 300.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };
        assert!(is_ground_stale_segment(&seg, &FlatGround));

        let airborne = AircraftSegment {
            start_alt_m: 320.0,
            end_alt_m: 340.0,
            ..seg
        };
        assert!(!is_ground_stale_segment(&airborne, &FlatGround));
    }

    #[test]
    fn test_airport_ground_segment_detection() {
        let off_airport = AircraftSegment {
            flight_id: 1,
            profile_idx: 7,
            is_departure: false,
            on_ground: false,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 252.0,
            end_lat: 50.0008,
            end_lon: 14.0,
            end_alt_m: 255.0,
            speed_kt: 35.0,
            segment_length_m: 90.0,
            ground_context: GROUND_CONTEXT_NONE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };
        assert!(!is_airport_ground_segment(&off_airport, &FlatGround));

        let airport_ground = AircraftSegment {
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ..off_airport
        };
        assert!(is_airport_ground_segment(&airport_ground, &FlatGround));
    }

    /// A helicopter accelerating through 40 kt on a helipad must be
    /// classified as TAXI, not RUNWAY_ROLL. The latter SEL is calibrated
    /// for turbofan T/O thrust which is absent on rotor aircraft.
    #[test]
    fn helicopter_never_runway_roll() {
        // EC35 (Eurocopter EC135) — first helicopter typecode in the
        // profile array. Class HELICOPTER, anchor for all 21 heli types.
        let heli_profile_idx = crate::emission::aircraft::profile_idx("EC35");

        let fast_seg = AircraftSegment {
            flight_id: 1,
            profile_idx: heli_profile_idx,
            is_departure: true,
            on_ground: true,
            period: 0,
            date_id: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            start_alt_m: 252.0,
            end_lat: 50.001,
            end_lon: 14.001,
            end_alt_m: 252.0,
            speed_kt: 60.0,             // would trigger RUNWAY_ROLL for fixed-wing
            segment_length_m: 800.0,    // ditto
            ground_context: GROUND_CONTEXT_AIRPORT_LINE,
            ground_ops_kind: GROUND_OPS_KIND_NONE,
            count_weight: 1.0,
            surface_model: false,
            source_id: AIRCRAFT_ADSB_SOURCE_ID,
            cruise_flight_ids: Vec::new(),
        };
        assert_eq!(ground_ops_kind_fallback(&fast_seg), GROUND_OPS_KIND_TAXI);

        let slow_seg = AircraftSegment {
            speed_kt: 3.0,
            segment_length_m: 50.0,
            ..fast_seg.clone()
        };
        assert_eq!(ground_ops_kind_fallback(&slow_seg), GROUND_OPS_KIND_APRON_MOVEMENT);

        // Sanity: a non-helicopter (B738) at the same fast settings still
        // hits RUNWAY_ROLL. Confirms the gate is helicopter-specific.
        let jet_profile_idx = crate::emission::aircraft::profile_idx("B738");
        let jet_seg = AircraftSegment {
            profile_idx: jet_profile_idx,
            ..fast_seg
        };
        assert_eq!(ground_ops_kind_fallback(&jet_seg), GROUND_OPS_KIND_RUNWAY_ROLL);
    }
}
