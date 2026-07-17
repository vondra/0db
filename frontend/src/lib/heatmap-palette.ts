/**
 * dBA → RGBA palette for the map heatmap (HM3 tile rendering).
 *
 * The server now serves raw HM3 byte tiles and renders no PNG, so this
 * ramp no longer has to track a server-side palette. See [`STOPS`].
 */

// Weninger, "A Color Scheme for the Presentation of Sound Immission in
// Maps", EuroNoise 2015 (user-tested, 232 respondents) — the 10 colors and
// opacities below are reused unmodified, hex for hex, dB for dB. Weninger's
// own scheme is scoped to 35-80 dB: below 35 dB is "no color" (renders
// transparent here, via the sub-floor check in paletteColor), and 80 dB is
// the terminal color — above it the ramp clamps flat (lerpStop's fallback),
// not a further, invented shade. Owner 2026-07-17: tried on the live map
// without the earlier low/high-end extension (dropped 2026-07-16) to see
// the paper's scale as designed, unaltered.
const STOPS: { db: number; rgb: readonly [number, number, number]; op: number }[] = [
  { db: 35, rgb: [0xA0, 0xBA, 0xBF], op: 0.20 },
  { db: 40, rgb: [0xB8, 0xD6, 0xD1], op: 0.26 },
  { db: 45, rgb: [0xCE, 0xE4, 0xCC], op: 0.32 },
  { db: 50, rgb: [0xE2, 0xF2, 0xBF], op: 0.38 },
  { db: 55, rgb: [0xF3, 0xC6, 0x83], op: 0.46 },
  { db: 60, rgb: [0xE8, 0x7E, 0x4D], op: 0.54 },
  { db: 65, rgb: [0xCD, 0x46, 0x3E], op: 0.62 },
  { db: 70, rgb: [0xA1, 0x1A, 0x4D], op: 0.69 },
  { db: 75, rgb: [0x75, 0x08, 0x5C], op: 0.75 },
  { db: 80, rgb: [0x43, 0x0A, 0x4A], op: 0.80 },
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
