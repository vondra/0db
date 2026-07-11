//! Chain-run scope: `country:CZ` | `bbox:S,W,N,E` | `world` → a resolved bbox
//! LIST + country identity the runner uses to (a) select which manifest steps
//! apply and (b) parameterize bbox-taking steps (per-bbox step fan-out; the
//! auditor takes the whole list). Country bboxes are DERIVED from the CGAZ
//! ADM0 polygons (same source lib/country-polygon.ts gates with — one geometry
//! truth, no hand-maintained bbox table) and memoised to a JSON cache so a
//! dry-run doesn't pay the 95 MB GeoJSON parse twice.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'

/** [minLat, minLon, maxLat, maxLon] — the S,W,N,E order every pipeline --bbox flag takes. */
export type Bbox = readonly [number, number, number, number]

export interface ResolvedScope {
  kind: 'country' | 'bbox' | 'world'
  /** ISO2 (upper) for country scope, else null. */
  iso2: string | null
  /** The bbox LIST the scope covers: per-polygon padded bboxes for country
   *  scope (coalesced, NEVER the union envelope — FR's union spans 82% of the
   *  planet via overseas territories), the literal bbox for bbox scope, null
   *  for world. Every enumeration/parameterization iterates this list. */
  bboxes: Bbox[] | null
  /** Human label for logs ("country:CZ [48.15,11.69,51.46,19.26]"). Display
   *  only — argv serialization uses serializeBbox (full precision). */
  label: string
  /** Exact scope identity string ("world" | "country:CZ" | "bbox:<exact>") —
   *  what the gate baseline and the resume plan digest are keyed on. */
  canonical: string
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const CGAZ_GEOJSON = resolve(REPO_ROOT, 'scripts', 'cache', 'geoBoundariesCGAZ_ADM0_s0005.geojson')
// Per-POLYGON bboxes (one country = many outer rings: mainland + islands +
// overseas territories). Scope-intersection tests MUST use the per-polygon
// list — the union bbox of FR/GB/NO spans half the globe via territories and
// would drag them into every bbox scope on Earth.
const BBOX_CACHE = resolve(REPO_ROOT, 'scripts', 'cache', 'country-polygon-bboxes-cgaz-v6-s0005.json')

/**
 * Pad applied around a country's CGAZ bbox before hex enumeration. WHY 0.4°:
 * `iterateCountryHexes` selects hexes by CENTROID-in-bbox, and an H3 r4 hex is
 * ~22 km across — a border hex whose centroid sits just outside the polygon
 * bbox still holds in-country roads. National enrichers hand-pad the same way
 * (enrich-roads-cz.ts CZ_HEX_BBOX pads CGAZ CZ by ~0.35–0.42°).
 */
export const COUNTRY_BBOX_PAD_DEG = 0.4

// ISO2 → ISO3 for CGAZ `shapeGroup` lookup — the gate module's own table, so
// scope and gates can never disagree about a country's identity.
import { ISO2_TO_ISO3 } from '../lib/country-polygon.js'

type CgazFeature = { properties: { shapeGroup?: string }; geometry: { type: string; coordinates: unknown } }

/** Per-polygon bboxes of every CGAZ country, from cache or a one-time parse. */
function loadCountryPolygonBboxes(): Record<string, Bbox[]> {
  if (existsSync(BBOX_CACHE)) {
    return JSON.parse(readFileSync(BBOX_CACHE, 'utf8')) as Record<string, Bbox[]>
  }
  if (!existsSync(CGAZ_GEOJSON)) {
    throw new Error(
      `country bbox derivation needs ${CGAZ_GEOJSON} — it is derived on demand by lib/country-polygon.ts ` +
        `(any enricher that gates by country creates it); run one of those once, or check scripts/cache/.`,
    )
  }
  const features = (JSON.parse(readFileSync(CGAZ_GEOJSON, 'utf8')) as { features: CgazFeature[] }).features
  const out: Record<string, Bbox[]> = {}
  const iso3to2 = new Map(Object.entries(ISO2_TO_ISO3).map(([a2, a3]) => [a3, a2]))
  const ringBbox = (ring: Array<[number, number]>): Bbox => {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
    for (const [lon, lat] of ring) {
      if (lat < s) s = lat
      if (lat > n) n = lat
      if (lon < w) w = lon
      if (lon > e) e = lon
    }
    return [s, w, n, e]
  }
  for (const f of features) {
    const iso2 = iso3to2.get(String(f.properties.shapeGroup ?? ''))
    if (!iso2) continue // numeric disputed-area codes — no ISO identity, no enricher
    const boxes: Bbox[] = []
    const g = f.geometry
    if (g.type === 'Polygon') boxes.push(ringBbox((g.coordinates as Array<Array<[number, number]>>)[0]))
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates as Array<Array<Array<[number, number]>>>) boxes.push(ringBbox(poly[0]))
    out[iso2] = boxes
  }
  // tmp + rename: an interrupted write must not leave a truncated cache that
  // existsSync would accept on the next run (same idiom as country-polygon.ts).
  writeFileSync(`${BBOX_CACHE}.tmp`, JSON.stringify(out))
  renameSync(`${BBOX_CACHE}.tmp`, BBOX_CACHE)
  return out
}

