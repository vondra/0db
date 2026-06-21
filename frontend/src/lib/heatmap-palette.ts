/**
 * dBA → RGBA palette for the map heatmap (HM3 tile rendering).
 *
 * The server now serves raw HM3 byte tiles and renders no PNG, so this
 * ramp no longer has to track a server-side palette. The 15 stops below
 * are tuned for legibility over a light basemap (see [`STOPS`]).
 */

// Aggressive opacity ramp so the heatmap is *legible* over light
// basemap tiles. The original heatmap-v2 ramp ran 0.06–0.12 below
// 30 dB and 0.20–0.38 below 50 dB — those alpha values vanished
// against OSM. Sub-15 dB still maps transparent since the cells
// below the noise-atlas relevance floor would just fog the basemap.
const STOPS: { db: number; rgb: readonly [number, number, number]; op: number }[] = [
  { db: 15, rgb: [0xDD, 0xEC, 0xF0], op: 0.25 },
  { db: 25, rgb: [0xC3, 0xDA, 0xDE], op: 0.45 },
  { db: 35, rgb: [0xA0, 0xBA, 0xBF], op: 0.60 },
  { db: 40, rgb: [0xB8, 0xD6, 0xD1], op: 0.68 },
  { db: 45, rgb: [0xCE, 0xE4, 0xCC], op: 0.74 },
  { db: 50, rgb: [0xE2, 0xF2, 0xBF], op: 0.80 },
  { db: 55, rgb: [0xF3, 0xC6, 0x83], op: 0.84 },
  { db: 60, rgb: [0xE8, 0x7E, 0x4D], op: 0.87 },
  { db: 65, rgb: [0xCD, 0x46, 0x3E], op: 0.89 },
  { db: 70, rgb: [0xA1, 0x1A, 0x4D], op: 0.91 },
  { db: 75, rgb: [0x75, 0x08, 0x5C], op: 0.93 },
  { db: 80, rgb: [0x43, 0x0A, 0x4A], op: 0.95 },
  { db: 90, rgb: [0x20, 0x00, 0x19], op: 0.97 },
]

const NO_COLOR: [number, number, number, number] = [0, 0, 0, 0]

/** Interpolate the STOPS ramp at `db` (caller clamps to ≥ STOPS[0].db).
 *  Returns RGB plus the 0–1 opacity so callers take what they need. */
function lerpStop(db: number): { rgb: [number, number, number]; op: number } {
  for (let i = 1; i < STOPS.length; i++) {
    const next = STOPS[i]
    if (db <= next.db) {
      const prev = STOPS[i - 1]
      const t = (db - prev.db) / (next.db - prev.db)
      return {
        rgb: [
          Math.round(prev.rgb[0] + t * (next.rgb[0] - prev.rgb[0])),
          Math.round(prev.rgb[1] + t * (next.rgb[1] - prev.rgb[1])),
          Math.round(prev.rgb[2] + t * (next.rgb[2] - prev.rgb[2])),
        ],
        op: prev.op + t * (next.op - prev.op),
      }
    }
  }
  const last = STOPS[STOPS.length - 1]
  return { rgb: [...last.rgb], op: last.op }
}

/** Interpolated dB → [r, g, b, a] (0-255 each). Sub-floor renders transparent. */
function paletteColor(db: number): [number, number, number, number] {
  if (!Number.isFinite(db)) return NO_COLOR
  // Sub-floor cells render transparent — see [`STOPS`] header.
  if (db < STOPS[0].db) return NO_COLOR
  const { rgb, op } = lerpStop(db)
  return [rgb[0], rgb[1], rgb[2], Math.round(255 * op)]
}

/**
 * Solid `#rrggbb` at a dB level, from the SAME stops as the map heatmap —
 * a UI swatch is then an exact legend for the map cell. Opacity is dropped
 * (swatches are opaque); sub-floor / non-finite clamp to the lightest stop
 * so a swatch always has a colour.
 */
export function paletteHex(db: number): string {
  const clamped = Number.isFinite(db) ? Math.max(db, STOPS[0].db) : STOPS[0].db
  const { rgb } = lerpStop(clamped)
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
}

/**
 * Pre-computed `u8 × 0.5 dB → RGBA` lookup. Indexing `LUT[byte * 4 + c]`
 * is one memory hit per pixel; the per-tile decoder loop hits it
 * `TILE_PX² = 65 536` times so the avoided palette interpolation is
 * the bulk of decode cost. Size: 256 × 4 = 1 KB, cache-resident.
 *
 * Byte `255` (no-data sentinel) maps to fully transparent.
 */
export const PALETTE_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let byte = 0; byte < 255; byte++) {
    const db = byte / 2
    const [r, g, b, a] = paletteColor(db)
    lut[byte * 4] = r
    lut[byte * 4 + 1] = g
    lut[byte * 4 + 2] = b
    lut[byte * 4 + 3] = a
  }
  // byte 255 = NO_DATA → fully transparent (already zero from init).
  return lut
})()
