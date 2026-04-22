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
#[inline]
pub fn m_per_deg_lon(lat_rad: f64) -> f64 {
    M_PER_DEG_LON_EQ * lat_rad.cos()
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
     1_200.0, // 10: motorway_link (ramp — 20 % traffic, shorter audible reach)
       900.0, // 11: trunk_link
       600.0, // 12: primary_link
];

/// Railway max propagation radius (all types).
pub const RAILWAY_MAX_RADIUS: f64 = 7_000.0;

/// Industrial point source max radius.
pub const INDUSTRIAL_MAX_RADIUS: f64 = 4_000.0;

/// Aircraft ground ops max radii.
pub const GROUND_OPS_RUNWAY_MAX_RADIUS: f64 = 5_000.0;
pub const GROUND_OPS_TAXI_MAX_RADIUS: f64 = 3_000.0;
pub const GROUND_OPS_APRON_MAX_RADIUS: f64 = 1_500.0;
