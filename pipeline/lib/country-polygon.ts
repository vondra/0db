/**
 * High-resolution country point-in-polygon gate from geoBoundaries CGAZ ADM0
 * (`scripts/cache/geoBoundariesCGAZ_ADM0_s0005.geojson`, derived on demand from
 * the release GeoPackage pinned at tag v6.0.0 — see below).
 *
 * Use to stop an enricher writing one country's data onto another country's roads
 * where a rectangular `*_HEX_BBOX` overlaps a neighbour: Poland's bbox blankets
 * most of Czechia, so a Czech "I/150" was matched to Polish "DW150" and given
 * Polish AADT (see the Stage-3 road audit). Gate the match by the road midpoint's
 * actual country.
 *
 * Why CGAZ and not Natural Earth 1:10m (the previous source): NE generalization
 * mis-assigns multi-km border salients — the Hlučínsko salient (Czech soil,
 * 49.98953 N 18.12880 E, ~4.5 km inside CZ) tested Poland-true, so the PL gate
 * legitimately wrote Polish AADT onto Czech roads there. geoBoundaries CGAZ is
 * OSM-derived, globally gap-filled, CC-BY 4.0 (atlas attribution: boundaries ©
 * geoBoundaries — Runfola et al. 2020, doi:10.1371/journal.pone.0231866); all
 * CZ salients verified correct (Hlučínsko, Šluknov, Frýdlant, Bogatynia).
 *
 * On-demand derivation (first run on a fresh host; needs curl + GDAL's ogr2ogr,
 * `apt install gdal-bin`): download the 162 MB GeoPackage, then one-time-convert
 * to a 95 MB GeoJSON with `-simplify 0.0005` (~55 m Douglas-Peucker — full CGAZ
 * rings are 8-15x denser, parse 3.6 s and cost ~200 µs/gate-call for fidelity the
 * gate doesn't need; the 55 m band flips 0.06 % of points vs full, measured on a
 * 111 m grid over Hlučínsko) and `COORDINATE_PRECISION=6` (~0.1 m). The GeoPackage
 * is kept beside the GeoJSON so the tolerance can be retuned without re-download.
 *
 * This is an actual-polygon gate — NOT `h3r4-admin.bin`, which is H3 res-4
 * (~22 km, centroid-based) and far too coarse to separate roads at a border.
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pointInRing, pointToSegmentDist } from './spatial.js'

const CACHE_DIR = resolve(import.meta.dirname, '..', '..', 'scripts', 'cache')
const CGAZ_GPKG = resolve(CACHE_DIR, 'geoBoundariesCGAZ_ADM0.gpkg')
const CGAZ_GEOJSON = resolve(CACHE_DIR, 'geoBoundariesCGAZ_ADM0_s0005.geojson')
// Pinned release tag, not `main`: boundaries silently moving under a data gate
// would make enrichment runs irreproducible.
const CGAZ_URL = 'https://github.com/wmgeolab/geoBoundaries/raw/v6.0.0/releaseData/CGAZ/geoBoundariesCGAZ_ADM0.gpkg'

type CgazFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }
let features: ReadonlyArray<CgazFeature> | null = null
function cgazFeatures(): ReadonlyArray<CgazFeature> {
  if (features) return features
  if (!existsSync(CGAZ_GEOJSON)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    // tmp + rename so an interrupted download/convert can't leave a truncated
    // file that existsSync would happily accept on the next run
    if (!existsSync(CGAZ_GPKG)) {
      execFileSync('curl', ['-fsSL', '--max-time', '600', CGAZ_URL, '-o', `${CGAZ_GPKG}.tmp`])
      renameSync(`${CGAZ_GPKG}.tmp`, CGAZ_GPKG)
    }
    try {
      execFileSync('ogr2ogr', ['-f', 'GeoJSON', `${CGAZ_GEOJSON}.tmp`, CGAZ_GPKG,
        '-select', 'shapeGroup', '-simplify', '0.0005', '-lco', 'COORDINATE_PRECISION=6'])
    } catch (e) {
      throw new Error(`country-polygon: ogr2ogr conversion failed — is GDAL installed (apt install gdal-bin)? ${e}`)
    }
    renameSync(`${CGAZ_GEOJSON}.tmp`, CGAZ_GEOJSON)
  }
  return (features = JSON.parse(readFileSync(CGAZ_GEOJSON, 'utf8')).features)
}

// CGAZ keys countries by ISO 3166-1 alpha-3 (`shapeGroup`); callers use alpha-2.
// Exactly the 199 alpha-3 codes present in CGAZ ADM0 v6.0.0 (its remaining 19
// features are numeric US-DoS disputed-area codes with no ISO identity).
// Dependent territories with their own alpha-2 (HK, PR, GI, …) are not separate
// CGAZ features — they are absent here and fail loud below by design.
const ISO2_TO_ISO3: Record<string, string> = {
  AD: 'AND', AE: 'ARE', AF: 'AFG', AG: 'ATG', AL: 'ALB', AM: 'ARM', AO: 'AGO', AQ: 'ATA',
  AR: 'ARG', AT: 'AUT', AU: 'AUS', AZ: 'AZE', BA: 'BIH', BB: 'BRB', BD: 'BGD', BE: 'BEL',
  BF: 'BFA', BG: 'BGR', BH: 'BHR', BI: 'BDI', BJ: 'BEN', BN: 'BRN', BO: 'BOL', BR: 'BRA',
  BS: 'BHS', BT: 'BTN', BW: 'BWA', BY: 'BLR', BZ: 'BLZ', CA: 'CAN', CD: 'COD', CF: 'CAF',
  CG: 'COG', CH: 'CHE', CI: 'CIV', CL: 'CHL', CM: 'CMR', CN: 'CHN', CO: 'COL', CR: 'CRI',
  CU: 'CUB', CV: 'CPV', CY: 'CYP', CZ: 'CZE', DE: 'DEU', DJ: 'DJI', DK: 'DNK', DM: 'DMA',
  DO: 'DOM', DZ: 'DZA', EC: 'ECU', EE: 'EST', EG: 'EGY', EH: 'ESH', ER: 'ERI', ES: 'ESP',
  ET: 'ETH', FI: 'FIN', FJ: 'FJI', FM: 'FSM', FR: 'FRA', GA: 'GAB', GB: 'GBR', GD: 'GRD',
  GE: 'GEO', GH: 'GHA', GL: 'GRL', GM: 'GMB', GN: 'GIN', GQ: 'GNQ', GR: 'GRC', GT: 'GTM',
  GW: 'GNB', GY: 'GUY', HN: 'HND', HR: 'HRV', HT: 'HTI', HU: 'HUN', ID: 'IDN', IE: 'IRL',
  IL: 'ISR', IN: 'IND', IQ: 'IRQ', IR: 'IRN', IS: 'ISL', IT: 'ITA', JM: 'JAM', JO: 'JOR',
  JP: 'JPN', KE: 'KEN', KG: 'KGZ', KH: 'KHM', KI: 'KIR', KM: 'COM', KN: 'KNA', KP: 'PRK',
  KR: 'KOR', KW: 'KWT', KZ: 'KAZ', LA: 'LAO', LB: 'LBN', LC: 'LCA', LI: 'LIE', LK: 'LKA',
  LR: 'LBR', LS: 'LSO', LT: 'LTU', LU: 'LUX', LV: 'LVA', LY: 'LBY', MA: 'MAR', MC: 'MCO',
  MD: 'MDA', ME: 'MNE', MG: 'MDG', MH: 'MHL', MK: 'MKD', ML: 'MLI', MM: 'MMR', MN: 'MNG',
  MR: 'MRT', MT: 'MLT', MU: 'MUS', MV: 'MDV', MW: 'MWI', MX: 'MEX', MY: 'MYS', MZ: 'MOZ',
  NA: 'NAM', NE: 'NER', NG: 'NGA', NI: 'NIC', NL: 'NLD', NO: 'NOR', NP: 'NPL', NR: 'NRU',
  NZ: 'NZL', OM: 'OMN', PA: 'PAN', PE: 'PER', PG: 'PNG', PH: 'PHL', PK: 'PAK', PL: 'POL',
  PT: 'PRT', PW: 'PLW', PY: 'PRY', QA: 'QAT', RO: 'ROU', RS: 'SRB', RU: 'RUS', RW: 'RWA',
  SA: 'SAU', SB: 'SLB', SC: 'SYC', SD: 'SDN', SE: 'SWE', SG: 'SGP', SI: 'SVN', SK: 'SVK',
  SL: 'SLE', SM: 'SMR', SN: 'SEN', SO: 'SOM', SR: 'SUR', SS: 'SSD', ST: 'STP', SV: 'SLV',
  SY: 'SYR', SZ: 'SWZ', TD: 'TCD', TG: 'TGO', TH: 'THA', TJ: 'TJK', TL: 'TLS', TM: 'TKM',
  TN: 'TUN', TO: 'TON', TR: 'TUR', TT: 'TTO', TV: 'TUV', TW: 'TWN', TZ: 'TZA', UA: 'UKR',
  UG: 'UGA', US: 'USA', UY: 'URY', UZ: 'UZB', VA: 'VAT', VC: 'VCT', VE: 'VEN', VN: 'VNM',
  VU: 'VUT', WS: 'WSM', XK: 'XKX', YE: 'YEM', ZA: 'ZAF', ZM: 'ZMB', ZW: 'ZWE',
}

type Ring = ReadonlyArray<readonly [number, number]>

/**
 * A load-once point-in-country tester: `true` iff `(lat, lon)` is inside an outer
 * ring of the ISO-3166-1 alpha-2 country AND not inside one of that ring's holes
 * (foreign enclaves are excluded). Throws on an alpha-2 code that is unknown or has
 * no CGAZ feature — fail loud, since a silent always-false gate would drop every match.
 * `makeCountryGate(iso2)` IS the reuse path for other enrichers; no need to
 * expose the raw rings.
 */
