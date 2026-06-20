//! Shared source normalization helpers used by popup and pipeline.

use crate::admin::Admin;
use crate::constants::{SOURCE_HEIGHT_RAIL, SOURCE_HEIGHT_ROAD, SURFACE_CORR};
use crate::defaults::{build_traffic_default_cache, resolve_traffic_default, Aadt, WORLD_DEFAULT};
use crate::emission::{industrial, leisure, road, settlement, wind};
use crate::sources::{provenance_of, Provenance};
use crate::types::{PointSource, RailSegment, RoadSegment, NUM_BANDS};

/// `speed_limit` sentinel for OSM `maxspeed=none` (derestricted, e.g.
/// German Autobahn). Written by osm-extract (`spill.rs`), which clamps
/// real limits to 254 so they can never collide. Re-exported by
/// `osm-extract::classify` — this is the single definition.
pub const SPEED_LIMIT_DERESTRICTED: u8 = 255;

/// Effective emission speed for derestricted roads: BASt 2025 measured
/// a 124.1 km/h mean car speed on derestricted Autobahn sections, and
/// CNOSSOS-EU road emission is only valid up to its 130 km/h clamp
/// (see `road.rs`) — so model at the cap.
pub const DERESTRICTED_SPEED_KMH: f64 = 130.0;

#[derive(Debug, Clone, Copy)]
pub struct RawRoadInput {
    pub road_class: u8,
    /// km/h; 0 = untagged (class default), [`SPEED_LIMIT_DERESTRICTED`]
    /// = `maxspeed=none` → [`DERESTRICTED_SPEED_KMH`].
    pub speed_limit: u8,
    pub surface_type: u8,
    pub oneway: bool,
    pub lanes: u8,
    pub aadt_light: i32,
    pub aadt_medium: i32,
    pub aadt_heavy: i32,
    pub aadt_moto: i32,
    /// Provenance of the AADT values — derived from the row's
    /// dataset id via `sources::provenance_of()`.
    pub provenance: Provenance,
    pub tunnel: bool,
    pub access: u8,
    pub junction: u8,
}

#[derive(Debug, Clone)]
pub struct NormalizedRoad {
    pub class_idx: usize,
    pub class_name: &'static str,
    pub max_distance_m: f64,
    pub source_height_m: f64,
    /// Speed after junction cap (≤30 km/h at roundabouts).
    pub speed_kmh: f64,
    /// Speed before junction cap — equals `speed_kmh` for non-junction segments.
    /// Callers compare the two to tell whether the roundabout cap fired.
    pub base_speed_kmh: f64,
    pub surf_corr_db: f64,
    pub light_aadt: f64,
    pub medium_aadt: f64,
    pub heavy_aadt: f64,
    pub moto_aadt: f64,
}

impl NormalizedRoad {
    pub fn time_dist(&self) -> &'static road::TimeDist {
        // motorway (0) + trunk (1) + their ramps (10, 11) share the motorway
        // day/evening/night split; everything else uses the urban split.
        match self.class_idx {
            0 | 1 | 10 | 11 => &road::TIME_DIST_MOTORWAY,
            _ => &road::TIME_DIST_URBAN,
        }
    }

    pub fn period_emission(&self, period_pct: f64, period_hours: f64) -> [f32; NUM_BANDS] {
        let flows = road::build_period_flows(
            self.light_aadt,
            self.medium_aadt,
            self.heavy_aadt,
            self.moto_aadt,
            self.speed_kmh,
            period_pct,
            period_hours,
        );
        bands_to_f32(road::line_source_emission(&flows, self.surf_corr_db))
    }

    pub fn period_emissions(&self) -> ([f32; NUM_BANDS], [f32; NUM_BANDS], [f32; NUM_BANDS]) {
        let td = self.time_dist();
        (
            self.period_emission(td.day_pct, 12.0),
            self.period_emission(td.evening_pct, 4.0),
            self.period_emission(td.night_pct, 8.0),
        )
    }
}

/// Does this segment carry enriched traffic (any data from an enricher)
/// rather than a class default? Shared by `normalize_road` and
/// `nominal_road_aadt` so the "raw vs default" decision can't drift.
#[inline]
fn has_enriched_traffic(provenance: Provenance, aadt_light: i32) -> bool {
    provenance.has_data() && aadt_light > 0
}