let bboxes: Record<string, Bbox[]> | null = null

/** Per-polygon CGAZ bboxes for an ISO2 country. Throws on unknown codes — fail
 *  loud, a silent world fallback would quietly widen a scope to the planet. */
export function countryPolygonBboxes(iso2: string): Bbox[] {
  bboxes ??= loadCountryPolygonBboxes()
  const b = bboxes[iso2.toUpperCase()]
  if (!b || b.length === 0) throw new Error(`no CGAZ bbox for country '${iso2}' — unknown ISO2 or a dependent territory absent from CGAZ ADM0`)
  return b
}

/** True iff ANY of the country's polygon bboxes intersects `bbox`. */
export function countryIntersectsBbox(iso2: string, bbox: Bbox): boolean {
  return countryPolygonBboxes(iso2).some((b) => bboxIntersects(b, bbox))
}

const bboxArea = (b: Bbox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const bboxContains = (outer: Bbox, inner: Bbox) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
const bboxUnion = (a: Bbox, b: Bbox): Bbox =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]

/**
 * Bounded-waste coalesce: merge two boxes only when their union envelope adds
 * at most COALESCE_SLACK of their summed area. WHY: FR has 204 CGAZ polygons
 * (US 285) — one chain step per raw islet bbox is plan noise, but the naive
 * fix (one union envelope) is the exact bug this list exists to prevent: FR's
 * envelope covers 82% of the planet and generic write passes would touch every
 * country in it. Bounded waste keeps mainland+near-islands as one box while
 * scattered territories stay separate. Over-padding into ocean is ~free (h3r4
 * only materializes hex dirs where data exists); the harm being bounded is
 * dragging FOREIGN LAND into a generic pass's bbox.
 */
const COALESCE_SLACK = 0.5

function coalesceBboxes(boxes: Bbox[]): Bbox[] {
  const out: Bbox[] = []
  for (const b of boxes) {
    if (out.some((o) => bboxContains(o, b))) continue
    out.push(b)
  }
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const u = bboxUnion(out[i], out[j])
        if (bboxArea(u) <= (bboxArea(out[i]) + bboxArea(out[j])) * (1 + COALESCE_SLACK)) {
          out[i] = u
          out.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return out
}

const padBbox = (b: Bbox): Bbox => [
  Math.max(-90, b[0] - COUNTRY_BBOX_PAD_DEG),
  Math.max(-180, b[1] - COUNTRY_BBOX_PAD_DEG),
  Math.min(90, b[2] + COUNTRY_BBOX_PAD_DEG),
  Math.min(180, b[3] + COUNTRY_BBOX_PAD_DEG),
]

/** Per-polygon padded bboxes for a COUNTRY scope, coalesced. This is the list
 *  every chain enumeration iterates — the union envelope is deliberately not
 *  derivable from this module anymore. */
export function countryBboxesPadded(iso2: string): Bbox[] {
  return coalesceBboxes(countryPolygonBboxes(iso2).map(padBbox))
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** DISPLAY label only (2 dp) — never feed this back into argv: a sub-0.01°
 *  bbox would collapse to S==N and the child would reject or over-scan. */
export function formatBbox(b: Bbox): string {
  return b.map(round2).join(',')
}

/** EXACT argv serializer — full double precision, Number↔String round-trips
 *  losslessly. Every `--bbox` a chain step receives goes through this. */
export function serializeBbox(b: Bbox): string {
  return b.map(String).join(',')
}

/** Parse the --scope value. Accepts `country:CZ`, `bbox:S,W,N,E`, `world`. */
export function parseScope(raw: string): ResolvedScope {
  if (raw === 'world') return { kind: 'world', iso2: null, bboxes: null, label: 'world', canonical: 'world' }
  const country = /^country:([A-Za-z]{2})$/.exec(raw)
  if (country) {
    const iso2 = country[1].toUpperCase()
    const bboxes = countryBboxesPadded(iso2)
    const label =
      bboxes.length === 1
        ? `country:${iso2} [${formatBbox(bboxes[0])}]`
        : `country:${iso2} [${bboxes.length} polygon bboxes]`
    return { kind: 'country', iso2, bboxes, label, canonical: `country:${iso2}` }
  }
  const m = /^bbox:(.+)$/.exec(raw)
  if (m) {
    const parts = m[1].split(',').map(Number)
    if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x)) || parts[0] >= parts[2] || parts[1] >= parts[3]) {
      throw new Error(`invalid bbox scope '${raw}' — expected bbox:S,W,N,E with S<N and W<E`)
    }
    const bbox = parts as unknown as Bbox
    return { kind: 'bbox', iso2: null, bboxes: [bbox], label: `bbox [${formatBbox(bbox)}]`, canonical: `bbox:${serializeBbox(bbox)}` }
  }
  throw new Error(`invalid --scope '${raw}' — expected country:CC | bbox:S,W,N,E | world`)
}
