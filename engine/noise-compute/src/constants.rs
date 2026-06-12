//! Physical constants from CNOSSOS-EU and ISO 9613-2.

use crate::types::NUM_BANDS;

/// A-weighting per octave band [dB] (IEC 61672-1).
/// Bands: 63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz
pub const A_WEIGHTING: [f64; NUM_BANDS] = [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

/// Atmospheric absorption [dB/km] (ISO 9613-1, 15°C, 70% RH, 101.325 kPa).
pub const ALPHA_ATM: [f64; NUM_BANDS] = [0.1, 0.4, 1.0, 1.9, 3.7, 8.7, 22.0, 58.4];

/// Vegetation attenuation [dB/m] (ISO 9613-2:2024 Annex A.2.2 × 0.5 Central Europe calibration).
/// WHY: ISO values calibrated for dense deciduous foliage in full leaf. ESA WorldCover
/// "tree cover" class 10 includes canopy ≥10% (sparse/coniferous/mixed), averaging ~50%.
/// See docs/future-plans/forest-continuous-density.md for the continuous-raster alternative.
pub const ALPHA_VEG: [f64; NUM_BANDS] = [0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.045, 0.06];

/// Maximum vegetation attenuation per band [dB] (ISO 9613-2 Table A.1 × 0.5 Central Europe calibration).
pub const MAX_VEG_ATTEN: [f64; NUM_BANDS] = [2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 9.0, 12.0];

/// Ground correction factors (CNOSSOS-EU §2.5.15).
/// Applied as: A_ground[i] = CF[i] × G, where G = 1 - IMD/100.
pub const GROUND_CF: [f64; NUM_BANDS] = [-1.5, -0.7, 1.5, 2.5, 2.0, 1.3, 0.7, 0.2];

/// Octave band center frequencies [Hz].
pub const BAND_FREQ: [f64; NUM_BANDS] = [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];

/// Speed of sound [m/s] at 15°C.
pub const SPEED_OF_SOUND: f64 = 340.0;

/// Default receiver height [m] — END 2002/49/EC facade standard (4.0m).
/// Was 1.5m (human ear). Changed to 4.0m to match EU strategic noise mapping
/// and eliminate systematic -3 dB bias vs SHM across all sources.
pub const DEFAULT_RECEIVER_HEIGHT: f64 = 4.0;

/// Favourable propagation probability (CNOSSOS-EU §2.5.21, Central Europe).
pub const P_FAV: f64 = 0.5;

/// Diffraction attenuation caps [dB].
pub const SINGLE_DIFF_CAP: f64 = 20.0;
pub const DOUBLE_DIFF_CAP: f64 = 25.0;

/// Maximum building screening attenuation per band [dB].
/// ISO 9613-2 allows 20-25 dB for single/double diffraction.
pub const MAX_SCREENING: f64 = 20.0;

/// Source heights [m].
pub const SOURCE_HEIGHT_ROAD: f64 = 0.05; // CNOSSOS-EU §2.4.1
pub const SOURCE_HEIGHT_RAIL: f64 = 0.5; // CNOSSOS-EU §2.7.1
pub const SOURCE_HEIGHT_INDUSTRIAL_OPEN: f64 = 1.5;

/// Meters per degree of latitude (spherical approximation).
pub const M_PER_DEG_LAT: f64 = 110_540.0;
/// Meters per degree of longitude at the equator (multiply by `cos(lat)` for
/// a given latitude via [`m_per_deg_lon`]).
pub const M_PER_DEG_LON_EQ: f64 = 111_320.0;

/// Meters per degree of longitude at `lat_rad` radians.
///
/// Floors `cos(lat)` at `0.01` (~89.43° max effective lat) so callers
/// dividing by the result — e.g. `ENCLOSURE_RADIUS_M / m_per_deg_lon(lat)`
/// — degrade smoothly toward the poles instead of returning `∞`.
/// `wkb.rs` already applies its own `cos().max(0.1)` ceiling on the
/// raw expression; the looser floor here doesn't affect it.
#[inline]
pub fn m_per_deg_lon(lat_rad: f64) -> f64 {
    M_PER_DEG_LON_EQ * lat_rad.cos().max(0.01)
}
pub const SOURCE_HEIGHT_INDUSTRIAL_ENCLOSED: f64 = 4.0;

/// CNOSSOS road emission reference speed [km/h].
pub const V_REF_ROAD: f64 = 70.0;

/// Heavy vehicle speed cap [km/h] (Czech legal requirement, consistent with CNOSSOS).
pub const HEAVY_SPEED_CAP: f64 = 80.0;

/// Road surface corrections [dB] applied to rolling noise only.
pub const SURFACE_CORR: [f64; 5] = [
    0.0, // 0: asphalt (reference)
    4.0, // 1: sett/cobblestone
    4.0, // 2: cobblestone/paving stones
    1.0, // 3: concrete
    2.0, // 4: gravel/unpaved
];

// ── Source max-radius cutoffs (meters) ──────────────────────────
// Single source of truth: pipeline (soa.rs), normalize.rs, and
// source-reader (popup) all reference these constants.

/// Road max propagation radius by road_class index
/// (0=motorway .. 6=living_street, 7=service, 8=track, 9=unclassified,
///  10=motorway_link, 11=trunk_link, 12=primary_link).
pub const ROAD_MAX_RADIUS: [f64; 13] = [
    10_000.0, // 0: motorway
     7_000.0, // 1: trunk
     5_000.0, // 2: primary
     3_000.0, // 3: secondary
     1_600.0, // 4: tertiary
       800.0, // 5: residential
       400.0, // 6: living_street
       500.0, // 7: service (parking aisles, driveways)
       300.0, // 8: track (agricultural / forestry)
     2_000.0, // 9: unclassified (rural connector between villages)
     1_200.0, // 10: motorway_link (ramp — 15 % traffic, shorter audible reach)
       900.0, // 11: trunk_link
       600.0, // 12: primary_link
];

/// Railway reach clamp + boundary convention.
///
/// Rail reach is solved PER ROW: each segment reaches exactly to the distance
/// where ITS OWN free-field Lden falls to [`RAILWAY_REACH_TARGET_LDEN_DB`]
/// (see `emission::railway::rail_reach_m`). The blanket 7 km that used to gate
/// every row (commit `8540e4cb`, "all types") is retired — a quiet branch line
/// truncating at the same distance as a 300 km/h corridor was a correctness
/// bug, not a tuning choice. The solver reproduces the old 7 km for a *default
/// mainline* (80 pax + 20 freight @ 80 km/h → 25.3 dB @ 7 km, the 2026-05-24
/// Codex empirical re-derived in `.claude/plans/heatmap-orchestrator-audit/
/// layer-line.md` §A), so the change is value-neutral for the dominant class
/// and only moves the 25-30 dB fringe ring on the tails (quiet rows shrink,
/// HS/loud corridors extend to the noise we currently truncate).
///
/// Clamp `[2 km, 10 km]`:
/// - **Floor 2 km**: degenerate quiet rows (a single freight wagon, a stub
///   siding) must still cover their near field, and the 25 dB target is a
///   *display* convention (the renderer floor sits at 30 dB), not a physics
///   cutoff — never let the solver cull a row before its audible field is
///   drawn.
/// - **Ceiling 10 km**: the halo budget. In a shared surface build the road
///   10 km halo already ray-marches terrain this far, so capping rail reach at
///   10 km costs no extra halo; beyond 10 km the cumulative Lden is < ~19 dB
///   (well under the renderer floor) for any realistic corridor.
pub const RAILWAY_REACH_CLAMP_MIN: f64 = 2_000.0;
pub const RAILWAY_REACH_CLAMP_MAX: f64 = 10_000.0;

/// Lden boundary the per-row rail reach solves to. Mirrors the ~25 dB
/// road/rail boundary convention (road's per-class `ROAD_MAX_RADIUS` caps sit
/// at the same crossing — e.g. motorway 10 km, residential 800 m — so road and
/// rail reach use one boundary). Display floor, not a physics cutoff.
pub const RAILWAY_REACH_TARGET_LDEN_DB: f64 = 25.0;

/// Widest rail reach the clamp can return — used to size the rail-only
/// ray-march halo (`build_heatmap_surface` / `gpu_surface`) so a row extended
/// to the ceiling still ray-marches terrain along its whole path. Equals
/// [`RAILWAY_REACH_CLAMP_MAX`]; named separately so the halo's intent reads at
/// the call site.
pub const RAILWAY_REACH_CEILING: f64 = RAILWAY_REACH_CLAMP_MAX;

/// Industrial point source max radius.
pub const INDUSTRIAL_MAX_RADIUS: f64 = 4_000.0;

/// Aircraft ground ops max radii. Per-ops_kind reach matches per-source
/// emission decay: cumulative line-source Lden at the cap boundary sits
/// ~5-15 dB (well below the 30 dB renderer floor + the ~25 dB road/rail
/// calibration boundary). Wired via `ground_ops_max_radius()` into both
/// heatmap (`ground_ops.rs`) and popup (`airport_traffic.rs`). Measured
/// LKPR 49-tile bbox: 97× wall speedup vs the prior 16 km blanket;
/// mean drift 5.4 dB, max 26 dB at outermost tile corners (mostly
/// pixels that fall under the 30 dB tile-skip floor).
pub const GROUND_OPS_RUNWAY_MAX_RADIUS: f64 = 5_000.0;
pub const GROUND_OPS_TAXI_MAX_RADIUS: f64 = 3_000.0;
pub const GROUND_OPS_APRON_MAX_RADIUS: f64 = 1_500.0;

/// Per-`ops_kind` reach. Heatmap + popup share this — single source of truth.
/// Unknown / NONE → most generous cap so we never silently drop.
/// APRON arm is reserved: current Stage 2C only emits ops_kind ∈
/// {RUNWAY_ROLL, TAXI} for line features (aprons are area features —
/// see `stage_2c/airport_traffic_writer.rs:69`). Wired anyway so a
/// future area→line synthesis doesn't silently inherit the RUNWAY cap.
#[inline]
pub fn ground_ops_max_radius(ops_kind: u8) -> f64 {
    use crate::emission::aircraft::{
        GROUND_OPS_KIND_APRON_MOVEMENT, GROUND_OPS_KIND_RUNWAY_ROLL, GROUND_OPS_KIND_TAXI,
    };
    match ops_kind {
        GROUND_OPS_KIND_RUNWAY_ROLL => GROUND_OPS_RUNWAY_MAX_RADIUS,
        GROUND_OPS_KIND_TAXI => GROUND_OPS_TAXI_MAX_RADIUS,
        GROUND_OPS_KIND_APRON_MOVEMENT => GROUND_OPS_APRON_MAX_RADIUS,
        _ => GROUND_OPS_RUNWAY_MAX_RADIUS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// At the pole, `cos(lat) = 0` would yield `m_per_deg_lon = 0`,
    /// breaking every caller that divides by it. The floor inside
    /// `m_per_deg_lon` keeps the value finite and positive.
    #[test]
    fn m_per_deg_lon_at_pole_is_finite_positive() {
        let v = m_per_deg_lon(PI / 2.0);
        assert!(v.is_finite() && v > 0.0, "m_per_deg_lon(π/2) = {v}");
    }

    /// Equator value stays unchanged by the floor (cos(0) = 1 ≫ 0.01).
    #[test]
    fn m_per_deg_lon_at_equator_unchanged_by_floor() {
        let v = m_per_deg_lon(0.0);
        assert!((v - M_PER_DEG_LON_EQ).abs() < 1e-9);
    }
}