/// Normalise a raw road input into per-band emission-ready values.
///
/// `admin` drives the class-default cascade (city → country → continent →
/// world) when the row lacks enriched traffic. Callers that do not have
/// an admin context yet — or that legitimately want the world arm — pass
/// [`Admin::UNKNOWN`]; the cascade collapses to `WORLD_DEFAULT` in that
/// case, matching the pre-Phase-0.5 behaviour bit-for-bit.
///
/// Tight loops should prefer [`normalize_road_with_cache`] together with
/// [`build_traffic_default_cache`] so the city → country → continent →
/// world cascade only runs 13 times per (admin, batch) instead of once
/// per `source_id == 0` segment. This wrapper builds a fresh cache on
/// every call — cheap (13 tuples) but wasteful when the same `admin`
/// is reused.
pub fn normalize_road(input: RawRoadInput, admin: Admin) -> Option<NormalizedRoad> {
    let cache = build_traffic_default_cache(admin);
    normalize_road_with_cache(input, &cache)
}

/// Cache-aware variant of [`normalize_road`]. The 13-entry slice is
/// produced once per (admin, batch) by [`build_traffic_default_cache`],
/// after which class-default lookup is a single array index instead of
/// up to four hash-map / binary-search hops through the cascade.
pub fn normalize_road_with_cache(
    input: RawRoadInput,
    defaults_cache: &[Aadt; WORLD_DEFAULT.len()],
) -> Option<NormalizedRoad> {
    if input.tunnel || input.access == 2 || input.access == 4 {
        return None;
    }

    let class_idx = (input.road_class as usize).min(ROAD_CLASS_NAMES.len() - 1);
    let class_name = ROAD_CLASS_NAMES[class_idx];
    let oneway_factor = if input.oneway { 0.5 } else { 1.0 };
    let access_factor = access_factor(input.access, input.provenance, input.road_class);

    let (light_aadt, medium_aadt, heavy_aadt, moto_aadt) =
        if has_enriched_traffic(input.provenance, input.aadt_light) {
            (
                input.aadt_light as f64 * oneway_factor * access_factor,
                input.aadt_medium as f64 * oneway_factor * access_factor,
                input.aadt_heavy as f64 * oneway_factor * access_factor,
                input.aadt_moto as f64 * oneway_factor * access_factor,
            )
        } else {
            let defaults =
                defaults_cache[(input.road_class as usize).min(defaults_cache.len() - 1)];
            let factor =
                oneway_factor * access_factor * lane_ratio(class_idx, input.lanes, input.oneway);
            (
                defaults.0 * factor,
                defaults.1 * factor,
                defaults.2 * factor,
                defaults.3 * factor,
            )
        };

    let base_speed_kmh = if input.speed_limit == SPEED_LIMIT_DERESTRICTED {
        DERESTRICTED_SPEED_KMH
    } else if input.speed_limit > 0 {
        input.speed_limit as f64
    } else {
        default_road_speed(class_idx)
    };
    let speed_kmh = if input.junction == 1 {
        base_speed_kmh.min(30.0)
    } else {
        base_speed_kmh
    };
    let surf_corr_db = SURFACE_CORR
        .get(input.surface_type as usize)
        .copied()
        .unwrap_or(0.0);

    Some(NormalizedRoad {
        class_idx,
        class_name,
        max_distance_m: ROAD_MAX_DIST[class_idx],
        source_height_m: SOURCE_HEIGHT_ROAD,
        speed_kmh,
        base_speed_kmh,
        surf_corr_db,
        light_aadt,
        medium_aadt,
        heavy_aadt,
        moto_aadt,
    })
}

pub fn normalize_road_segment(seg: &RoadSegment, admin: Admin) -> Option<NormalizedRoad> {
    normalize_road(
        RawRoadInput {
            road_class: seg.road_class,
            speed_limit: seg.speed_limit,
            surface_type: seg.surface_type,
            oneway: seg.oneway,
            lanes: seg.lanes,
            aadt_light: seg.aadt_light,
            aadt_medium: seg.aadt_medium,
            aadt_heavy: seg.aadt_heavy,
            aadt_moto: seg.aadt_moto,
            provenance: provenance_of(seg.source_id),
            tunnel: seg.tunnel,
            access: seg.access,
            junction: seg.junction,
        },
        admin,
    )
}

