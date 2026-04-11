/**
 * Centralized metric definitions for noise popup tooltips.
 *
 * One entry per term with `label`, `description`, optional `standard`.
 * Structured for future i18n layer — copy is English for now (matches rest
 * of the app per CLAUDE.md "English everywhere" rule).
 */

export type MetricDef = {
  label: string
  description: string
  standard?: string
}

export const METRIC_DEFS: Record<string, MetricDef> = {
  lden: {
    label: "Lden",
    description:
      "Day-Evening-Night weighted noise level over a 24-hour period. Evening gets a +5 dB penalty and night a +10 dB penalty to reflect annoyance.",
    standard: "EU Environmental Noise Directive 2002/49/EC",
  },
  emission: {
    label: "Emission",
    description:
      "Sound power level at the source before any propagation. For roads and railways, per-meter line-source emission from CNOSSOS-EU vehicle-count × speed coefficients.",
    standard: "CNOSSOS-EU Part 2",
  },
  aadt: {
    label: "Traffic",
    description:
      "Annual Average Daily Traffic — vehicles per 24 h averaged over the year. Sourced from Czech ŘSD CSD 2020 census where available, otherwise CNOSSOS road-class defaults.",
    standard: "CZ ŘSD CSD / CNOSSOS defaults",
  },
  trains: {
    label: "Trains/day",
    description:
      "Daily train count separated by passenger and freight. Sourced from CZPTT timetables and E-PRTR freight reports where available, otherwise defaults for the rail type.",
  },
  speed: {
    label: "Speed",
    description:
      "Speed value actually used in the CNOSSOS emission calculation. Normally the posted OSM maxspeed; defaults to a per-class value if no posted limit; roundabouts cap at 30 km/h.",
  },
  surface: {
    label: "Surface",
    description:
      "Road surface type. Applied as a per-frequency rolling-noise correction in CNOSSOS (asphalt = 0 dB reference, gravel ~+4 dB).",
    standard: "CNOSSOS-EU Annex II",
  },
  baseline: {
    label: "Baseline",
    description:
      "Sum of geometric divergence (distance losses), atmospheric absorption, and ground effect — the attenuation you get over flat uniform terrain.",
    standard: "ISO 9613-2 §7",
  },
  terrain: {
    label: "Terrain",
    description:
      "Attenuation from the ground blocking or diffracting the direct sound path (e.g. hills, embankments). Full-path DEM profile fed into Fresnel diffraction with C₃ frequency term.",
    standard: "ISO 9613-2 §7.3 with C₃",
  },
  screening: {
    label: "Screening",
    description:
      "Attenuation from the single dominant obstacle blocking the source→receiver line-of-sight — either a tall building or an explicit noise barrier. The engine picks the tallest sample along the path.",
    standard: "ISO 9613-2 §7.3, CNOSSOS-EU 3D δ geometry",
  },
  vegetation: {
    label: "Vegetation",
    description:
      "Attenuation from dense forest along the sound path. Capped at ~200 m effective depth per ISO 9613-2 Table A.1.",
    standard: "ISO 9613-2 §A.2.2",
  },
  per_band: {
    label: "Per-band levels",
    description:
      "Received level in each octave band from 63 Hz to 8 kHz (A-weighted). Useful for spectral comparison.",
  },
  segments: {
    label: "Segments",
    description:
      "Number of OSM microsegments the engine saw in the relevant radius, and their total length. One contributor aggregates all segments that share the same name/ref/class.",
  },
  aircraft: {
    label: "Aircraft",
    description:
      "Aircraft noise uses Doc 29 empirical NPD tables and is not subject to ISO 9613-2 propagation effects. Flights are binned by Lmax into disruptive / audible / faint bands.",
    standard: "ECAC Doc 29 4th Edition",
  },
  distance: {
    label: "Distance",
    description:
      "Horizontal distance from the receiver point to the nearest microsegment of this source.",
  },
} as const

export type MetricTerm = keyof typeof METRIC_DEFS
