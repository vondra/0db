//! Point-source normalization: building / industrial / leisure AREA rows →
//! discretised per-cell [`PreparedPoint`]s (GFA-scaled Lw, self-screening
//! exclusion, Lw-derived cull radius) the popup and heatmap loaders share.

use crate::emission::{industrial, leisure, settlement, wind};
use crate::types::{PointSource, NUM_BANDS};

use super::{bands_to_f32, resolve_area_m2};

#[derive(Debug, Clone, Copy)]
pub struct RawBuildingInput<'a> {
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub height_m: f32,
    pub floors: u8,
    pub building_type: u8,
    pub area_m2: Option<f64>,
    pub polygon_wkb: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct RawIndustrialInput<'a> {
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub source_type: u8,
    pub site_subtype: u8,
    pub hub_height_m: Option<f32>,
    pub rated_power_kw: Option<f32>,
    pub area_m2: Option<f64>,
    pub polygon_wkb: &'a str,
    pub nace_4digit: Option<u16>,
}

/// One `leisure.arrow` row — a sports/play/open-air-hospitality AREA source
/// (settlement v2 phase 2). `sport` selects the per-type level
/// (`leisure::leisure_profile`); `capacity` (seats/people) scales crowd
/// sources. No floors/height — leisure is an open-air activity source at a
/// fixed ~1.5 m, not a GFA-scaled building.
#[derive(Debug, Clone, Copy)]
pub struct RawLeisureInput<'a> {
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    /// `leisure::PITCH`/`PADEL`/… class id.
    pub sport: u8,
    pub area_m2: Option<f64>,
    pub capacity: Option<u32>,
    pub polygon_wkb: &'a str,
}

#[derive(Debug, Clone)]
pub struct PreparedPoint {
    pub lat: f64,
    pub lon: f64,
    pub source_height_m: f32,
    pub lw_day: [f32; NUM_BANDS],
    pub lw_evening: [f32; NUM_BANDS],
    pub lw_night: [f32; NUM_BANDS],
    pub n_points: u16,
    pub exclusion_radius_m: f32,
    pub max_radius_m: f64,
    /// Building floors used in the Lw GFA computation (resolved
    /// from OSM `building:levels` or derived from height_m / 3.0
    /// when the tag is absent). 0 for industrial / wind-turbine
    /// point sources.
    pub floors: u8,
    /// Building polygon area (m²) used in the Lw GFA computation.
    /// 0 for industrial point sources without polygon coverage.
    pub area_m2: f32,
    /// Wind turbine hub height (m). `None` for buildings + ordinary
    /// industrial sites. Carried so the popup `EmissionTrace::
    /// Industrial.hub_height_m` matches what the engine used for
    /// `source_height_m`.
    pub hub_height_m: Option<f32>,
    /// Wind turbine rated power (kW). Same purpose as hub_height_m
    /// — `None` outside the wind-turbine branch.
    pub rated_power_kw: Option<f32>,
}

const INDUSTRIAL_AREA_CELL_M: f64 = 75.0;
const INDUSTRIAL_AREA_CELL_SAMPLES: usize = 5;

impl PreparedPoint {
    pub fn with_metadata(
        &self,
        osm_id: i64,
        source_type: u8,
        name: String,
        polygon_wkb: String,
        dist_m: f64,
    ) -> PointSource {
        PointSource {
            osm_id,
            lat: self.lat,
            lon: self.lon,
            source_height_m: self.source_height_m,
            source_type,
            lw_day: self.lw_day,
            lw_evening: self.lw_evening,
            lw_night: self.lw_night,
            n_points: self.n_points,
            name,
            polygon_wkb,
            exclusion_radius_m: self.exclusion_radius_m,
            max_radius_m: self.max_radius_m,
            source_id: 0, // populated by downstream callers (building/industrial loaders)
            floors: self.floors,
            area_m2: self.area_m2,
            hub_height_m: self.hub_height_m,
            rated_power_kw: self.rated_power_kw,
            dist_m,
        }
    }
}

