/**
 * Enrich IN railways.arrow with Living Atlas India railway network + metro.
 *
 * Data sources:
 *
 * 1. **IN Railway Network** — 119,446 per-segment polylines from Indian Railways.
 *    URL: `livingatlas.esri.in/server1/rest/services/Railway/IN_Railway_Line/MapServer/1`
 *    Fields: fromjunction, tojunction, `speed` (km/h), `type` (Broad/Metre/Narrow
 *    Gauge), `railwayzone`, `nooflanes`, `bridge_yn`, `tunnel_yn`
 *    - 114,968 Broad Gauge (1676mm — the Indian standard)
 *    - 2,123 Metre Gauge + 1,864 Narrow Gauge (heritage, tourist, limited)
 *    - Speed buckets: 100+ km/h (53,123 segments) 60-99 (7,361) 0-59 (58,579)
 *    - 18 IR zones (Central, Western, Northern, Southern, etc.)
 *
 * 2. **IN Metro Network** — 83 metro lines + 1,401 stations covering Delhi, Mumbai,
 *    Bangalore, Ahmedabad, Patna, Chennai, Kolkata, Hyderabad, Kochi, Nagpur,
 *    Lucknow, Jaipur, Pune, Bhopal.
 *    URL: `livingatlas.esri.in/server1/rest/services/MetroNetwork/India_Metro_Network/MapServer`
 *
 * Strategy: spatial match OSM railway segments to the nearest Living Atlas line
 * within 500m. Apply trains/day default based on:
 *   - Metro match (within city bbox): 400 trains/day (typical UTO)
 *   - Mumbai suburban (Central/Western Railway within Mumbai bbox): 1,300/day
 *     (world's busiest suburban system: 2,342 daily services across 3 lines)
 *   - Delhi suburban (Northern Railway within Delhi NCR bbox): 350/day
 *   - Chennai/Kolkata/Bangalore/Hyderabad suburban: 250/day
 *   - Speed >= 100 km/h broad gauge: 30 pax + 15 freight (IR mainline)
 *   - Speed 60-99 km/h broad gauge: 20 pax + 10 freight
 *   - Speed < 60 km/h broad gauge: 10 pax + 5 freight
 *   - Metre/Narrow gauge: 5 pax (heritage)
 *
 * Exclusion zones for Pakistan, Nepal, Bhutan, Bangladesh, Myanmar, Sri Lanka,
 * China.
 *
 * Note: Delhi Metro and most other Indian metros are tagged `railway=subway`
 * in OSM — pipeline extractor bug (same as Bangkok MRT, Dubai Metro, Taipei,
 * Singapore, Seoul, Tokyo, HK, Mexico City). The Living Atlas Metro Network
 * geometry is cached but cannot be matched to OSM subway segments because
 * they're not in railways.arrow. Some elevated sections tagged `light_rail`
 * WILL match.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-in.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_SOURCE_ID = SOURCES_BY_KEY.get('in-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/in`)

const IN_BBOX: [number, number, number, number] = [6.5, 68.0, 37.0, 98.0]

// Exclusion zones for neighbours — tight to avoid clipping Delhi / Kolkata.
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Pakistan', bbox: [23.0, 68.0, 37.0, 73.8] },
  { name: 'China', bbox: [30.5, 76.0, 37.0, 98.0] },
  { name: 'Nepal', bbox: [26.5, 80.1, 30.5, 88.2] },
  { name: 'Bhutan', bbox: [26.7, 88.8, 28.3, 92.1] },
  { name: 'Bangladesh', bbox: [20.5, 88.8, 26.7, 92.8] },
  { name: 'Myanmar', bbox: [9.5, 93.6, 28.5, 102.0] },
  { name: 'Sri Lanka', bbox: [5.9, 79.5, 9.9, 82.0] },
]

// Indian metro cities (broader bbox for suburban rail)
const MUMBAI_BBOX: [number, number, number, number] = [18.9, 72.7, 19.4, 73.3]
const DELHI_BBOX: [number, number, number, number] = [28.3, 76.8, 29.2, 77.6]
const CHENNAI_BBOX: [number, number, number, number] = [12.8, 80.1, 13.3, 80.4]
const KOLKATA_BBOX: [number, number, number, number] = [22.3, 88.2, 22.8, 88.6]
const BENGALURU_BBOX: [number, number, number, number] = [12.8, 77.4, 13.2, 77.8]
const HYDERABAD_BBOX: [number, number, number, number] = [17.2, 78.2, 17.6, 78.7]
const AHMEDABAD_BBOX: [number, number, number, number] = [22.9, 72.4, 23.2, 72.8]
const PUNE_BBOX: [number, number, number, number] = [18.4, 73.7, 18.7, 74.0]
const KOCHI_BBOX: [number, number, number, number] = [9.8, 76.1, 10.1, 76.4]
const LUCKNOW_BBOX: [number, number, number, number] = [26.75, 80.8, 27.0, 81.1]
const JAIPUR_BBOX: [number, number, number, number] = [26.8, 75.7, 27.0, 76.0]
const NAGPUR_BBOX: [number, number, number, number] = [21.05, 79.0, 21.25, 79.2]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

// ── Geometry helpers (shared with roads) ──
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

// ── Load Living Atlas railway + metro ──

interface RailFeat {
  coords: [number, number][]
  speed: number
  type: string    // gauge
  zone: string
  lanes: number
  isMetro: boolean
}

function loadLivingAtlasRails(): RailFeat[] {
  const railPath = resolve(CACHE_DIR, 'railway-network.geojson')
  const metroPath = resolve(CACHE_DIR, 'metro-lines.geojson')
  const out: RailFeat[] = []
  if (existsSync(railPath)) {
    const fc = JSON.parse(readFileSync(railPath, 'utf-8'))
    for (const f of fc.features || []) {
      const g = f.geometry
      if (!g) continue
      let coords: [number, number][] = []
      if (g.type === 'LineString') coords = g.coordinates
      else if (g.type === 'MultiLineString') coords = g.coordinates[0] || []
      if (coords.length < 2) continue
      out.push({
        coords,
        speed: (f.properties?.speed) ?? 0,
        type: (f.properties?.type || '').trim(),
        zone: (f.properties?.railwayzone || '').trim(),
        lanes: (f.properties?.nooflanes) ?? 1,
        isMetro: false,
      })
    }
  }
  if (existsSync(metroPath)) {
    const fc = JSON.parse(readFileSync(metroPath, 'utf-8'))
    for (const f of fc.features || []) {
      const g = f.geometry
      if (!g) continue
      let coords: [number, number][] = []
      if (g.type === 'LineString') coords = g.coordinates
      else if (g.type === 'MultiLineString') {
        // Concatenate all parts
        for (const part of g.coordinates) coords.push(...part)
      }
      if (coords.length < 2) continue
      out.push({
        coords, speed: 80, type: 'Standard Gauge', zone: 'Metro', lanes: 2, isMetro: true,
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

// ── Trains/day logic ──

function trainsFromFeature(feat: RailFeat, midLat: number, midLon: number): { pax: number; frt: number } {
  if (feat.isMetro) return { pax: 400, frt: 0 }
  const gauge = (feat.type || '').toLowerCase()
  if (gauge.includes('narrow') || gauge.includes('metre')) return { pax: 5, frt: 0 }

  // Mumbai Suburban (Central + Western + Harbour lines) — the world's busiest commuter rail
  if (inBbox(midLat, midLon, MUMBAI_BBOX)) {
    const z = feat.zone.toLowerCase()
    if (z.includes('central') || z.includes('western')) return { pax: 1300, frt: 30 }
  }
  // Delhi suburban (Northern Railway within NCR)
  if (inBbox(midLat, midLon, DELHI_BBOX) && feat.zone.toLowerCase().includes('northern')) {
    return { pax: 350, frt: 20 }
  }
  // Kolkata suburban (Eastern + South Eastern Railway)
  if (inBbox(midLat, midLon, KOLKATA_BBOX)) {
    const z = feat.zone.toLowerCase()
    if (z.includes('eastern')) return { pax: 500, frt: 25 }
  }
  // Chennai suburban (Southern Railway)
  if (inBbox(midLat, midLon, CHENNAI_BBOX) && feat.zone.toLowerCase().includes('southern')) {
    return { pax: 350, frt: 20 }
  }
  // Other metros get broad-gauge defaults (no dedicated suburban rail scaling)
  if (inBbox(midLat, midLon, BENGALURU_BBOX) ||
      inBbox(midLat, midLon, HYDERABAD_BBOX) ||
      inBbox(midLat, midLon, AHMEDABAD_BBOX) ||
      inBbox(midLat, midLon, PUNE_BBOX)) {
    return { pax: 60, frt: 20 }
  }

  // Speed-based defaults for the remaining broad gauge mainline network
  if (feat.speed >= 120) return { pax: 30, frt: 15 }  // Vande Bharat corridors
  if (feat.speed >= 100) return { pax: 25, frt: 15 }  // regular express
  if (feat.speed >= 60) return { pax: 15, frt: 10 }   // secondary lines
  return { pax: 8, frt: 5 }                            // local / low-speed
}

// CNOSSOS class default fallback (when no Living Atlas match)
function classDefault(railType: number, usage: number): { pax: number; frt: number } {
  if (railType === 2) return { pax: 200, frt: 0 }  // light_rail (metro elevated)
  if (railType === 1) return { pax: 200, frt: 0 }  // tram
  if (railType === 3) return { pax: 10, frt: 0 }
  if (railType === 4) return { pax: 5, frt: 0 }
  // rail_type=0
  if (usage === 1) return { pax: 5, frt: 5 }
  if (usage === 2) return { pax: 0, frt: 10 }
  return { pax: 12, frt: 8 }
}

async function main() {
  console.log(`=== IN Railway Enrichment — Living Atlas IR Network + Metros (${YEAR}) ===\n`)
  const rails = loadLivingAtlasRails()
  console.log(`  Loaded Living Atlas rails: ${rails.length} features (${rails.filter(r => r.isMetro).length} metro + ${rails.filter(r => !r.isMetro).length} IR)`)
  const grid = buildGrid(rails)
  console.log(`  Spatial grid cells: ${grid.size}\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, IN_BBOX)) {
        if (existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  IN-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, excluded = 0, alreadyEnriched = 0, skippedService = 0
  let matchedAtlas = 0, matchedDefault = 0
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
    const existingSourceId = table.getChild('source_id')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    const sourceId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingFrt?.get(i) as number) ?? 0

      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }
    totalRails += n

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) continue

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, IN_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0

      // Spatial match to Living Atlas (500m radius)
      const near = nearestRail(midLat, midLon, grid, 500)
      let pax = 0, frt = 0
      if (near) {
        const t = trainsFromFeature(near, midLat, midLon)
        pax = t.pax; frt = t.frt
        matchedAtlas++
      } else {
        const d = classDefault(rt, us)
        pax = d.pax; frt = d.frt
        matchedDefault++
      }
      trainsPax[i] = pax
      trainsFrt[i] = frt
      sourceId[i] = MY_SOURCE_ID
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

      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      const newTable = makeTable(columns)
      writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedAtlas} atlas + ${matchedDefault} default`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:        ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:     ${skippedService.toLocaleString()}`)
  console.log(`  Already enriched (preserved): ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by Living Atlas:    ${matchedAtlas.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matchedDefault.toLocaleString()}`)
  const tot = matchedAtlas + matchedDefault
  console.log(`  Total enriched:             ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRails, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
