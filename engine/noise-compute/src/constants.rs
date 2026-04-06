//! Physical constants from CNOSSOS-EU and ISO 9613-2.

use crate::types::NUM_BANDS;

/// A-weighting per octave band [dB] (IEC 61672-1).
/// Bands: 63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz
pub const A_WEIGHTING: [f64; NUM_BANDS] = [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

/// Atmospheric absorption [dB/km] (ISO 9613-1, 15°C, 70% RH, 101.325 kPa).
pub const ALPHA_ATM: [f64; NUM_BANDS] = [0.1, 0.4, 1.0, 1.9, 3.7, 8.7, 22.0, 58.4];

/// Vegetation attenuation [dB/m] (ISO 9613-2:2024 Annex A.2.2).
pub const ALPHA_VEG: [f64; NUM_BANDS] = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.12];

/// Maximum vegetation attenuation per band [dB].
pub const MAX_VEG_ATTEN: f64 = 15.0;

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
pub const MAX_SCREENING: f64 = 10.0;

/// Source heights [m].
pub const SOURCE_HEIGHT_ROAD: f64 = 0.05;    // CNOSSOS-EU §2.4.1
pub const SOURCE_HEIGHT_RAIL: f64 = 0.5;     // CNOSSOS-EU §2.7.1
pub const SOURCE_HEIGHT_INDUSTRIAL_OPEN: f64 = 1.5;
pub const SOURCE_HEIGHT_INDUSTRIAL_ENCLOSED: f64 = 4.0;

/// CNOSSOS road emission reference speed [km/h].
pub const V_REF_ROAD: f64 = 70.0;

/// Heavy vehicle speed cap [km/h] (Czech legal requirement, consistent with CNOSSOS).
pub const HEAVY_SPEED_CAP: f64 = 80.0;

/// Road surface corrections [dB] applied to rolling noise only.
pub const SURFACE_CORR: [f64; 5] = [
    0.0,  // 0: asphalt (reference)
    4.0,  // 1: sett/cobblestone
    4.0,  // 2: cobblestone/paving stones
    1.0,  // 3: concrete
    2.0,  // 4: gravel/unpaved
];
