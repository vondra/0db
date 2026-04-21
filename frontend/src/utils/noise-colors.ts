/**
 * Noise level -> color mapping.
 * Smooth linear interpolation between color stops (color + alpha).
 * 0 dB = transparent, fades in through green, then yellow -> red -> purple.
 *
 * Per-call RGBA arrays are cached in a 0.1 dB LUT so deck.gl accessors
 * (which re-run per hex per data update) return a stable reference instead
 * of allocating a fresh tuple on every invocation.
 */

export const COLOR_STOPS: [number, string, number][] = [
  // 0 dB base + original EuroNoise 2015 (Tomio) color progression
  [ 0, '#024a1a', 153],
  [ 5, '#033e1b', 153],
  [10, '#064e24', 153],
  [15, '#0a5f2e', 153],
  [20, '#0e7038', 153],
  // 25+ dB: original EuroNoise 2015 colors
  [25, '#148444', 153],
  [30, '#1a9850', 153],
  [35, '#45ab5c', 153],
  [40, '#78c46c', 153],
  [45, '#b2dd80', 153],
  [50, '#fee08b', 153],
  [55, '#fdae61', 153],
  [60, '#f46d43', 153],
  [65, '#d73027', 153],
  [70, '#a50026', 153],
  [75, '#7f0000', 153],
  [80, '#4a0022', 153],
  [85, '#3a0040', 153],
  [90, '#1a0033', 153],
]

// Precomputed RGBA stops (parsed once at import time)
const RGBA_STOPS: [number, number, number, number, number][] = COLOR_STOPS.map(
  ([db, hex, a]) => [
    db,
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    a,
  ]
)

type RGBA = [number, number, number, number]

const TRANSPARENT: RGBA = [0, 0, 0, 0]

function interpolateLden(lden: number): RGBA {
  const stops = RGBA_STOPS
  if (lden >= stops[stops.length - 1][0]) {
    const s = stops[stops.length - 1]
    return [s[1], s[2], s[3], s[4]]
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (lden >= stops[i][0] && lden < stops[i + 1][0]) {
      const lo = stops[i]
      const hi = stops[i + 1]
      const t = (lden - lo[0]) / (hi[0] - lo[0])
      return [
        Math.round(lo[1] + t * (hi[1] - lo[1])),
        Math.round(lo[2] + t * (hi[2] - lo[2])),
        Math.round(lo[3] + t * (hi[3] - lo[3])),
        Math.round(lo[4] + t * (hi[4] - lo[4])),
      ]
    }
  }
  return [0, 0, 0, 0]
}

// LUT: 0.0 to 90.0 dB in 0.1 dB steps → 901 entries. Quantization is
// below the ~1 dB just-noticeable-difference; visually indistinguishable.
const LDEN_STEPS = 901
const LDEN_LUT: RGBA[] = new Array(LDEN_STEPS)
for (let i = 0; i < LDEN_STEPS; i++) {
  LDEN_LUT[i] = interpolateLden(i / 10)
}

export function ldenToRGBA(lden: number): RGBA {
  if (lden < 0) return TRANSPARENT
  const idx = Math.round(lden * 10)
  if (idx >= LDEN_STEPS) return LDEN_LUT[LDEN_STEPS - 1]
  return LDEN_LUT[idx]
}

export function ldenToColor(lden: number): string {
  for (let i = COLOR_STOPS.length - 1; i >= 0; i--) {
    if (lden >= COLOR_STOPS[i][0]) return COLOR_STOPS[i][1]
  }
  return COLOR_STOPS[0][1]
}

/** Diverging color scale for diff visualization (0db - SHM). */
export const DIFF_COLOR_STOPS: [number, string][] = [
  [-15, '#08519c'],
  [-10, '#3182bd'],
  [-5,  '#9ecae1'],
  [-2,  '#c6dbef'],
  [0,   '#2ca02c'],
  [2,   '#fee08b'],
  [5,   '#fdae61'],
  [10,  '#d73027'],
  [15,  '#7f0000'],
]

// Precomputed RGBA for diff stops (parsed once at import time)
export const DIFF_RGBA_STOPS: [number, number, number, number, number][] = DIFF_COLOR_STOPS.map(
  ([db, hex]) => [
    db,
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    180,
  ]
)

// Diff LUT: -20.0 to +20.0 dB in 0.1 dB steps → 401 entries.
// Stops are discrete (no interpolation), matching original diffToRGBA.
const DIFF_MIN_10 = -200
const DIFF_MAX_10 = 200
const DIFF_STEPS = DIFF_MAX_10 - DIFF_MIN_10 + 1
const DIFF_LUT: RGBA[] = new Array(DIFF_STEPS)
for (let i = 0; i < DIFF_STEPS; i++) {
  const diff = (i + DIFF_MIN_10) / 10
  const stops = DIFF_RGBA_STOPS
  let s = stops[0]
  for (let j = stops.length - 1; j >= 0; j--) {
    if (diff >= stops[j][0]) { s = stops[j]; break }
  }
  DIFF_LUT[i] = [s[1], s[2], s[3], s[4]]
}

export function diffToRGBA(diff: number): RGBA {
  const idx = Math.round(diff * 10) - DIFF_MIN_10
  if (idx < 0) return DIFF_LUT[0]
  if (idx >= DIFF_STEPS) return DIFF_LUT[DIFF_STEPS - 1]
  return DIFF_LUT[idx]
}
