//! Leisure-area (sports / play / open-air hospitality) noise emission —
//! settlement v2 phase 2. These OSM features carry NO `building=*`, so the
//! extractor dropped them entirely before phase 2; they now spill to their own
//! `leisure.arrow` with a `sport` u8 + optional capacity, and
//! [`crate::normalize::prepare_leisure_points`] samples them over the same
//! `wkb_area_grid_points` GEOMETRY as the industrial path (75 m cells) — but
//! with leisure semantics: ~1.5 m source height (voices/rackets, not roof
//! plant), an Lw-derived audibility reach, and the per-sport day/evening/night
//! pattern below. NOT GFA-scaled (the level is activity-driven, not floor-area).
//!
//! Calibration is the plan §A/§C anchors (dual /gg-reviewed; per-sport source
//! cited inline). All `lw` are HONEST radiated dB(A) (`a_weighted_total(bands)
//! == lw`) and bake the duty cycle / seasonality into a single annualized level
//! (the engine has no month axis — plan §C "Seasonality handling").
//! PROP-MEAS = no clean measured value found; a conservative placeholder ships
//! flagged, queued for measurement (plan §D) — never presented as measured.

use crate::types::NUM_BANDS;

/// Leisure `sport`/kind class ids written by `osm-extract::spill` into
/// `leisure.arrow`. Stable once shipped (own v1 per-file contract): the arrow
/// stores the raw u8. 0 is the generic-pitch default so an untyped
/// `leisure=pitch` still emits.
pub const PITCH: u8 = 0;
pub const PADEL: u8 = 1;
pub const TENNIS: u8 = 2;
pub const BASKETBALL: u8 = 3;
pub const PLAYGROUND: u8 = 4;
pub const POOL: u8 = 5;
/// Open-air hospitality seating (`amenity=biergarten`, `outdoor_seating=yes`,
/// `leisure=outdoor_seating`) — patron voices, capacity-scaled.
pub const OUTDOOR_SEATING: u8 = 6;
/// Stadium / large sports ground — pitch + crowd + PA; rare match-day events,
/// kept at pitch level (do NOT over-weight, plan §A "Stadium").
pub const STADIUM: u8 = 7;

/// Map an OSM `sport=*` value (lower-cased) to a leisure class id. `leisure=*`
/// kind is the fallback when `sport` is absent (resolved in `spill.rs`).
pub fn sport_class(sport: &str) -> Option<u8> {
    Some(match sport {
        "padel" => PADEL,
        "tennis" => TENNIS,
        "basketball" | "netball" | "handball" => BASKETBALL,
        // Ball-sport pitches all share the football/pitch anchor.
        "soccer" | "football" | "american_football" | "rugby" | "rugby_union"
        | "rugby_league" | "field_hockey" | "hockey" | "baseball" | "cricket"
        | "multi" => PITCH,
        "swimming" => POOL,
        _ => return None,
    })
}

/// Per-leisure-area emission profile. Unlike buildings there is no GFA term —
/// `lw` is the whole-source radiated dB(A) for one typical facility (capacity
/// scaling for crowd sources is applied in `prepare_leisure_points` via
/// `+10·log10(N/N_ref)`). Source height is fixed (~1.5 m) in the prep path.
pub struct LeisureProfile {
    /// Whole-source radiated dB(A) for one typical facility at reference
    /// capacity. `prepare_leisure_points` distributes this over the area cells.
    pub lw: f64,
    /// Relative dB per 8-band [63..8k]; A-sum-normalized to `lw`.
    pub spectrum: [f64; NUM_BANDS],
    pub evening_offset: f64,
    pub night_offset: f64,
    /// Reference capacity (seats/people) the `lw` anchor assumes. Crowd sources
    /// (`OUTDOOR_SEATING`, `PLAYGROUND`) scale by `10·log10(capacity/ref)`;
    /// `0.0` = not capacity-scaled (court/pitch level is per-facility).
    pub ref_capacity: f64,
}

