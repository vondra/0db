/**
 * Noise level -> color mapping.
 * Smooth linear interpolation between color stops (color + alpha).
 * 0 dB = transparent, fades in through green, then yellow -> red -> purple.
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

export function ldenToRGBA(lden: number): [number, number, number, number] {
  if (lden < 0) return [0, 0, 0, 0]
  const stops = RGBA_STOPS
  if (lden >= stops[stops.length - 1][0]) {
    const s = stops[stops.length - 1]
    return [s[1], s[2], s[3], s[4]]
  }
  // Find the two surrounding stops
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

export function ldenToColor(lden: number): string {
  for (let i = COLOR_STOPS.length - 1; i >= 0; i--) {
    if (lden >= COLOR_STOPS[i][0]) return COLOR_STOPS[i][1]
  }
  return COLOR_STOPS[0][1]
}