export function makeCountryGate(iso2: string): (lat: number, lon: number) => boolean {
  const idx = buildIndexed(isoToFeature(iso2).geometry)
  return (lat, lon) => inIndexed(idx, lat, lon)
}

// `bands` is a latitude-band index of the outer ring's edges (null for small rings,
// brute-forced): a ray-cast crossing can only come from an edge straddling the query
// latitude, so band[⌊(lat-s)/bandH⌋] lists exactly the candidate edges — turning the
// O(ring) point-in-polygon into O(edges-in-band) for huge rings (China/Russia).
type IndexedRing = { outer: Ring; holes: Ring[]; w: number; s: number; e: number; n: number; bands: number[][] | null; bandH: number }

/** Outer ring + interior holes + lon/lat bbox per polygon of a CGAZ geometry.
 *  Holes are enclaves of OTHER countries (e.g. a Tajik exclave inside Uzbekistan):
 *  a point in a hole is NOT in this country (gg 2026-06-14). The per-ring bbox is a
 *  cheap pre-check — CGAZ rings are dense and archipelagos carry hundreds of island
 *  rings (FRA incl. overseas: 204); the box test skips them ~free. */
function buildIndexed(g: { type: string; coordinates: unknown }): IndexedRing[] {
  const polys: { outer: Ring; holes: Ring[] }[] = []
  if (g.type === 'Polygon') {
    const r = g.coordinates as Ring[]
    polys.push({ outer: r[0], holes: r.slice(1) })
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates as Ring[][]) polys.push({ outer: poly[0], holes: poly.slice(1) })
  }
  return polys.map(({ outer, holes }) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const [x, y] of outer) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y }
    const len = outer.length
    // Index only rings big enough to matter (~1 band per 8 edges, capped at 256).
    const bandCount = len > 64 ? Math.min(256, Math.ceil(len / 8)) : 0
    let bands: number[][] | null = null
    const bandH = bandCount > 0 ? (n - s) / bandCount || 1 : 0
    if (bandCount > 0) {
      bands = Array.from({ length: bandCount }, () => [] as number[])
      for (let i = 0; i < len; i++) {
        const j = i === 0 ? len - 1 : i - 1
        const yi = outer[i][1], yj = outer[j][1]
        let b0 = Math.floor((Math.min(yi, yj) - s) / bandH)
        let b1 = Math.floor((Math.max(yi, yj) - s) / bandH)
        if (b0 < 0) b0 = 0
        if (b1 >= bandCount) b1 = bandCount - 1
        for (let b = b0; b <= b1; b++) bands[b].push(i)
      }
    }
    return { outer, holes, w, s, e, n, bands, bandH }
  })
}