/// Emission profile by leisure class id (see the `pub const`s).
///
/// Anchors (plan §A): padel Lw 90 (racket "pock" on glass, +6 vs tennis,
/// ~1000/h, padelcreations + Higgins); tennis Lw 84 (LFmax 58.4/strike TUM,
/// padel −6); basketball/MUGA Lmax 45–53 @receptor (UBC/BKL) → pitch −6;
/// football pitch Lw 88 (58 LAeq,1h @10 m, Sport England AGP); playground
/// schoolyard −5 PROP-MEAS (no clean per-child Lw); pool boundary PROP-MEAS,
/// summer-only annualized; outdoor seating 71 dB(A)/guest (Lärmfibel
/// Biergärten, LWA,B = 71 + 10·log n).
pub fn leisure_profile(sport: u8) -> LeisureProfile {
    match sport {
        PADEL => LeisureProfile {
            lw: 90.0,
            // HF-weighted, impulsive racket/ball pock on glass.
            spectrum: [-6.0, -4.0, -2.0, -1.0, 0.0, 1.0, 2.0, 1.0],
            evening_offset: 0.0,   // plays 07–23; evening is peak
            night_offset: -15.0,
            ref_capacity: 0.0,
        },
        TENNIS => LeisureProfile {
            lw: 84.0,
            spectrum: [-5.0, -4.0, -2.0, -1.0, 0.0, 1.0, 1.0, 0.0],
            evening_offset: -3.0,
            night_offset: -20.0,
            ref_capacity: 0.0,
        },
        BASKETBALL => LeisureProfile {
            // tennis −6 (ball bounce on hard court, less impulsive than rackets).
            lw: 78.0,
            spectrum: [-4.0, -3.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0],
            evening_offset: -3.0,
            night_offset: -20.0,
            ref_capacity: 0.0,
        },
        PLAYGROUND => LeisureProfile {
            // schoolyard −5 (child play area source); PROP-MEAS per-child Lw.
            // Day-heavy, year-round; voices mid-band. ref_capacity scaling lets
            // a tagged `capacity` lift a large playground above the default.
            lw: 80.0,
            spectrum: [-3.0, -1.0, 1.0, 2.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -25.0,
            ref_capacity: 20.0, // ~20 children at a typical sídliště hřiště
        },
        POOL => LeisureProfile {
            // outdoor lido — splash/voice; PROP-MEAS boundary LAeq; summer-only
            // (May–Sep) annualized into the level, mid-band.
            lw: 82.0,
            spectrum: [-3.0, -2.0, 0.0, 1.0, 1.0, 0.0, -2.0, -5.0],
            evening_offset: -5.0,
            night_offset: -25.0,
            ref_capacity: 0.0,
        },
        OUTDOOR_SEATING => LeisureProfile {
            // beer garden / café terrace — raised-speech voices, 71 dB(A)/guest
            // (Lärmfibel). lw here = 50-seat reference (71 + 10·log10(50) = 88);
            // a tagged `seats`/`capacity` rescales via ref_capacity. Evening
            // peak, strongly summer (annualized), quiet 22:00+.
            lw: 88.0,
            spectrum: [-2.0, -1.0, 1.0, 2.0, 1.0, 0.0, -3.0, -6.0],
            evening_offset: 0.0,
            night_offset: -15.0,
            ref_capacity: 50.0,
        },
        STADIUM => LeisureProfile {
            // pitch + crowd/PA, but match days only (~20–30/yr) → annualized
            // close to a pitch; do NOT over-weight (plan §A).
            lw: 90.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -3.0,
            night_offset: -12.0,
            ref_capacity: 0.0,
        },
        // PITCH (0) + any unknown → generic ball-sport pitch.
        _ => LeisureProfile {
            lw: 88.0,
            spectrum: [-2.0, -1.0, 0.0, 1.0, 1.0, 0.0, -2.0, -4.0],
            evening_offset: -3.0,
            night_offset: -10.0, // floodlit pitches run to ~22:00
            ref_capacity: 0.0,
        },
    }
}

/// Emission bands for a leisure area (day period), normalized so
/// `a_weighted_total(bands) == lw` (same contract as buildings).
pub fn leisure_emission_bands(profile: &LeisureProfile, lw: f64) -> [f64; NUM_BANDS] {
    super::spectrum::normalized_emission_bands(lw, &profile.spectrum)
}

/// Plausible upper bound on a simultaneous open-air leisure crowd. OSM
/// `seats`/`capacity` is a free integer tag; a typo or vandalism (`capacity=
/// 100000`) would otherwise drive `leisure_lw` past 120 dB and paint a multi-km
/// phantom hotspot. Clamp it, mirroring the wind-turbine tag-error clamp in
/// `normalize::prepare_industrial_points`. 10 000 covers the largest real
/// biergarten (Munich Hirschgarten ~8 000 seats); only PLAYGROUND /
/// OUTDOOR_SEATING (the `ref_capacity > 0` classes) are capacity-scaled.
const LEISURE_MAX_CAPACITY: u32 = 10_000;

/// Capacity-adjusted whole-source Lw. Crowd sources (`ref_capacity > 0`) build
/// up by `10·log10(capacity / ref_capacity)` from a tagged `seats`/`capacity`
/// (clamped to `LEISURE_MAX_CAPACITY` against tag errors); court/pitch sources
/// ignore capacity (the impact level is per-facility).
pub fn leisure_lw(profile: &LeisureProfile, capacity: Option<u32>) -> f64 {
    match (profile.ref_capacity, capacity) {
        (r, Some(c)) if r > 0.0 && c > 0 => {
            profile.lw + 10.0 * (c.min(LEISURE_MAX_CAPACITY) as f64 / r).log10()
        }
        _ => profile.lw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::propagation::iso9613::a_weighted_total;

    #[test]
    fn radiated_dba_equals_lw_for_all_leisure_classes() {
        for s in [PITCH, PADEL, TENNIS, BASKETBALL, PLAYGROUND, POOL, OUTDOOR_SEATING, STADIUM] {
            let p = leisure_profile(s);
            let lw = leisure_lw(&p, None);
            let aw = a_weighted_total(&leisure_emission_bands(&p, lw));
            assert!((aw - lw).abs() < 1e-6, "sport {s}: radiated {aw:.6} != lw {lw:.6}");
        }
    }

    /// The plan's loudness ordering must hold: padel ≫ tennis ≫ basketball,
    /// padel +6 over tennis (the 2024–26 complaint class).
    #[test]
    fn padel_louder_than_tennis_louder_than_basketball() {
        let padel = leisure_profile(PADEL).lw;
        let tennis = leisure_profile(TENNIS).lw;
        let basket = leisure_profile(BASKETBALL).lw;
        assert!((padel - tennis - 6.0).abs() < 1e-9, "padel must be tennis +6");
        assert!(tennis > basket);
    }

    /// Capacity build-up: a 100-seat beer garden is +3 dB over the 50-seat
    /// reference (10·log10(100/50)); a court ignores capacity.
    #[test]
    fn outdoor_seating_scales_with_seats() {
        let p = leisure_profile(OUTDOOR_SEATING);
        let ref_lw = leisure_lw(&p, Some(50));
        let big = leisure_lw(&p, Some(100));
        assert!((ref_lw - p.lw).abs() < 1e-9, "ref capacity = anchor lw");
        assert!((big - p.lw - 3.0103).abs() < 1e-3, "100 seats = +3 dB");
        // Courts ignore capacity.
        assert_eq!(leisure_lw(&leisure_profile(PADEL), Some(999)), 90.0);
    }

    /// OSM `capacity`/`seats` is a free, vandalizable tag; an absurd value must be
    /// clamped, not amplified into a 120+ dB phantom source (mirrors the
    /// wind-turbine tag-error clamp).
    #[test]
    fn leisure_lw_clamps_tag_error_capacity() {
        let p = leisure_profile(OUTDOOR_SEATING); // ref 50, anchor 88
        // Above the cap, Lw collapses to the cap's level — never higher.
        assert_eq!(
            leisure_lw(&p, Some(1_000_000)),
            leisure_lw(&p, Some(LEISURE_MAX_CAPACITY))
        );
        // Ceiling = 88 + 10·log10(10000/50) = 111 dB, not the 131 dB an unclamped
        // 1e6 would give.
        assert!(leisure_lw(&p, Some(1_000_000)) < p.lw + 24.0);
        // Below the cap, scaling is unchanged.
        assert_eq!(leisure_lw(&p, Some(100)), p.lw + 10.0 * (100.0_f64 / 50.0).log10());
    }

    #[test]
    fn sport_class_maps_known_values() {
        assert_eq!(sport_class("padel"), Some(PADEL));
        assert_eq!(sport_class("tennis"), Some(TENNIS));
        assert_eq!(sport_class("soccer"), Some(PITCH));
        assert_eq!(sport_class("basketball"), Some(BASKETBALL));
        assert_eq!(sport_class("swimming"), Some(POOL));
        assert_eq!(sport_class("chess"), None);
    }
}