#[derive(Debug, Clone, Copy)]
pub struct RawRailInput {
    pub rail_type: u8,
    pub usage: u8,
    /// km/h; u16 so 300+ km/h high-speed lines survive (u8 saturated to 255).
    pub maxspeed: u16,
    pub service: u8,
    pub highspeed: bool,
    pub trains_passenger: i32,
    pub trains_freight: i32,
    pub parallel_divisor: u8,
}

#[derive(Debug, Clone)]
pub struct NormalizedRail {
    /// Admin region of the segment, threaded so `period_emissions` and the reach
    /// solver pick the SAME per-region day/evening/night split as the popup
    /// kernel (C1, plan delta 4). The heatmap loader resolves it once per region;
    /// `Admin::UNKNOWN` (tests / un-init) deterministically takes the world split.
    pub admin: Admin,
    pub rail_type: crate::emission::railway::RailType,
    pub source_height_m: f64,
    pub speed_kmh: f64,
    pub scaled_passenger_per_day: f64,
    pub scaled_freight_per_day: f64,
}

impl NormalizedRail {
    pub fn period_emission(
        &self,
        passenger_pct: f64,
        freight_pct: f64,
        period_hours: f64,
    ) -> [f32; NUM_BANDS] {
        bands_to_f32(crate::emission::railway::railway_emission(
            self.rail_type,
            self.speed_kmh,
            self.scaled_passenger_per_day * passenger_pct,
            self.scaled_freight_per_day * freight_pct,
            period_hours,
        ))
    }

    /// Per-period emission using the C1 per-region, per-category split resolved
    /// from `self.admin` + `self.rail_type` (shared with the popup kernel + the
    /// reach solver via [`crate::emission::railway::rail_time_dist`]).
    pub fn period_emissions(&self) -> ([f32; NUM_BANDS], [f32; NUM_BANDS], [f32; NUM_BANDS]) {
        let [(pd, fd, hd), (pe, fe, he), (pn, fn_, hn)] =
            crate::emission::railway::rail_time_dist(self.admin, self.rail_type).periods();
        (
            self.period_emission(pd, fd, hd),
            self.period_emission(pe, fe, he),
            self.period_emission(pn, fn_, hn),
        )
    }

    /// Per-row audibility reach [m] — the distance at which THIS segment's own
    /// free-field Lden falls to the ~25 dB boundary, clamped to `[2 km, 10 km]`
    /// (`emission::railway::rail_reach_m`). Replaces the retired blanket
    /// `RAILWAY_MAX_RADIUS`; the popup gate (`compute_railways`) calls the same
    /// solver on its `RailSegment` with the same `admin`, so the heatmap loader
    /// and popup cull at an identical distance by construction. Uses the *scaled*
    /// (post service / divisor) counts, so a divided or service track shrinks its
    /// own reach.
    pub fn max_distance_m(&self) -> f64 {
        crate::emission::railway::rail_reach_m(
            self.admin,
            self.rail_type,
            self.speed_kmh,
            self.scaled_passenger_per_day,
            self.scaled_freight_per_day,
        )
    }
}

pub fn normalize_rail(input: RawRailInput, admin: Admin) -> NormalizedRail {
    let rail_type = crate::emission::railway::RailType::from_u8(input.rail_type);
    let (def_pax, def_frt) = crate::emission::railway::default_traffic(rail_type, input.usage);
    let speed_kmh = if input.maxspeed > 0 {
        input.maxspeed as f64
    } else if input.highspeed {
        300.0
    } else {
        crate::emission::railway::default_speed(rail_type)
    };

    let q_pax = if input.trains_passenger > 0 {
        input.trains_passenger as f64
    } else {
        def_pax
    };
    let q_frt = if input.trains_freight > 0 {
        input.trains_freight as f64
    } else {
        def_frt
    };
    let service_factor = if input.service > 0 { 0.02 } else { 1.0 };
    let divisor = input.parallel_divisor.max(1) as f64;
    let scale_factor = service_factor / divisor;

    NormalizedRail {
        admin,
        rail_type,
        source_height_m: SOURCE_HEIGHT_RAIL,
        speed_kmh,
        scaled_passenger_per_day: q_pax * scale_factor,
        scaled_freight_per_day: q_frt * scale_factor,
    }
}

