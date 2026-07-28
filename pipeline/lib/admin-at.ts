/**
 * AdminAt — ONE point → country/city/continent resolver for the whole pipeline
 * (plan M2 §1: "country/city/continent are static attributes of geography →
 * resolve once, offline, per segment"), built on an indexed global CGAZ ADM0
 * part index. CGAZ is the single polygon authority; the Natural Earth table in
 * build-h3-admin.ts is retired (NE generalization mis-assigned the Hlučínsko
 * salient — see country-polygon.ts).
 *
 *   adminAt(lat, lon)        → { iso2 } — exact point-in-polygon over the
 *                              candidate parts of a global 1° grid; when no
 *                              polygon claims the point, a coastal fallback
 *                              accepts an ISO ONLY when uniquely attributable
 *                              (makeCoastalCountryGate semantics: over sea,
 *                              within COASTAL_BUFFER_M of exactly ONE
 *                              country's coast — never "first candidate
 *                              wins"); otherwise undefined.
 *   cityAt(lat, lon, iso2)   → metro id, gated by the resolved country (a
 *                              metro assigns only inside its own country).
 *   continentForIso(iso2)    → the ONE ISO→continent table
 *                              (scripts/iso-continent.mjs, shared with
 *                              gen-country-defaults-rs.mjs — no fork).
 *   antimeridianMidpoint/Lerp→ longitude interpolation that wraps at ±180°
 *                              (the naive (a+b)/2 maps a ±179.9 pair to ~0°).
 *
 * Antimeridian: CGAZ v6.0.0 splits every country's parts at ±180°, so per-part
 * bboxes are naive-safe — EXCEPT one Antarctica artifact edge that crosses the
 * seam (verified 2026-07-27: the only seam-crossing ring in the release; it
 * winds 386° around the pole AND carries pole-spike artifact edges, which
 * defeat both unwrapped-lon and meridian-ray parity). Seam-crossing parts are
 * ray-cast in an azimuthal projection about their pole — a homeomorphism of
 * the polar hemisphere, so the projected ring is an ordinary simple closed
 * curve and plain 2D PIP is exact. Everything else uses the shared banded
 * IndexedRing from country-polygon.ts.
 *
 * Disputed areas (CGAZ numeric shapeGroup codes, no ISO identity) ARE indexed:
 *  the three road-bearing ones are policy-mapped to their administering
 *  country (DISPUTED_SHAPEGROUP_ISO below: Falklands → FK, Aksai Chin → CN,
 *  Abyei → SD); any other disputed land resolves iso2=undefined with NO
 *  coastal fallback (it is land, not sea) — mirroring
 *  makeCoastalCountryGate's inAnyCountry rejection.
 *
 * The index builds lazily on first query (one 95 MB GeoJSON parse + ring
 * indexing, process-wide memo — same regime as country-polygon.ts).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pointInRing, wrapLonDeltaDeg } from './spatial.js'
import {
  ISO2_TO_ISO3,
  cgazLandIndex,
  coastShapeGroupsWithin,
  inIndexedRings,
  type IndexedRing,
} from './country-polygon.js'
import { isoContinent } from '../../scripts/iso-continent.mjs'

type Ring = ReadonlyArray<readonly [number, number]>

/** Sea buffer of the coastal fallback — mirrors makeCoastalCountryGate's
 *  default: piers/reclaimed land sit metres outside the 55 m-simplified CGAZ
 *  coastline; straits narrower than 2× this stay unassigned. */
export const COASTAL_BUFFER_M = 2000

const ISO3_TO_ISO2: Record<string, string> = Object.fromEntries(
  Object.entries(ISO2_TO_ISO3).map(([a2, a3]) => [a3, a2]),
)

/** Disputed CGAZ shapeGroups (numeric, no ISO identity) the project assigns
 *  by policy — dropping them to WORLD lost 15 road-bearing hexes in the
 *  2026-07 bin replay (/gg M2): Falklands (GB claim), Aksai Chin (administered
 *  by CN — G219 runs through it), Abyei (administered by SD). Codes verified
 *  against CGAZ v6.0.0 by point probe 2026-07-28. */
const DISPUTED_SHAPEGROUP_ISO: Record<string, string> = {
  '111': 'SD', // Abyei
  '112': 'CN', // Aksai Chin
  '117': 'FK', // Falkland Islands / Islas Malvinas
}

// ── Global part index ────────────────────────────────────────────────────────