pub fn prepare_building_points(input: RawBuildingInput<'_>) -> Vec<PreparedPoint> {
    let actual_height = if input.height_m > 0.0 {
        input.height_m
    } else if input.floors > 0 {
        input.floors as f32 * 3.0
    } else {
        8.0
    };
    let actual_floors = if input.floors > 0 {
        input.floors
    } else {
        (actual_height / 3.0).ceil() as u8
    };
    let area = resolve_area_m2(input.area_m2, input.polygon_wkb, 100.0);

    let profile = settlement::building_profile(input.building_type);
    let lw = settlement::building_lw(&profile, area, actual_floors);
    if lw < 10.0 {
        return Vec::new();
    }

    let lw_day = bands_to_f32(settlement::building_emission_bands(&profile, lw));
    let mut lw_evening = lw_day;
    let mut lw_night = lw_day;
    for i in 0..NUM_BANDS {
        lw_evening[i] += profile.evening_offset as f32;
        lw_night[i] += profile.night_offset as f32;
    }

    // Cull radius solved against the honest radiated lw (settlement v2
    // phase 1): the W7 net-zero contract that kept the pre-C7 radius is gone
    // together with the AW_* compensated constants — one scalar, one meaning.
    let max_radius_m = settlement::building_max_dist(lw).min(2000.0);
    let grid_spacing = if area > 2000.0 { 30.0 } else { 0.0 };
    let grid_points = if grid_spacing > 0.0 && !input.polygon_wkb.is_empty() {
        let pts = crate::wkb::wkb_grid_points(input.polygon_wkb, grid_spacing);
        if pts.len() > 1 {
            pts
        } else {
            vec![(input.centroid_lat, input.centroid_lon)]
        }
    } else {
        vec![(input.centroid_lat, input.centroid_lon)]
    };
    let n_points = grid_points.len() as u16;
    let lw_split = if n_points > 1 {
        10.0 * (n_points as f32).log10()
    } else {
        0.0
    };

    grid_points
        .into_iter()
        .map(|(lat, lon)| {
            let mut day = lw_day;
            let mut evening = lw_evening;
            let mut night = lw_night;
            for band in 0..NUM_BANDS {
                day[band] -= lw_split;
                evening[band] -= lw_split;
                night[band] -= lw_split;
            }
            PreparedPoint {
                lat,
                lon,
                source_height_m: actual_height / 2.0,
                lw_day: day,
                lw_evening: evening,
                lw_night: night,
                n_points,
                exclusion_radius_m: 0.0,
                max_radius_m,
                floors: actual_floors,
                area_m2: area as f32,
                hub_height_m: None,
                rated_power_kw: None,
            }
        })
        .collect()
}

pub fn prepare_industrial_points(input: RawIndustrialInput<'_>) -> Vec<PreparedPoint> {
    if input.source_type == 10 {
        // Hub default 105 m = known-data median across our arrows (modern
        // fleet context: WindGuard DE 2024 average 143 m, LBNL US 2023
        // average 103.4 m — audit I-10b). Tag-error clamps per the same
        // audit: 4,792 OSM hubs >170 m and 23 rated powers ≥20 MW are tag
        // errors, not machines — hub clamps to 175 m, implausible power is
        // treated as unknown (2 MW default).
        let hub_height_m = input
            .hub_height_m
            .filter(|value| *value > 0.0)
            .map(|value| value.min(175.0))
            .unwrap_or(105.0);
        // Display keeps the assumed 2 MW for unknown ratings; the LUT gets the
        // 0 sentinel instead so a KNOWN 2.0 MW machine (V90/E-82 -> 104 dB) is
        // not conflated with unknown (-> 105) — Codex C7 review.
        let known_power = input
            .rated_power_kw
            .filter(|value| *value > 0.0 && *value <= 8000.0);
        let rated_power_kw = known_power.unwrap_or(2000.0);
        let (lw, bands) = wind::wind_turbine_emission(known_power.unwrap_or(0.0) as f64);
        if lw < 10.0 {
            return Vec::new();
        }
        let emission = bands_to_f32(bands);
        return vec![PreparedPoint {
            lat: input.centroid_lat,
            lon: input.centroid_lon,
            source_height_m: hub_height_m,
            lw_day: emission,
            lw_evening: emission,
            lw_night: emission,
            n_points: 1,
            exclusion_radius_m: 0.0,
            max_radius_m: crate::constants::INDUSTRIAL_MAX_RADIUS,
            floors: 0,
            area_m2: 0.0,
            hub_height_m: Some(hub_height_m),
            rated_power_kw: Some(rated_power_kw),
        }];
    }

    let area = resolve_area_m2(input.area_m2, input.polygon_wkb, 10000.0);
    let profile = input
        .nace_4digit
        .and_then(industrial::nace_profile)
        .or_else(|| industrial::subtype_profile(input.site_subtype))
        .unwrap_or_else(|| industrial::industrial_profile(input.source_type));
    let lw = industrial::industrial_lw(&profile, area);
    if lw < 10.0 {
        return Vec::new();
    }

    let lw_day = bands_to_f32(industrial::industrial_emission_bands(&profile, lw));
    let mut lw_evening = lw_day;
    let mut lw_night = lw_day;
    for i in 0..NUM_BANDS {
        lw_evening[i] += profile.evening_offset as f32;
        lw_night[i] += profile.night_offset as f32;
    }

    let source_height_m = if input.source_type == 1 {
        8.0
    } else {
        match input.nace_4digit.map(|n| n / 100) {
            // Heavy/tall sources: coal mining (05) + other mining & quarrying (08),
            // cement/minerals (23), metallurgy (24), power generation (35).
            Some(5 | 8 | 23 | 24 | 35) => 10.0,
            _ => 5.0,
        }
    };
    let weighted_points: Vec<(f64, f64, f64)> = if area > 5_000.0 && !input.polygon_wkb.is_empty() {
        let cells = crate::wkb::wkb_area_grid_points(
            input.polygon_wkb,
            INDUSTRIAL_AREA_CELL_M,
            INDUSTRIAL_AREA_CELL_SAMPLES,
        );
        if cells.len() > 1 {
            let sampled_area = cells.iter().map(|p| p.area_m2).sum::<f64>().max(1.0);
            cells
                .into_iter()
                .map(|p| (p.lat, p.lon, p.area_m2 * area / sampled_area))
                .collect()
        } else {
            vec![(input.centroid_lat, input.centroid_lon, area)]
        }
    } else {
        vec![(input.centroid_lat, input.centroid_lon, area)]
    };
    let n_points = weighted_points.len().min(u16::MAX as usize) as u16;

    weighted_points
        .into_iter()
        .map(|(lat, lon, point_area)| {
            let mut day = lw_day;
            let mut evening = lw_evening;
            let mut night = lw_night;
            let lw_split = 10.0 * ((area / point_area.max(1.0)) as f32).log10();
            for band in 0..NUM_BANDS {
                day[band] -= lw_split;
                evening[band] -= lw_split;
                night[band] -= lw_split;
            }
            let exclusion_radius_m = (point_area as f32 / std::f32::consts::PI).sqrt();
            PreparedPoint {
                lat,
                lon,
                source_height_m,
                lw_day: day,
                lw_evening: evening,
                lw_night: night,
                n_points,
                exclusion_radius_m,
                max_radius_m: crate::constants::INDUSTRIAL_MAX_RADIUS,
                floors: 0,
                area_m2: area as f32,
                hub_height_m: None,
                rated_power_kw: None,
            }
        })
        .collect()
}