pub fn normalize_rail_segment(seg: &RailSegment, admin: Admin) -> NormalizedRail {
    NormalizedRail {
        admin,
        rail_type: crate::emission::railway::RailType::from_u8(seg.rail_type),
        source_height_m: SOURCE_HEIGHT_RAIL,
        speed_kmh: if seg.speed_kmh > 0.0 {
            seg.speed_kmh
        } else {
            80.0
        },
        scaled_passenger_per_day: seg.trains_passenger.max(0.0),
        scaled_freight_per_day: seg.trains_freight.max(0.0),
    }
}

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

fn bands_to_f32(bands: [f64; NUM_BANDS]) -> [f32; NUM_BANDS] {
    std::array::from_fn(|i| bands[i] as f32)
}

/// Resolve footprint area_m2 from the three sources the prep paths
/// consult, in priority order: caller-provided positive value (from
/// the arrow column) → WKB shoelace (when a polygon is available) →
/// `default_m2` (per-source-type small/large fallback: 100 m² for
/// buildings, 10 000 m² for industrial sites).
fn resolve_area_m2(provided: Option<f64>, polygon_wkb: &str, default_m2: f64) -> f64 {
    provided
        .filter(|a| *a > 0.0)
        .or_else(|| crate::wkb::wkb_area_m2(polygon_wkb))
        .unwrap_or(default_m2)
}

/// Lane-based AADT scaling ratio for un-enriched roads.
///
/// Source: CZ ŘSD Celostátní sčítání dopravy 2020. Median totals over
/// 3 197 deduplicated census sections (one section ≈ many OSM ways)
/// bucketed by `(class × lanes × oneway)`; each arm is
/// `bucket_median / 2-lane-baseline_median`. Producer: `pipeline/
/// calibrate-lane-ratios.ts` — re-run against current enriched arrows
/// to regenerate the table. Only buckets with N ≥ 30 sections emit an
/// arm, so trunk and tertiary stay at 1.0 (sample too thin). `min()`
/// clamps saturate higher lane counts at the highest calibrated
/// bucket. Enriched rows (Provenance::*Measured) bypass this whole
/// path — they carry the observed AADT directly.
pub fn lane_ratio(class_idx: usize, lanes: u8, oneway: bool) -> f64 {
    if lanes <= 2 || class_idx >= 5 {
        return 1.0;
    }
    match (class_idx, oneway) {
        (0, true) => match lanes.min(3) {
            3 => 1.42,
            _ => 1.0,
        },
        (2, false) => match lanes.min(4) {
            3 => 1.37,
            4 => 2.13,
            _ => 1.0,
        },
        (3, false) => match lanes.min(3) {
            3 => 1.83,
            _ => 1.0,
        },
        _ => 1.0,
    }
}

/// AADT multiplier per OSM access code. Measured provenance
/// (national / continental / global) passes through unchanged — the
/// observation already reflects the restriction.
///
/// Codes 7/8 (agricultural/forestry) are not literature-backed — they're
/// conservative heuristics reflecting that such tracks mostly carry single-digit
/// daily vehicle counts. Permissive sits at 0.9 because real-world permissive is
/// bimodal (fully open service roads vs. gated holiday-resort roads).
///
/// 94.7 % of class-8 (track) segments in the world OSM extract have
/// `access=0` (untagged). Empirically, an untagged gravel track carries
/// about the same load as an explicitly agricultural one, so we fold
/// `(class=8, access=0)` into the agricultural arm (0.1×) instead of
/// leaving it at the full class-8 default. This drops effective traffic
/// on untagged tracks to ~0.5/day — matches the reality at e.g. Kytín
/// "alej loupežníka Babinského".
fn access_factor(access: u8, provenance: Provenance, road_class: u8) -> f64 {
    if provenance.is_measured() {
        return 1.0;
    }
    // A.5: untagged (access=0) class-8 track → implicit agricultural.
    if road_class == 8 && access == 0 {
        return 0.1;
    }
    match access {
        1 => 0.1,  // private
        3 => 0.5,  // destination (local traffic only)
        5 => 0.9,  // permissive (bimodal — see docstring)
        6 => 0.3,  // customers (shop/parking approach; short-trip traffic only)
        7 => 0.1,  // agricultural (tractor on field track; heuristic)
        8 => 0.08, // forestry (even fewer than agricultural; heuristic)
        _ => 1.0,  // 0=yes/untagged; codes 2/4 already dropped in normalize_road
    }
}

