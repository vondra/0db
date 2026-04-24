/**
 * Centralized metric definitions for noise popup tooltips.
 *
 * One entry per term with `label`, `description`, optional `standard`.
 * Structured for future i18n layer — copy is English for now (matches rest
 * of the app per CLAUDE.md "English everywhere" rule).
 */

export type MetricDef = {
  label: string
  /** Technical description: formulas, standards citations, fine print.
   * Used by the Noise Segments tab (pro debug) via `MetricLabel mode='technical'`. */
  description: string
  /** Public-facing description: plain language, no formulas, no jargon.
   * Used by the Noise Sources tab (public) via `MetricLabel mode='public'`
   * (default). Falls back to `description` when omitted. */
  descriptionPublic?: string
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
      "Annual Average Daily Traffic — vehicles per 24 h averaged over the year. Uses matched external traffic datasets where available, otherwise local service-road estimates or CNOSSOS road-class defaults.",
    standard: "Matched traffic datasets / service-tree estimate / CNOSSOS defaults",
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
      "Terrain diffraction via Maekawa/Fresnel (ISO 9613-2 §7.3/7.4), up to 3 edges from the upper convex hull of the DEM profile above line-of-sight. CNOSSOS §2.5.6(c) Rayleigh δ* gate zeroes bands where δ ≤ λ/4 − δ*. Combined with building/barrier screening in a single Fresnel pass (SPEC §3.5b, anti-double-count).",
    descriptionPublic:
      "A hill between the noise source and you reduces noise by diffracting sound over it. The taller and closer the hill, the more it helps.",
    standard: "ISO 9613-2 §7.3/7.4 + CNOSSOS-EU §2.5.6(c)",
  },
  screening: {
    label: "Screening",
    description:
      "Increment of the combined terrain + building + barrier diffraction over pure-terrain (A_terrain + A_screen ≡ A_combined, SPEC §3.5b — not a second independent Fresnel). The engine scans the Overture building raster + any explicit noise barriers along the path and merges the tallest top into the composite profile. One edge in the composite may be a bare-earth hill — UI labels it 'terrain' then.",
    descriptionPublic:
      "Buildings and noise barriers between the source and you reduce noise by blocking the direct line of sight.",
    standard: "ISO 9613-2 §7.3 + CNOSSOS-EU §2.5.6(c)",
  },
  vegetation: {
    label: "Vegetation",
    description:
      "Attenuation from dense forest along the sound path, integrated trapezoidally over the WorldCover forest raster. Capped at ~200 m effective depth per ISO 9613-2 Table A.1. Scalar × 0.5 Central-Europe calibration for the binary-forest raster.",
    descriptionPublic:
      "Trees between the source and you absorb some of the noise. Dense forest works best; scattered trees barely help.",
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
      "Aircraft popup is split into airborne and ground ops. Airborne uses Doc 29 empirical NPD tables from observed ADS-B flight events. Ground ops uses airport movement line sources with terrain, screening, and vegetation propagation so runway/taxi/apron activity can be read separately from overflights.",
    standard: "ECAC Doc 29 4th Edition",
  },
  distance: {
    label: "Distance",
    description:
      "Horizontal distance from the receiver point to the nearest microsegment of this source.",
  },
} as const

export type MetricTerm = keyof typeof METRIC_DEFS
