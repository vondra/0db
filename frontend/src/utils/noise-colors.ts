/**
 * Noise level → display colour for UI swatches and text labels.
 *
 * Single source of truth is the map heatmap palette (`heatmap-palette.ts`):
 * `ldenToColor` is the opaque `#rrggbb` of the map cell at that Lden, so a
 * popup / table swatch reads as an exact legend for the map.
 */
import { paletteHex } from '../lib/heatmap-palette'

/** Lden (dBA) → opaque hex swatch colour, matching the map heatmap. */
export function ldenToColor(lden: number): string {
  return paletteHex(lden)
}