/// Nominal (pre-factor) AADT for a segment — the arrow's raw number if
/// traffic is enriched (any provenance except `None`, `aadt_light > 0`),
/// otherwise the class default resolved through the admin cascade. This
/// is the "road total, both directions" number the popup surfaces,
/// independent of per-OSM-way oneway halving and per-segment access /
/// lane-ratio factors. `admin` should be the receiver-hex admin already
/// computed by the caller; `Admin::UNKNOWN` falls through to WORLD which
/// silently under-reports for places like Bangkok / São Paulo where the
/// city or country tier is meaningfully higher.
pub fn nominal_road_aadt(
    road_class: u8,
    provenance: Provenance,
    aadt_light: i32,
    aadt_medium: i32,
    aadt_heavy: i32,
    aadt_moto: i32,
    admin: Admin,
) -> (f64, f64, f64, f64) {
    if has_enriched_traffic(provenance, aadt_light) {
        (
            aadt_light as f64,
            aadt_medium as f64,
            aadt_heavy as f64,
            aadt_moto as f64,
        )
    } else {
        resolve_traffic_default(road_class, admin)
    }
}

fn default_road_speed(class_idx: usize) -> f64 {
    match class_idx {
        0 => 100.0,
        1 => 70.0,
        2 => 50.0,
        3 => 50.0,
        4 => 50.0,
        5 => 30.0,
        6 => 20.0,
        7 => 20.0,  // service
        8 => 20.0,  // track
        9 => 50.0,  // unclassified (rural typical)
        10 => 60.0, // motorway_link
        11 => 50.0, // trunk_link
        _ => 50.0,  // 12 primary_link (+ defensive fallback)
    }
}

const ROAD_CLASS_NAMES: [&str; 13] = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "living_street",
    "service",
    "track",
    "unclassified",
    "motorway_link",
    "trunk_link",
    "primary_link",
];

