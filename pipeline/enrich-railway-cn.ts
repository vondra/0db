/**
 * Enrich CN railways.arrow with Mainland (China Railway + Metro) ArcGIS data.
 *
 * Source: `services7.arcgis.com/m6uLpqj7MgjPU371/arcgis/rest/services/
 * Mainland/FeatureServer` by user `hanzheng1994` — a community-maintained
 * ArcGIS Online mirror of the China Railway and urban metro networks.
 *
 * Layers used:
 *
 * 1. **Mainland/4** — 国家铁路线 (national railway lines)
 *    2,328 polylines with `Name`, `Opaerator` (CR-Beijing, CR-Guangzhou, etc.),
 *    `ServiceType` (National Rail / Regional Passenger Rail), `DesignSpeed`,
 *    `TopSpeed` (in km/h: 100/120/160/200/250/300/350), `Electrification`,
 *    `ROW` (right-of-way), `Status` (运营中=operating, 建设中=under construction).
 *    Includes the **42,000 km Chinese HSR network** — Beijing↔Shanghai HSR,
 *    Beijing↔Guangzhou↔Hong Kong HSR, Shanghai↔Kunming HSR, Lanzhou↔Xinjiang HSR,
 *    etc. TopSpeed=350 corresponds to Fuxing trainsets on the world's fastest
 *    commercial service (Beijing-Shanghai).
 *
 * 2. **Mainland/3** — 城市轨道交通线 (urban metro lines)
 *    1,256 polylines across 50+ Chinese cities with `ServiceType`:
 *      - Metro Heavy Rail: 842 (standard mass transit, Beijing/Shanghai/Guangzhou)
 *      - Metro Express Heavy Rail: 167 (airport + suburban express)
 *      - LRT / Metro Light Rail: 144
 *      - APM (automated people mover): 13
 *      - Streetcar: 16
 *      - BRT (bus rapid transit): 67 — excluded (not rail)
 *      - Tourist rail: 7
 *
 * 3. **Mainland/0** and **Mainland/1** — station points (2,398 national + 10,948 metro)
 *    Not directly used for matching (polylines cover the same corridors).
 *
 * ## CRITICAL — OSM Chinese metro tagging is `railway=rail`, NOT `subway`
 *
 * Unlike Dubai/Bangkok/Taipei/Delhi/etc., Chinese metros in OSM are tagged
 * `railway=rail`, confirmed with Guangzhou Metro Line 18. This means Chinese
 * metros ARE extracted into `railways.arrow` and CAN be enriched directly via
 * spatial match to the Mainland/3 layer. **China dodges the subway bug.**
 *
 * The trade-off: Chinese OSM rail is conflated with heavy rail (a metro and a
 * mainline are both `rail_type=0`), so the feed's own family tag is the only
 * way to tell metro from mainline. We split the feed into a national heavy-rail
 * grid (Mainland/4) and a metro grid (Mainland/3), then FAMILY-GATE the match:
 * an OSM `rail_type=0` row may match either grid (it's genuinely ambiguous —
 * nearest polyline wins), but a `rail_type=1/2` tram/light_rail row may match
 * the METRO grid ONLY. That gate makes cross-family inheritance impossible: a
 * surface tram can no longer pick up a neighbouring HSR line's ~180 trains/day.
 *
 * ## trains/day defaults
 *
 * From Mainland/4 (national rail):
 *   TopSpeed ≥ 350 (Fuxing HSR)     → 180 pax + 0 frt (pure HSR, Beijing-Shanghai)
 *   TopSpeed ≥ 300 (CRH380)         → 150 pax + 0 frt
 *   TopSpeed ≥ 250 (CRH2/5)         → 120 pax + 0 frt
 *   TopSpeed ≥ 200                  → 80 pax + 10 frt (mixed)
 *   TopSpeed ≥ 150                  → 50 pax + 20 frt (regional + freight)
 *   TopSpeed ≥ 100                  → 30 pax + 20 frt (mainline freight)
 *   TopSpeed < 100                  → 15 pax + 10 frt (local)
 *   TopSpeed = 0 (unknown)          → 25 pax + 10 frt (default)
 *
 * From Mainland/3 (urban metro):
 *   Metro Heavy Rail                → 500 pax + 0 frt (Beijing, Shanghai typical)
 *   Metro Express Heavy Rail        → 400 pax + 0 frt
 *   LRT / Metro Light Rail          → 300 pax + 0 frt
 *   APM                             → 500 pax + 0 frt (short high-frequency)
 *   Streetcar                       → 200 pax + 0 frt
 *   Tourist rail                    → 30 pax + 0 frt
 *   BRT                             → skip (not rail)
 *
 * Status filter: only 运营中 (operating). Under-construction/planned skipped.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-cn.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldOverwrite } from './lib/provenance.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_CN_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { inBbox, pointToPolylineDist } from './lib/spatial.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_CN_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cn`)

const CN_BBOX: [number, number, number, number] = [18.0, 73.0, 54.0, 135.5]

// Same exclusion zones as roads
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'India-south', bbox: [18.0, 73.0, 29.0, 85.0] },
  { name: 'Pakistan-West', bbox: [24.0, 73.0, 37.5, 74.5] },
  { name: 'Nepal', bbox: [26.5, 80.0, 30.5, 88.2] },
  { name: 'Bhutan', bbox: [26.7, 88.8, 28.3, 92.1] },
  { name: 'Myanmar', bbox: [18.0, 92.0, 28.5, 100.5] },
  { name: 'Laos', bbox: [13.0, 100.0, 22.5, 107.8] },
  { name: 'Vietnam', bbox: [8.0, 102.0, 23.5, 110.0] },
  { name: 'Thailand', bbox: [5.0, 97.0, 21.0, 106.0] },
  { name: 'Central Asia', bbox: [36.0, 73.0, 50.0, 81.0] },
  { name: 'Mongolia', bbox: [42.0, 88.0, 54.0, 120.0] },
  { name: 'North Korea', bbox: [37.5, 124.0, 43.0, 131.0] },
  { name: 'South Korea', bbox: [33.0, 126.0, 38.5, 130.0] },
  { name: 'Russia Far East', bbox: [50.0, 115.0, 54.0, 135.5] },
  { name: 'Japan', bbox: [24.0, 129.0, 54.0, 135.5] },
  { name: 'Taiwan', bbox: [21.8, 119.5, 25.5, 122.1] },
]

function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

// ── Load Mainland rail + metro ──

interface RailFeat {
  coords: [number, number][]
  serviceType: string
  topSpeed: number
  isMetro: boolean
}

function loadRails(): RailFeat[] {
  const out: RailFeat[] = []

  const natPath = resolve(CACHE_DIR, 'railway-national.geojson')
  if (existsSync(natPath)) {
    const fc = JSON.parse(readFileSync(natPath, 'utf-8'))
    for (const f of fc.features || []) {
      const g = f.geometry
      if (!g) continue
      const status = (f.properties?.Status || '').trim()
      if (status && status !== '运营中' && status !== 'operating') continue  // only operating
      let coords: [number, number][] = []
      if (g.type === 'LineString') coords = g.coordinates
      else if (g.type === 'MultiLineString') coords = g.coordinates[0] || []
      if (coords.length < 2) continue
      out.push({
        coords,
        serviceType: (f.properties?.ServiceType || '').trim(),
        topSpeed: (f.properties?.TopSpeed) ?? 0,
        isMetro: false,
      })
    }
  }

  const metroPath = resolve(CACHE_DIR, 'metro-lines.geojson')
  if (existsSync(metroPath)) {
    const fc = JSON.parse(readFileSync(metroPath, 'utf-8'))
    for (const f of fc.features || []) {
      const g = f.geometry
      if (!g) continue
      const status = (f.properties?.Status || '').trim()
      if (status && status !== '运营中' && status !== 'operating') continue
      const serviceType = (f.properties?.ServiceType || '').trim()
      if (serviceType === 'BRT') continue  // skip bus rapid transit
      let coords: [number, number][] = []
      if (g.type === 'LineString') coords = g.coordinates
      else if (g.type === 'MultiLineString') {
        for (const part of g.coordinates) coords.push(...part)
      }
      if (coords.length < 2) continue
      out.push({
        coords,
        serviceType,
        topSpeed: (f.properties?.TopSpeed) ?? 80,
        isMetro: true,
      })
    }
  }
  return out
}

function buildGrid(features: RailFeat[]): Map<string, RailFeat[]> {
  const grid = new Map<string, RailFeat[]>()
  for (const feat of features) {
    const seen = new Set<string>()
    for (const [lon, lat] of feat.coords) {
      const key = `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`
      if (!seen.has(key)) {
        seen.add(key)
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key)!.push(feat)
      }
    }
  }
  return grid
}

/** Nearest feed polyline within `radiusM`, searching ONLY the supplied grids
 *  (the caller restricts which families are eligible — see the match closure). */