/** Ray-cast point-in-outer-ring, using the band index when present. Identical
 *  result to `pointInRing(lon, lat, r.outer)` — only the candidate set shrinks. */
function inOuter(r: IndexedRing, lat: number, lon: number): boolean {
  const { outer, bands } = r
  if (!bands) return pointInRing(lon, lat, outer)
  const len = outer.length
  let b = Math.floor((lat - r.s) / r.bandH)
  if (b < 0) b = 0; else if (b >= bands.length) b = bands.length - 1
  let inside = false
  for (const i of bands[b]) {
    const j = i === 0 ? len - 1 : i - 1
    const xi = outer[i][0], yi = outer[i][1], xj = outer[j][0], yj = outer[j][1]
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

/** True iff the point is inside an outer ring and not inside one of its holes. */
function inIndexed(idx: readonly IndexedRing[], lat: number, lon: number): boolean {
  for (const r of idx) {
    if (lon < r.w || lon > r.e || lat < r.s || lat > r.n) continue
    if (!inOuter(r, lat, lon)) continue
    if (r.holes.some(h => pointInRing(lon, lat, h))) continue // inside a foreign enclave
    return true
  }
  return false
}

function isoToFeature(iso2: string): { iso3: string; geometry: { type: string; coordinates: unknown } } {
  const code = iso2.toUpperCase()
  const iso3 = ISO2_TO_ISO3[code]
  if (!iso3) throw new Error(`country-polygon: unknown ISO_A2 country code ${code}`)
  const f = cgazFeatures().find(x => x.properties.shapeGroup === iso3)
  if (!f) throw new Error(`country-polygon: no CGAZ ADM0 feature for ${code} (${iso3})`)
  return { iso3, geometry: f.geometry }
}

// Global land-mask over ALL CGAZ features (incl. disputed / non-ISO), memoised +
// shared. The coastal gate uses it to keep land borders strict and reject
// strait-ambiguous sea points; only the rare OUTSIDE rows hit it.
let landIdx: ReadonlyArray<{ iso3: string; idx: IndexedRing[] }> | null = null
function landMask(): ReadonlyArray<{ iso3: string; idx: IndexedRing[] }> {
  if (!landIdx) landIdx = cgazFeatures().map(f => ({ iso3: String(f.properties.shapeGroup), idx: buildIndexed(f.geometry) }))
  return landIdx
}
function inAnyCountry(lat: number, lon: number): boolean {
  for (const { idx } of landMask()) if (inIndexed(idx, lat, lon)) return true
  return false
}
// Global grid of every country's outer-ring SEGMENTS, tagged by iso3, bucketed
// into 0.1° (~11 km) cells, memoised + shared. The coastal gate's slow path asks
// only a THRESHOLD ("is this country's coast within bufferM?"), never a true
// minimum — so a query touches just the few segments in the cells within bufferM
// instead of scanning a whole country's outer ring. distToOuter used to scan
// China's entire border (~tens of k vertices) per offshore road, which went
// pathological at coastal multi-border hexes (RU/CN/PRK tripoint: 10+ min/hex).
const SEG_GRID_DEG = 0.1
type GridSeg = { iso3: string; aLat: number; aLon: number; bLat: number; bLon: number }
let segGrid: Map<number, GridSeg[]> | null = null
// iy∈[0,1800), ix∈[0,3600] (lon=180 → ix=3600). The 4096 stride exceeds the ix
// range so keys stay collision-free even for the small ±rx query overshoot.
const segCell = (ix: number, iy: number): number => iy * 4096 + ix

function buildSegGrid(): Map<number, GridSeg[]> {
  const grid = new Map<number, GridSeg[]>()
  for (const { iso3, idx } of landMask()) {
    for (const { outer } of idx) {
      for (let i = 0; i < outer.length - 1; i++) {
        const [aLon, aLat] = outer[i], [bLon, bLat] = outer[i + 1]
        // Skip antimeridian-spanning artifacts (only ATA at ±180 in CGAZ v6.0.0):
        // one such edge would smear across every longitude cell, and pointToSegmentDist
        // doesn't wrap at ±180 so its distance would be bogus anyway. No road-bearing
        // country's coast crosses the dateline seam, so dropping the edge is harmless.
        if (Math.abs(aLon - bLon) > 180) continue
        const seg: GridSeg = { iso3, aLat, aLon, bLat, bLon }
        const x0 = Math.floor((Math.min(aLon, bLon) + 180) / SEG_GRID_DEG)
        const x1 = Math.floor((Math.max(aLon, bLon) + 180) / SEG_GRID_DEG)
        const y0 = Math.floor((Math.min(aLat, bLat) + 90) / SEG_GRID_DEG)
        const y1 = Math.floor((Math.max(aLat, bLat) + 90) / SEG_GRID_DEG)
        for (let ix = x0; ix <= x1; ix++)
          for (let iy = y0; iy <= y1; iy++) {
            const k = segCell(ix, iy), b = grid.get(k)
            if (b) b.push(seg); else grid.set(k, [seg])
          }
      }
    }
  }
  return grid
}

/** True iff any outer-ring segment of a country matching `want(iso3)` lies within
 *  `distM` of the point. Replaces the per-country `distToOuter <= buf` scan. */
function coastWithin(lat: number, lon: number, distM: number, want: (iso3: string) => boolean): boolean {
  const grid = segGrid ?? (segGrid = buildSegGrid())
  // Cell radius covering distM. lon degrees shrink toward the poles, so widen the
  // lon search by 1/cosLat (floored at 0.05 ≈ 87°N — past any road).
  const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.05)
  const ry = Math.ceil(distM / (SEG_GRID_DEG * 110_540)) + 1
  const rx = Math.ceil(distM / (SEG_GRID_DEG * 111_320 * cosLat)) + 1
  const cx = Math.floor((lon + 180) / SEG_GRID_DEG)
  const cy = Math.floor((lat + 90) / SEG_GRID_DEG)
  for (let ix = cx - rx; ix <= cx + rx; ix++) {
    for (let iy = cy - ry; iy <= cy + ry; iy++) {
      const bucket = grid.get(segCell(ix, iy))
      if (!bucket) continue
      for (const s of bucket) {
        if (!want(s.iso3)) continue
        if (pointToSegmentDist(lat, lon, s.aLat, s.aLon, s.bLat, s.bLon) <= distM) return true
      }
    }
  }
  return false
}

function otherCountryWithin(lat: number, lon: number, bufferM: number, exceptIso3: string): boolean {
  return coastWithin(lat, lon, bufferM, iso3 => iso3 !== exceptIso3)
}

/**
 * Like `makeCountryGate`, but tolerant of COASTAL roads whose midpoint falls just
 * offshore of the CGAZ polygon (the polygon coastline sits inland of OSM waterfront
 * roads on reclaimed land — ~14 % of class-0 roads in the Lagos hex were lost this
 * way, gg 2026-06-15). Accepts a point inside the country, OR over the sea within
 * `bufferM` of it AND not inside / within `bufferM` of any OTHER country — so land
 * borders stay strict (a neighbour-side point is `inAnyCountry`) and narrow straits
 * don't double-claim. Road enrichers use THIS; `makeCountryGate` stays land-only for
 * negative-gate callers (e.g. enrich-industrial-kr `!inNK && !inJP`).
 * See `.claude/plans/coastal-gate-sea-buffer.md`.
 */
export function makeCoastalCountryGate(iso2: string, bufferM = 2000): (lat: number, lon: number) => boolean {
  // A sea buffer is a few km; reject misuse loudly — an unbounded bufferM would blow
  // up coastWithin's cell-radius loop (gg 2026-06-15, Codex).
  if (!(bufferM > 0 && bufferM <= 50_000)) throw new Error(`makeCoastalCountryGate: bufferM ${bufferM} out of (0, 50000] m`)
  const { iso3, geometry } = isoToFeature(iso2)
  const target = buildIndexed(geometry)
  // Same conjunction as a strict land gate would reject on, ordered cheapest-first:
  // the two grid-backed coast-threshold checks reject the bulk of foreign/far-sea
  // points, so the expensive whole-polygon `inAnyCountry` PIP runs only for the few
  // survivors (genuine sea points hugging the target's own coast).
  return (lat, lon) => {
    if (inIndexed(target, lat, lon)) return true                       // target land — fast path (bulk)
    if (!coastWithin(lat, lon, bufferM, x => x === iso3)) return false // too far from target coast
    if (otherCountryWithin(lat, lon, bufferM, iso3)) return false      // neighbour/strait coast within buffer
    if (inAnyCountry(lat, lon)) return false                           // deep inside a neighbour — rare survivor
    return true                                                         // over sea, uniquely nearest target
  }
}
