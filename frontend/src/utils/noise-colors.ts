/**
 * Noise level → display color: `ldenToColor` returns the hex of the nearest
 * stop at or below `lden` (discrete, no interpolation) — for UI swatches and
 * text. 0 dB green → yellow → red → purple (EuroNoise 2015 progression).
 */

const COLOR_STOPS: [number, string][] = [
  [ 0, '#024a1a'],
  [ 5, '#033e1b'],
  [10, '#064e24'],
  [15, '#0a5f2e'],
  [20, '#0e7038'],
  [25, '#148444'],
  [30, '#1a9850'],
  [35, '#45ab5c'],
  [40, '#78c46c'],
  [45, '#b2dd80'],
  [50, '#fee08b'],
  [55, '#fdae61'],
  [60, '#f46d43'],
  [65, '#d73027'],
  [70, '#a50026'],
  [75, '#7f0000'],
  [80, '#4a0022'],
  [85, '#3a0040'],
  [90, '#1a0033'],
]

export function ldenToColor(lden: number): string {
  for (let i = COLOR_STOPS.length - 1; i >= 0; i--) {
    if (lden >= COLOR_STOPS[i][0]) return COLOR_STOPS[i][1]
  }
  return COLOR_STOPS[0][1]
}