function nearestRail(midLat: number, midLon: number, grids: Map<string, RailFeat[]>[], radiusM: number): RailFeat | null {
  const reach = Math.max(1, Math.ceil(radiusM / 1000))
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
  let best: RailFeat | null = null
  let bestDist = radiusM
  for (const grid of grids) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const cell = grid.get(`${baseLat + dy}_${baseLon + dx}`)
        if (!cell) continue
        for (const feat of cell) {
          const d = pointToPolylineDist(midLat, midLon, feat.coords)
          if (d < bestDist) { bestDist = d; best = feat }
        }
      }
    }
  }
  return best
}

// ── Train frequency by ServiceType/TopSpeed ──

function trainsFromFeature(feat: RailFeat): { pax: number; frt: number } {
  if (feat.isMetro) {
    const s = feat.serviceType
    if (s === 'Metro Heavy Rail') return { pax: 500, frt: 0 }
    if (s === 'Metro Express Heavy Rail') return { pax: 400, frt: 0 }
    if (s === 'LRT' || s === 'Metro Light Rail') return { pax: 300, frt: 0 }
    if (s === 'APM') return { pax: 500, frt: 0 }
    if (s === 'Streetcar') return { pax: 200, frt: 0 }
    if (s.includes('旅游')) return { pax: 30, frt: 0 }
    return { pax: 400, frt: 0 }  // unknown metro default
  }
  // National rail — speed-based
  const ts = feat.topSpeed || 0
  if (ts >= 350) return { pax: 180, frt: 0 }  // Fuxing HSR Beijing-Shanghai
  if (ts >= 300) return { pax: 150, frt: 0 }
  if (ts >= 250) return { pax: 120, frt: 0 }
  if (ts >= 200) return { pax: 80, frt: 10 }
  if (ts >= 150) return { pax: 50, frt: 20 }
  if (ts >= 100) return { pax: 30, frt: 20 }
  if (ts > 0) return { pax: 15, frt: 10 }
  return { pax: 25, frt: 10 }
}