type Part = {
  iso3: string
  iso2: string | undefined // undefined for disputed numeric shapeGroups
  s: number
  n: number
  w: number
  e: number
  /** false → `ring` is a raw-lon IndexedRing (banded fast path);
   *  true → `projOuter`/`projHoles` (polar-projected) are tested with plain
   *  2D ray-casting. */
  seam: boolean
  ring: IndexedRing | null
  projOuter: Ring | null
  projHoles: Ring[] | null
  poleSign: 1 | -1 // +1 = south-pole projection, -1 = north
}

const CELL_DEG = 1
const GRID_W = 360 / CELL_DEG
const GRID_H = 180 / CELL_DEG

let parts: Part[] | null = null
let grid: Map<number, number[]> | null = null

function ringCrossesSeam(ring: Ring): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) return true
  }
  return false
}

/**
 * Azimuthal projection about a pole: r = 90 ∓ lat grows monotonically with
 * distance from the pole, so it is a homeomorphism of the polar hemisphere —
 * a seam-crossing, pole-ENCLOSING ring (CGAZ's Antarctica ring winds 386°
 * around the pole and even carries pole-spike artifact edges, measured
 * 2026-07-27) becomes an ordinary simple closed curve in this plane, where
 * plain 2D ray-casting is exactly correct. Unwrapped-lon ray-casting breaks
 * parity on >360° windings; meridian-ray tricks break on the pole spikes.
 */
function projectPolar(lat: number, lon: number, poleSign: 1 | -1): [number, number] {
  const r = poleSign > 0 ? 90 + lat : 90 - lat
  const a = (lon * Math.PI) / 180
  return [r * Math.cos(a), r * Math.sin(a)]
}

function projectRing(ring: Ring, poleSign: 1 | -1): [number, number][] {
  return ring.map(([x, y]) => projectPolar(y, x, poleSign))
}

function cellKey(ix: number, iy: number): number {
  return iy * GRID_W + ix
}

function insert(gridMap: Map<number, number[]>, pi: number, w: number, s: number, e: number, n: number): void {
  const x0 = Math.max(0, Math.floor((w + 180) / CELL_DEG))
  const x1 = Math.min(GRID_W - 1, Math.floor((e + 180) / CELL_DEG))
  const y0 = Math.max(0, Math.floor((s + 90) / CELL_DEG))
  const y1 = Math.min(GRID_H - 1, Math.floor((n + 90) / CELL_DEG))
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const k = cellKey(ix, iy)
      const b = gridMap.get(k)
      if (b) b.push(pi)
      else gridMap.set(k, [pi])
    }
  }
}

function buildIndex(): void {
  parts = []
  grid = new Map()
  for (const { iso3, idx } of cgazLandIndex()) {
    const iso2 = ISO3_TO_ISO2[iso3]
    for (const r of idx) {
      const pi = parts.length
      if (!ringCrossesSeam(r.outer)) {
        parts.push({ iso3, iso2, s: r.s, n: r.n, w: r.w, e: r.e, seam: false, ring: r, projOuter: null, projHoles: null, poleSign: 1 })
        insert(grid, pi, r.w, r.s, r.e, r.n)
        continue
      }
      // Seam-crossing part (CGAZ v6.0.0: one Antarctica artifact edge — a ring
      // winding 386° around the pole). Its raw bbox spans all longitudes, so
      // it lands in every cell of its lat band; membership is decided by 2D
      // ray-casting in the polar projection.
      let latSum = 0
      for (const [, y] of r.outer) latSum += y
      const poleSign: 1 | -1 = latSum / r.outer.length < 0 ? 1 : -1
      parts.push({
        iso3, iso2, s: r.s, n: r.n, w: -180, e: 180, seam: true, ring: null,
        projOuter: projectRing(r.outer, poleSign),
        projHoles: r.holes.map((h) => projectRing(h, poleSign)),
        poleSign,
      })
      insert(grid, pi, -180, r.s, 180, r.n)
    }
  }
}

function inPart(p: Part, lat: number, lon: number): boolean {
  if (lat < p.s || lat > p.n) return false
  if (!p.seam) {
    if (lon < p.w || lon > p.e) return false
    return inIndexedRings([p.ring!], lat, lon)
  }
  const [px, py] = projectPolar(lat, lon, p.poleSign)
  if (!pointInRing(px, py, p.projOuter!)) return false
  return !p.projHoles!.some((h) => pointInRing(px, py, h))
}

/** The CGAZ part claiming the point, or null when no polygon covers it
 *  (sea). CGAZ ADM0 is non-overlapping, so the first hit IS the answer. */