const ROAD_MAX_DIST: [f64; 13] = crate::constants::ROAD_MAX_RADIUS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_factor_rules() {
        use Provenance::{Heuristic, NationalMeasured, NationalProxy, None as Prov_None};
        // Non-track classes (5 residential) — default behaviour.
        assert_eq!(access_factor(0, Prov_None, 5), 1.0); // yes + default
        assert_eq!(access_factor(1, Prov_None, 5), 0.1); // private + default
        assert_eq!(access_factor(3, Prov_None, 5), 0.5); // destination + default
        assert_eq!(access_factor(5, Prov_None, 5), 0.9); // permissive + default
        assert_eq!(access_factor(6, Prov_None, 5), 0.3); // customers + default
        assert_eq!(access_factor(7, Prov_None, 5), 0.1); // agricultural + default
        assert_eq!(access_factor(8, Prov_None, 5), 0.08); // forestry + default
        assert_eq!(access_factor(3, Heuristic, 5), 0.5); // destination + service-tree heuristic
        assert_eq!(access_factor(3, NationalMeasured, 5), 1.0); // destination + measured → pass-through
        assert_eq!(access_factor(1, NationalMeasured, 5), 1.0); // private + measured → pass-through
        assert_eq!(access_factor(7, NationalMeasured, 5), 1.0); // agricultural + measured → pass-through
                                                                // A proxy is an ESTIMATE, not a measurement — it must still be down-scaled on
                                                                // restricted roads (gg 2026-06-14). Public roads are unaffected (factor 1.0).
        assert_eq!(access_factor(1, NationalProxy, 5), 0.1); // private + proxy → down-scaled
        assert_eq!(access_factor(7, NationalProxy, 5), 0.1); // agricultural + proxy → down-scaled
        assert_eq!(access_factor(0, NationalProxy, 5), 1.0); // public + proxy → unchanged
                                                             // A.5: untagged class-8 track gets implicit agricultural factor.
        assert_eq!(access_factor(0, Prov_None, 8), 0.1); // untagged track → implicit ag
        assert_eq!(access_factor(0, Prov_None, 5), 1.0); // untagged residential → unchanged
        assert_eq!(access_factor(0, NationalMeasured, 8), 1.0); // measured track → pass-through
    }

    #[test]
    fn road_defaults_match_tertiary_case() {
        let road = normalize_road(
            RawRoadInput {
                road_class: 4,
                speed_limit: 90,
                surface_type: 0,
                oneway: false,
                lanes: 0,
                aadt_light: 0,
                aadt_medium: 0,
                aadt_heavy: 0,
                aadt_moto: 0,
                provenance: Provenance::None,
                tunnel: false,
                access: 0,
                junction: 0,
            },
            Admin::UNKNOWN,
        )
        .unwrap();
        assert_eq!(road.class_name, "tertiary");
        assert!((road.light_aadt - 720.0).abs() < 1e-9);
        assert!((road.medium_aadt - 26.0).abs() < 1e-9);
        assert!((road.heavy_aadt - 38.0).abs() < 1e-9);
        assert!((road.moto_aadt - 16.0).abs() < 1e-9);
        assert!((road.speed_kmh - 90.0).abs() < 1e-9);
    }

    /// `maxspeed=none` sentinel (255) resolves to the derestricted model
    /// speed, not a literal 255 km/h emission input.
    #[test]
    fn derestricted_sentinel_resolves_to_130() {
        let road = normalize_road(
            RawRoadInput {
                road_class: 0,
                speed_limit: SPEED_LIMIT_DERESTRICTED,
                surface_type: 0,
                oneway: false,
                lanes: 0,
                aadt_light: 0,
                aadt_medium: 0,
                aadt_heavy: 0,
                aadt_moto: 0,
                provenance: Provenance::None,
                tunnel: false,
                access: 0,
                junction: 0,
            },
            Admin::UNKNOWN,
        )
        .unwrap();
        assert_eq!(road.base_speed_kmh, DERESTRICTED_SPEED_KMH);
        assert_eq!(road.speed_kmh, DERESTRICTED_SPEED_KMH);
    }

    /// Rail `maxspeed` is u16 since 2026-06: a posted 300 km/h must reach
    /// the emission as 300, not u8-saturated.
    #[test]
    fn rail_maxspeed_300_survives_u16() {
        let rail = normalize_rail(
            RawRailInput {
                rail_type: 0,
                usage: 0,
                maxspeed: 300,
                service: 0,
                highspeed: false,
                trains_passenger: 50,
                trains_freight: 0,
                parallel_divisor: 1,
            },
            Admin::UNKNOWN,
        );
        assert_eq!(rail.speed_kmh, 300.0);
    }

    #[test]
    fn rail_defaults_keep_freight_when_only_passenger_enriched() {
        let rail = normalize_rail(
            RawRailInput {
                rail_type: 0,
                usage: 0,
                maxspeed: 125,
                service: 0,
                highspeed: false,
                trains_passenger: 42,
                trains_freight: 0,
                parallel_divisor: 3,
            },
            Admin::UNKNOWN,
        );
        assert!((rail.scaled_passenger_per_day - 14.0).abs() < 1e-9);
        assert!((rail.scaled_freight_per_day - (20.0 / 3.0)).abs() < 1e-9);
    }

    /// High-speed rail with no posted maxspeed resolves to 300 km/h. Regression
    /// guard for the `RailSegment.speed_kmh` u8 truncation (300 → 255) that made
    /// the popup ~1.4 dB too quiet vs the surface heatmap (which baked emission
    /// from the full f64 speed). See `types::RailSegment::speed_kmh`.
    #[test]
    fn highspeed_default_resolves_to_300_not_u8_truncated() {
        let rail = normalize_rail(
            RawRailInput {
                rail_type: 0,
                usage: 0,
                maxspeed: 0,
                service: 0,
                highspeed: true,
                trains_passenger: 50,
                trains_freight: 0,
                parallel_divisor: 1,
            },
            Admin::UNKNOWN,
        );
        assert_eq!(
            rail.speed_kmh, 300.0,
            "highspeed no-maxspeed → 300, not 255"
        );
    }

    /// C1 delta 4 — POPUP-vs-LOADER rail emission parity: the heatmap loader's
    /// `NormalizedRail::period_emissions()` must equal an independent application
    /// of the SAME shared `rail_time_dist` shares through `railway_emission` (the
    /// exact chain the popup `compute_railways` loop runs). Bit-identical proves
    /// there is no second copy of the period split (mirrors the aircraft
    /// hoisted-vs-popup parity pattern). Run on a CZ (EU) row so the freight
    /// night share is non-trivial.
    #[test]
    fn loader_period_emissions_match_shared_split() {
        use crate::emission::railway::{rail_time_dist, railway_emission, RailType};
        let cz = Admin {
            continent: crate::admin::Continent::Europe,
            country_iso: *b"CZ",
            city_id: 0,
        };
        let norm = normalize_rail(
            RawRailInput {
                rail_type: 0,
                usage: 0,
                maxspeed: 120,
                service: 0,
                highspeed: false,
                trains_passenger: 100,
                trains_freight: 40,
                parallel_divisor: 1,
            },
            cz,
        );
        let (day, eve, night) = norm.period_emissions();
        let td = rail_time_dist(cz, RailType::Rail);
        let want = |pct_pax: f64, pct_frt: f64, h: f64| -> [f32; NUM_BANDS] {
            bands_to_f32(railway_emission(
                RailType::Rail,
                norm.speed_kmh,
                norm.scaled_passenger_per_day * pct_pax,
                norm.scaled_freight_per_day * pct_frt,
                h,
            ))
        };
        assert_eq!(day, want(td.pax[0], td.frt[0], 12.0), "day period parity");
        assert_eq!(
            eve,
            want(td.pax[1], td.frt[1], 4.0),
            "evening period parity"
        );
        assert_eq!(
            night,
            want(td.pax[2], td.frt[2], 8.0),
            "night period parity"
        );
    }

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

    #[test]
    fn ramp_defaults_are_15_percent_of_mainline() {
        // motorway_link (10) = 15 % of motorway (0)
        let (l0, m0, h0, x0) = resolve_traffic_default(0, Admin::UNKNOWN);
        let (l10, m10, h10, x10) = resolve_traffic_default(10, Admin::UNKNOWN);
        assert!((l10 - l0 * 0.15).abs() < 1e-6);
        assert!((m10 - m0 * 0.15).abs() < 1e-6);
        assert!((h10 - h0 * 0.15).abs() < 1e-6);
        assert!((x10 - x0 * 0.15).abs() < 1e-6);

        // trunk_link (11) = 15 % of trunk (1)
        let (l1, m1, h1, _) = resolve_traffic_default(1, Admin::UNKNOWN);
        let (l11, m11, h11, _) = resolve_traffic_default(11, Admin::UNKNOWN);
        assert!((l11 - l1 * 0.15).abs() < 1e-6);
        assert!((m11 - m1 * 0.15).abs() < 1e-6);
        assert!((h11 - h1 * 0.15).abs() < 1e-6);

        // primary_link (12) = 15 % of primary (2)
        let (l2, m2, h2, _) = resolve_traffic_default(2, Admin::UNKNOWN);
        let (l12, m12, h12, _) = resolve_traffic_default(12, Admin::UNKNOWN);
        assert!((l12 - l2 * 0.15).abs() < 1e-6);
        assert!((m12 - m2 * 0.15).abs() < 1e-6);
        assert!((h12 - h2 * 0.15).abs() < 1e-6);
    }

    #[test]
    fn ramp_speed_lower_than_mainline() {
        assert!(default_road_speed(10) < default_road_speed(0)); // motorway_link < motorway
        assert!(default_road_speed(11) < default_road_speed(1)); // trunk_link <= trunk
        assert!(default_road_speed(12) == default_road_speed(2)); // primary_link same as primary
    }

    #[test]
    fn ramp_time_dist_matches_motorway() {
        // Classes 10/11 must use TIME_DIST_MOTORWAY (65/20/15), not TIME_DIST_URBAN.
        let make = |class_idx: usize| NormalizedRoad {
            class_idx,
            class_name: "",
            max_distance_m: 0.0,
            source_height_m: 0.0,
            speed_kmh: 50.0,
            base_speed_kmh: 50.0,
            surf_corr_db: 0.0,
            light_aadt: 0.0,
            medium_aadt: 0.0,
            heavy_aadt: 0.0,
            moto_aadt: 0.0,
        };
        let motorway = make(0).time_dist();
        assert!(std::ptr::eq(make(10).time_dist(), motorway));
        assert!(std::ptr::eq(make(11).time_dist(), motorway));
        // primary_link (12) falls under urban split (closer to urban flow).
        assert!(!std::ptr::eq(make(12).time_dist(), motorway));
    }
}
