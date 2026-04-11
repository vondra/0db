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
 * The trade-off: Chinese OSM rail is conflated with heavy rail, so we need
 * ServiceType from the Mainland service to distinguish metro from mainline.
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
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-cn.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
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

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}
function pointToSegmentDist(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat, py = pLat * 110540
  const ax = aLon * 111320 * cosLat, ay = aLat * 110540
  const bx = bLon * 111320 * cosLat, by = bLat * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}
function pointToPolylineDist(pLat: number, pLon: number, coords: [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    if (d < best) best = d
  }
  return best
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

function nearestRail(midLat: number, midLon: number, grid: Map<string, RailFeat[]>, radiusM: number): RailFeat | null {
  const reach = Math.max(1, Math.ceil(radiusM / 1000))
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
  let best: RailFeat | null = null
  let bestDist = radiusM
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
  const nMetro = rails.filter(r => r.isMetro).length
  const nNat = rails.length - nMetro
  console.log(`  Loaded: ${rails.length} (${nNat} national rail + ${nMetro} metro)`)
  const grid = buildGrid(rails)
  console.log(`  Grid cells: ${grid.size}\n`)

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

  let totalRails = 0, excluded = 0, alreadyEnriched = 0, skippedService = 0
  let matchedMainland = 0, matchedDefault = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const railPath = resolve(H3R4_DIR, hex, 'railways.arrow')
    const buf = readFileSync(railPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const railTypeCol = table.getChild('rail_type')!
    const usageCol = table.getChild('usage')!
    const serviceCol = table.getChild('service')
    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingFrt?.get(i) as number) ?? 0
    }
    totalRails += n

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (trainsPax[i] > 0 || trainsFrt[i] > 0) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, CN_BBOX)) continue
      if (inExclusion(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0

      const near = nearestRail(midLat, midLon, grid, 500)
      let pax = 0, frt = 0
      if (near) {
        const t = trainsFromFeature(near)
        pax = t.pax; frt = t.frt
        matchedMainland++
      } else {
        const d = classDefault(rt, us)
        pax = d.pax; frt = d.frt
        matchedDefault++
      }
      trainsPax[i] = pax
      trainsFrt[i] = frt
      hexMatched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (field.name === 'trains_passenger' || field.name === 'trains_freight') continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
      columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())
      const newTable = makeTable(columns)
      writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedMainland} mainland + ${matchedDefault} default`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:        ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:     ${skippedService.toLocaleString()}`)
  console.log(`  Already enriched (preserved): ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by Mainland:        ${matchedMainland.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matchedDefault.toLocaleString()}`)
  const tot = matchedMainland + matchedDefault
  console.log(`  Total enriched:             ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRails, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