function claimantPart(lat: number, lon: number): Part | null {
  if (!parts || !grid) buildIndex()
  const ix = Math.min(GRID_W - 1, Math.max(0, Math.floor((lon + 180) / CELL_DEG)))
  const iy = Math.min(GRID_H - 1, Math.max(0, Math.floor((lat + 90) / CELL_DEG)))
  for (const pi of grid!.get(cellKey(ix, iy)) ?? []) {
    if (inPart(parts![pi], lat, lon)) return parts![pi]
  }
  return null
}

/** The claiming part's CGAZ shapeGroup (ISO3, or the numeric code of a
 *  disputed area), or null over sea. Strict land membership only — no
 *  coastal fallback; used by the bake invariant (enrich-roads-country.ts)
 *  which needs the "is this even land?" verdict independent of `adminAt`'s
 *  policy layer. */
export function claimantShapeGroup(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180
  const hit = claimantPart(lat, wrappedLon)
  return hit ? hit.iso3 : null
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AdminAtResult {
  /** ISO 3166-1 alpha-2 of the country at the point; undefined over open sea,
   *  strait-ambiguous sea points, disputed areas, and unclaimed land. */
  iso2: string | undefined
}

export function adminAt(lat: number, lon: number): AdminAtResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return { iso2: undefined }
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180
  const hit = claimantPart(lat, wrappedLon)
  // Policy-mapped disputed land counts as its administering country;
  // unmapped disputed land → undefined, NO coastal fallback (it is land).
  if (hit !== null) return { iso2: hit.iso2 ?? DISPUTED_SHAPEGROUP_ISO[hit.iso3] }
  // Sea point: accept a country only when uniquely attributable — exactly one
  // coast within the buffer (zero = open sea, ≥2 = strait ambiguity).
  const near = coastShapeGroupsWithin(lat, wrappedLon, COASTAL_BUFFER_M)
  if (near.length !== 1) return { iso2: undefined }
  // A lone coast: mapped disputed shapeGroup counts as its administering
  // country (Falklands shore → FK), anything else maps ISO3→ISO2.
  return { iso2: ISO3_TO_ISO2[near[0]] ?? DISPUTED_SHAPEGROUP_ISO[near[0]] }
}

// ── Metros ───────────────────────────────────────────────────────────────────

interface Metro {
  id: number
  name: string
  country: string // ISO alpha-2 — a metro assigns only inside its own country
  polygon: [number, number][] // [[lon, lat], …] closed ring (rectangles today)
}

let metros: Metro[] | null = null
function metroList(): Metro[] {
  if (!metros) {
    metros = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'scripts', 'h3-admin-metros.json'), 'utf-8')) as { metros: Metro[] }).metros
  }
  return metros
}

/** Metro id at the point, gated by the RESOLVED country: a metro rectangle
 *  assigns only when the point's country matches the metro's own — a border
 *  hex centroid that landed in a neighbour's rectangle slice must not inherit
 *  the metro. 0 = no metro. */
export function cityAt(lat: number, lon: number, iso2: string | undefined): number {
  if (iso2 === undefined) return 0
  for (const m of metroList()) {
    if (m.country !== iso2) continue
    if (pointInRing(lon, lat, m.polygon)) return m.id
  }
  return 0
}

// ── Continent (ONE table — scripts/iso-continent.mjs) ────────────────────────

/** Continent NAME for an ISO alpha-2 ('Europe' | 'NorthAmerica' |
 *  'SouthAmerica' | 'Asia' | 'Africa' | 'Oceania'), matching
 *  engine/noise-compute/src/admin.rs::Continent variants; undefined when the
 *  table has no entry (e.g. AQ — engine treats it as Continent::Unknown). */
export function continentForIso(iso2: string): string | undefined {
  return isoContinent(iso2) ?? undefined
}

// ── Antimeridian-safe longitude interpolation ────────────────────────────────

/** Point at fraction `t` between (lat1, lon1) and (lat2, lon2), interpolating
 *  longitude the SHORT way around the globe (wraps at ±180°): the naive
 *  `(a+b)/2` maps a ±179.9° pair to ~0° instead of ±180°. Use wherever new
 *  code derives midpoints/interior samples from lon/lat pairs. */
export function antimeridianLerp(
  lat1: number, lon1: number, lat2: number, lon2: number, t: number,
): [number, number] {
  const lon = lon1 + t * wrapLonDeltaDeg(lon2 - lon1)
  return [lat1 + t * (lat2 - lat1), lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon]
}

/** Antimeridian-safe midpoint — antimeridianLerp at t = 0.5. */
export function antimeridianMidpoint(lat1: number, lon1: number, lat2: number, lon2: number): [number, number] {
  return antimeridianLerp(lat1, lon1, lat2, lon2, 0.5)
}