function classDefault(rt: number, us: number): { pax: number; frt: number } {
  if (rt === 2) return { pax: 300, frt: 0 }  // light_rail
  if (rt === 1) return { pax: 200, frt: 0 }  // tram
  if (rt === 3) return { pax: 10, frt: 0 }
  if (rt === 4) return { pax: 5, frt: 0 }
  if (us === 1) return { pax: 10, frt: 10 }
  if (us === 2) return { pax: 0, frt: 15 }
  return { pax: 20, frt: 15 }  // mainline default for China
}

async function main() {
  console.log(`=== CN Railway Enrichment — Mainland (CR + metros) (${YEAR}) ===\n`)
  const rails = loadRails()
  const metroFeats = rails.filter(r => r.isMetro)
  const nationalFeats = rails.filter(r => !r.isMetro)
  console.log(`  Loaded: ${rails.length} (${nationalFeats.length} national rail + ${metroFeats.length} metro)`)

  // FAMILY-SPLIT grids: a metro/light-rail grid and a national heavy-rail grid,
  // tagged from the feed itself (Mainland/3 = metro, Mainland/4 = heavy rail).
  // The per-row FAMILY GATE in the match closure decides which grids an OSM row
  // may inherit from — crucially, a tram (rail_type 1/2) is barred from the
  // national grid, killing the family-blind bug that handed a tram up to ~180
  // trains/day. Mirrors th's tram-grid vs rail-grid split.
  const metroGrid = buildGrid(metroFeats)
  const nationalGrid = buildGrid(nationalFeats)
  console.log(`  Grid cells: national=${nationalGrid.size}, metro=${metroGrid.size}\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, CN_BBOX)) {
        if (existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  CN-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, excluded = 0, skippedService = 0
  let matchedMainland = 0, matchedDefault = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]

    // FAMILY-gated routing (see the gate comment in the closure) → nearest-polyline
    // match → CNOSSOS class-default fallback, all inside the match closure.
    // writeRailTrains owns the service-skip, the priority gate, and the
    // byte-identical write.
    const r = await writeRailTrains(resolve(H3R4_DIR, hex, 'railways.arrow'), (row) => {
      if (!shouldOverwrite(row.existingSourceId, MY_SOURCE_ID)) return null
      if (!inBbox(row.midLat, row.midLon, CN_BBOX)) return null
      if (inExclusion(row.midLat, row.midLon)) { excluded++; return null }

      const rt = row.railType
      const us = row.usage

      // FAMILY GATE — which feed grids this OSM row may inherit from.
      //   rt 1 (tram) / rt 2 (light_rail) ⇒ METRO grid ONLY. A surface tram can
      //     NEVER match a national heavy/HSR polyline — that was the family-blind
      //     bug (a tram sitting near a mainline inherited up to ~180 trains/day).
      //   rt 0 (rail) ⇒ national OR metro. Chinese metros are tagged
      //     `railway=rail` in OSM (→ rt 0, confirmed Guangzhou Line 18), so a rt-0
      //     row is genuinely either a mainline or a metro; the feed's own family
      //     tag (Mainland/4 vs /3) is the only disambiguator, so both are eligible
      //     and nearest-polyline wins. No cross-family leak: rt 1/2 still can't
      //     reach the national grid.
      //   rt 3/4 (narrow_gauge / funicular) ⇒ no feed family → class default.
      const grids = rt === 1 || rt === 2 ? [metroGrid] : rt === 0 ? [nationalGrid, metroGrid] : []
      if (grids.length > 0) {
        const near = nearestRail(row.midLat, row.midLon, grids, 500)
        if (near) {
          const t = trainsFromFeature(near)
          matchedMainland++
          return { pax: t.pax, frt: t.frt, sourceId: MY_SOURCE_ID }
        }
      }

      // Fallback: CNOSSOS class default (fill-by-type, never a silent track).
      const d = classDefault(rt, us)
      matchedDefault++
      return { pax: d.pax, frt: d.frt, sourceId: MY_SOURCE_ID }
    })

    totalRails += r.rows
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedMainland} mainland + ${matchedDefault} default`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:        ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:     ${skippedService.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by Mainland:        ${matchedMainland.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matchedDefault.toLocaleString()}`)
  const tot = matchedMainland + matchedDefault
  console.log(`  Total enriched:             ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRails, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