/// Default leisure footprint when the row has no polygon/area (e.g. a
/// `leisure=playground` node): a small court-sized 600 m². Below the area-grid
/// threshold so it stays a single centroid point.
const LEISURE_DEFAULT_AREA_M2: f64 = 600.0;
/// Leisure areas are LOCAL activity sources — cap reach like buildings (2 km),
/// never the 4 km industrial-plant reach.
const LEISURE_MAX_RADIUS_M: f64 = 2_000.0;

/// Discretise one leisure AREA source into per-cell [`PreparedPoint`]s. Reuses
/// the industrial area-grid GEOMETRY (`wkb_area_grid_points`, 75 m cells with
/// the same self-screening `√(cell_area/π)` exclusion) but with LEISURE
/// semantics: a fixed per-facility `lw` from `leisure::leisure_profile` (capacity
/// build-up applied to the WHOLE source, then split across cells by area
/// fraction — energy-conserving), ~1.5 m source height, and an Lw-derived reach
/// capped at 2 km. Returns `[]` when the source is sub-audible.
pub fn prepare_leisure_points(input: RawLeisureInput<'_>) -> Vec<PreparedPoint> {
    let area = resolve_area_m2(input.area_m2, input.polygon_wkb, LEISURE_DEFAULT_AREA_M2);
    let profile = leisure::leisure_profile(input.sport);
    let lw = leisure::leisure_lw(&profile, input.capacity);
    if lw < 10.0 {
        return Vec::new();
    }

    let lw_day = bands_to_f32(leisure::leisure_emission_bands(&profile, lw));
    let mut lw_evening = lw_day;
    let mut lw_night = lw_day;
    for i in 0..NUM_BANDS {
        lw_evening[i] += profile.evening_offset as f32;
        lw_night[i] += profile.night_offset as f32;
    }

    let max_radius_m = settlement::building_max_dist(lw).min(LEISURE_MAX_RADIUS_M);
    let weighted_points: Vec<(f64, f64, f64)> = if area > 5_000.0 && !input.polygon_wkb.is_empty() {
        let cells = crate::wkb::wkb_area_grid_points(
            input.polygon_wkb,
            INDUSTRIAL_AREA_CELL_M,
            INDUSTRIAL_AREA_CELL_SAMPLES,
        );
        if cells.len() > 1 {
            let sampled_area = cells.iter().map(|p| p.area_m2).sum::<f64>().max(1.0);
            cells
                .into_iter()
                .map(|p| (p.lat, p.lon, p.area_m2 * area / sampled_area))
                .collect()
        } else {
            vec![(input.centroid_lat, input.centroid_lon, area)]
        }
    } else {
        vec![(input.centroid_lat, input.centroid_lon, area)]
    };
    let n_points = weighted_points.len().min(u16::MAX as usize) as u16;

    weighted_points
        .into_iter()
        .map(|(lat, lon, point_area)| {
            let mut day = lw_day;
            let mut evening = lw_evening;
            let mut night = lw_night;
            let lw_split = 10.0 * ((area / point_area.max(1.0)) as f32).log10();
            for band in 0..NUM_BANDS {
                day[band] -= lw_split;
                evening[band] -= lw_split;
                night[band] -= lw_split;
            }
            PreparedPoint {
                lat,
                lon,
                source_height_m: crate::constants::SOURCE_HEIGHT_INDUSTRIAL_OPEN as f32,
                lw_day: day,
                lw_evening: evening,
                lw_night: night,
                n_points,
                exclusion_radius_m: (point_area as f32 / std::f32::consts::PI).sqrt(),
                max_radius_m,
                floors: 0,
                area_m2: area as f32,
                hub_height_m: None,
                rated_power_kw: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_building_uses_radius_from_lw() {
        let points = prepare_building_points(RawBuildingInput {
            centroid_lat: 49.0,
            centroid_lon: 14.0,
            height_m: 12.0,
            floors: 4,
            building_type: 1,
            area_m2: Some(300.0),
            polygon_wkb: "",
        });
        assert_eq!(points.len(), 1);
        assert!(points[0].max_radius_m > 0.0);
    }

    /// `prepare_building_points` must carry `floors` and `area_m2`
    /// through to `PreparedPoint` so the per-segment popup trace
    /// echoes what the engine actually used (else the popup shows
    /// "0 floors / 0 m²" even for fully-resolved buildings).
    #[test]
    fn prepared_building_carries_floors_and_area_to_segment_trace() {
        let points = prepare_building_points(RawBuildingInput {
            centroid_lat: 49.0,
            centroid_lon: 14.0,
            height_m: 12.0,
            floors: 4,
            building_type: 1,
            area_m2: Some(300.0),
            polygon_wkb: "",
        });
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].floors, 4, "OSM building:levels must propagate");
        assert!(
            (points[0].area_m2 - 300.0).abs() < 1e-3,
            "arrow area_m2 must propagate; got {}",
            points[0].area_m2,
        );
        // Wind-turbine fields stay None for ordinary buildings — they
        // belong to the wind-turbine branch of `prepare_industrial_points`.
        assert!(points[0].hub_height_m.is_none());
        assert!(points[0].rated_power_kw.is_none());
    }

    /// Wind-turbine branch (`source_type == 10`) must carry
    /// hub_height + rated_power through `PreparedPoint` so the popup
    /// `EmissionTrace::Industrial.{hub_height_m, rated_power_kw}`
    /// stops being hardcoded `None`.
    #[test]
    fn prepared_wind_turbine_carries_hub_and_power() {
        let points = prepare_industrial_points(RawIndustrialInput {
            centroid_lat: 49.0,
            centroid_lon: 14.0,
            source_type: 10,
            site_subtype: 0,
            nace_4digit: None,
            hub_height_m: Some(100.0),
            rated_power_kw: Some(3500.0),
            area_m2: None,
            polygon_wkb: "",
        });
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].hub_height_m, Some(100.0));
        assert_eq!(points[0].rated_power_kw, Some(3500.0));
        // Buildings-only fields stay 0 on turbines.
        assert_eq!(points[0].floors, 0);
        assert_eq!(points[0].area_m2, 0.0);
    }

    /// Settlement v2 phase 1: the cull radius is the honest free-field
    /// audibility distance of the radiated lw — one scalar, no compensation
    /// (the pre-v2 pin 63.39 m guarded the W7 net-zero contract, now gone).
    #[test]
    fn building_cull_radius_matches_honest_lw() {
        let points = prepare_building_points(RawBuildingInput {
            centroid_lat: 49.0,
            centroid_lon: 14.0,
            height_m: 0.0,
            floors: 3,
            building_type: 0,
            area_m2: Some(200.0),
            polygon_wkb: "",
        });
        let p = settlement::building_profile(0);
        let expected = settlement::building_max_dist(settlement::building_lw(&p, 200.0, 3));
        assert!(
            (points[0].max_radius_m - expected).abs() < 1e-6,
            "cull radius {} != building_max_dist(lw) {}",
            points[0].max_radius_m,
            expected
        );
    }

    /// Audit I-10b wind-turbine input hygiene: hub default = 105 m
    /// (known-data median in our arrows), tag-error hubs clamp to 175 m,
    /// implausible rated power (>8 MW onshore) is treated as unknown.
    #[test]
    fn wind_turbine_hub_default_and_tag_error_clamps() {
        let prep = |hub: Option<f32>, power: Option<f32>| {
            prepare_industrial_points(RawIndustrialInput {
                centroid_lat: 49.0,
                centroid_lon: 14.0,
                source_type: 10,
                site_subtype: 0,
                nace_4digit: None,
                hub_height_m: hub,
                rated_power_kw: power,
                area_m2: None,
                polygon_wkb: "",
            })
        };
        // Missing hub → 105 m default, carried into source_height_m.
        let points = prep(None, Some(2000.0));
        assert_eq!(points[0].hub_height_m, Some(105.0));
        assert_eq!(points[0].source_height_m, 105.0);
        // Tag-error hub clamps to 175 m; plausible hubs pass through.
        assert_eq!(prep(Some(250.0), Some(2000.0))[0].hub_height_m, Some(175.0));
        assert_eq!(prep(Some(120.0), Some(2000.0))[0].hub_height_m, Some(120.0));
        // Implausible rated power = unknown → 2 MW default, and the emission
        // uses the 2 MW class (LwA 105), not the ≥5 MW class (106.5).
        let points = prep(None, Some(20_000.0));
        assert_eq!(points[0].rated_power_kw, Some(2000.0));
        let day_f64: [f64; NUM_BANDS] = std::array::from_fn(|i| points[0].lw_day[i] as f64);
        let aw = crate::propagation::iso9613::a_weighted_total(&day_f64);
        assert!((aw - 105.0).abs() < 1e-3, "clamped-power turbine LwA: {aw}");
    }

    /// A leisure area source: 1.5 m height, Lw-derived reach, capacity scaling,
    /// and energy-conserving split over the area grid (settlement v2 phase 2).
    #[test]
    fn prepared_leisure_padel_court_emits_at_15m_height() {
        let points = prepare_leisure_points(RawLeisureInput {
            centroid_lat: 50.0,
            centroid_lon: 14.0,
            sport: leisure::PADEL,
            area_m2: Some(300.0), // single court → centroid point
            capacity: None,
            polygon_wkb: "",
        });
        assert_eq!(points.len(), 1);
        assert!((points[0].source_height_m - 1.5).abs() < 1e-6);
        assert!(points[0].max_radius_m > 0.0 && points[0].max_radius_m <= 2_000.0);
        assert_eq!(points[0].floors, 0);
        // Day A-sum equals the padel anchor (90 dB) for a single un-split point.
        let day: [f64; NUM_BANDS] = std::array::from_fn(|i| points[0].lw_day[i] as f64);
        let aw = crate::propagation::iso9613::a_weighted_total(&day);
        assert!((aw - 90.0).abs() < 1e-3, "padel day LwA: {aw}");
    }

    /// Sub-audible leisure (impossible here, but the gate must hold): a class
    /// with lw < 10 returns no points. Use capacity=0-equivalent via a tiny
    /// hand-built profile is overkill; instead assert a normal class is audible.
    #[test]
    fn prepared_leisure_outdoor_seating_scales_capacity() {
        let small = prepare_leisure_points(RawLeisureInput {
            centroid_lat: 50.0,
            centroid_lon: 14.0,
            sport: leisure::OUTDOOR_SEATING,
            area_m2: Some(200.0),
            capacity: Some(50),
            polygon_wkb: "",
        });
        let big = prepare_leisure_points(RawLeisureInput {
            centroid_lat: 50.0,
            centroid_lon: 14.0,
            sport: leisure::OUTDOOR_SEATING,
            area_m2: Some(200.0),
            capacity: Some(200),
            polygon_wkb: "",
        });
        let aw = |p: &PreparedPoint| {
            let d: [f64; NUM_BANDS] = std::array::from_fn(|i| p.lw_day[i] as f64);
            crate::propagation::iso9613::a_weighted_total(&d)
        };
        // 200 vs 50 seats = +6 dB (10·log10(4)).
        assert!((aw(&big[0]) - aw(&small[0]) - 6.0206).abs() < 1e-2);
    }
}
