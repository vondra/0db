/**
 * Enrich SA roads.arrow with three complementary open-data sources:
 *
 * 1. **MoT Traffic Density** (Ministry of Transport and Logistic Services)
 *    31 count stations with lat/lon + Road No. + 24-Hour Total for 2024.
 *    Published as XLSX under `mot.gov.sa/en/open-data`. This is the ONLY
 *    official per-corridor AADT source reachable from our egress — the
 *    canonical data.gov.sa portal and TGA open-data are WAF/firewall blocked.
 *    Applied by matching OSM `ref` (e.g. `40`, `65`) to the Road No. column,
 *    then taking the station average per road ref. Corridor-level match, not
 *    per-segment.
 *    URL: https://mot.gov.sa/documents/7507107/7507109/Traffic+density+on+roads.xlsx/...
 *    Period: 2024-01-01 to 2024-12-31
 *    Roads covered: 10, 15, 30, 40, 65, 175, 177, 180, 205, 246, 513, 517,
 *                   1144, 3409, 3410, 5816
 *
 * 2. **Riyadh PMS (Pavement Management System)** — RCRC / ADA Riyadh
 *    1,604 lane-level polylines inside Riyadh metro area with CLASS (A-D),
 *    NO_OF_LANE, STREET_WID, DIRECTION, STREET_NAM. Class + lane count is
 *    mapped to estimated AADT via CNOSSOS rule-of-thumb (Class A 5-lane
 *    ~50k AADT, Class D 2-lane ~2k AADT). Spatially matched to OSM segments
 *    within 200 m inside the Riyadh bbox.
 *    URL: https://services9.arcgis.com/7cs4rq15YlksXBMf/arcgis/rest/services/
 *         RiyadhPMS/FeatureServer/0/query?where=1=1&outFields=*&f=geojson&
 *         outSR=4326&resultRecordCount=2000
 *
 * 3. **Interactive Atlas of SA** (ArcGIS Online public feature service)
 *    3,555 national road polylines with RTT_DESCRI (Primary / Secondary Route)
 *    classification. Used as a national fallback for segments NOT matched
 *    by MoT (ref-based) or Riyadh PMS. Spatially matched within 500 m.
 *    URL: https://services6.arcgis.com/UBlzpwddcwD1J1A0/arcgis/rest/services/
 *         Interactive_atlas_of_spatial_features_and_transportation_networks_in_Saudi_Arabia_WFL1/
 *         FeatureServer/6/query?where=1=1&outFields=*&f=geojson&outSR=4326
 *
 * Exclusion zones (Iraq, Jordan, Israel, Kuwait, Bahrain, Yemen) are applied
 * at the segment-midpoint level so foreign-country OSM roads inside our coarse
 * SA bbox are never touched.
 *
 * Vehicle-class split: CNOSSOS default for Gulf arterial + motorway traffic:
 *   light   78% (passenger cars)
 *   medium  10% (small trucks / vans / taxis)
 *   heavy   11% (long-haul trucks — SA trucking share is high due to oil/freight)
 *   moto     1% (minimal scooter use)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-sa.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-sa.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('sa-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/sa`)

const forceDownload = process.argv.includes('--force-download')

// SA coarse bbox + segment-level exclusion zones for neighbour countries
const SA_BBOX: [number, number, number, number] = [16.0, 34.5, 32.5, 51.0]
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Jordan', bbox: [29.2, 34.5, 32.5, 37.9] },
  { name: 'Israel/Palestine', bbox: [29.5, 34.2, 33.4, 35.9] },
  { name: 'Iraq', bbox: [29.1, 38.0, 32.5, 49.0] },
  { name: 'Kuwait', bbox: [28.5, 46.5, 30.2, 48.8] },
  { name: 'Bahrain', bbox: [25.7, 50.4, 26.4, 50.9] },
  { name: 'Yemen', bbox: [12.0, 41.5, 17.6, 53.5] },
]

// Riyadh PMS spatial match bbox
const RIYADH_BBOX: [number, number, number, number] = [24.4, 46.4, 25.1, 47.0]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

// ── Step 1: download / load MoT XLSX ──

interface MotStation {
  road_ref: string
  lat: number
  lon: number
  aadt: number
}

async function loadMotStations(): Promise<MotStation[]> {
  const xlsxPath = resolve(CACHE_DIR, 'mot-traffic-density.xlsx')
  if (forceDownload || !existsSync(xlsxPath)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    const url = 'https://mot.gov.sa/documents/7507107/7507109/Traffic+density+on+roads.xlsx/a8c0fb92-e478-5eba-bc50-3435a86e077a?version=1.0&t=1762086812548&download=true'
    console.log(`  Downloading MoT traffic-density XLSX...`)
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
      },
    })
    if (!res.ok) throw new Error(`MoT XLSX HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(xlsxPath, buf)
    console.log(`  Downloaded: ${(buf.length / 1024).toFixed(1)} KB`)
  }

  const wb = xlsxRead(readFileSync(xlsxPath), { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = xlsxUtils.sheet_to_json<any>(sheet, { defval: '' })
  const stations: MotStation[] = []
  for (const r of rows) {
    const roadNo = String(r['Road No.'] ?? '').trim()
    const lat = parseFloat(String(r['Latitude'] ?? ''))
    const lon = parseFloat(String(r['Longitude'] ?? ''))
    const aadtRaw = String(r['24 Hour Total'] ?? '').replace(/[",]/g, '')
    const aadt = parseFloat(aadtRaw)
    if (!roadNo || !lat || !lon || isNaN(aadt) || aadt <= 0) continue
    stations.push({ road_ref: roadNo, lat, lon, aadt })
  }
  console.log(`  MoT stations: ${stations.length}`)
  return stations
}

// Build ref → AADT map (average over all stations on the same road)
function buildRefAadtMap(stations: MotStation[]): Map<string, number> {
  const agg = new Map<string, { sum: number; n: number }>()
  for (const s of stations) {
    const e = agg.get(s.road_ref) || { sum: 0, n: 0 }
    e.sum += s.aadt
    e.n++
    agg.set(s.road_ref, e)
  }
  const out = new Map<string, number>()
  for (const [ref, { sum, n }] of agg) out.set(ref, Math.round(sum / n))
  return out
}

// ── Step 2: download / load ArcGIS feature services ──

interface GeoFeature {
  coords: [number, number][]  // LineString or first ring of MultiLineString
  props: Record<string, any>
}

async function downloadGeoJson(url: string, cachePath: string): Promise<any> {
  if (forceDownload || !existsSync(cachePath)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    console.log(`  Downloading ${cachePath.split('/').pop()}...`)
    const res = await fetch(url, {
      signal: AbortSignal.timeout(300_000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const text = await res.text()
    writeFileSync(cachePath, text)
    console.log(`  Cached: ${(text.length / 1024).toFixed(0)} KB`)
  }
  return JSON.parse(readFileSync(cachePath, 'utf-8'))
}

async function loadRiyadhPms(): Promise<GeoFeature[]> {
  const cachePath = resolve(CACHE_DIR, 'riyadh-pms-lanes.geojson')
  if (!existsSync(cachePath) || forceDownload) {
    const url = 'https://services9.arcgis.com/7cs4rq15YlksXBMf/arcgis/rest/services/RiyadhPMS/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&outSR=4326&resultRecordCount=5000'
    await downloadGeoJson(url, cachePath)
  }
  const fc = JSON.parse(readFileSync(cachePath, 'utf-8'))
  const out: GeoFeature[] = []
  for (const f of fc.features || []) {
    const geom = f.geometry
    if (!geom) continue
    let coords: [number, number][] = []
    if (geom.type === 'LineString') coords = geom.coordinates
    else if (geom.type === 'MultiLineString') coords = geom.coordinates[0] || []
    if (coords.length < 2) continue
    out.push({ coords, props: f.properties || {} })
  }
  console.log(`  Riyadh PMS features: ${out.length}`)
  return out
}

async function loadSauAtlas(): Promise<GeoFeature[]> {
  const cachePath = resolve(CACHE_DIR, 'sau-atlas-roads.geojson')
  if (!existsSync(cachePath) || forceDownload) {
    const base = 'https://services6.arcgis.com/UBlzpwddcwD1J1A0/arcgis/rest/services/Interactive_atlas_of_spatial_features_and_transportation_networks_in_Saudi_Arabia_WFL1/FeatureServer/6/query'
    // Paginated fetch
    const features: any[] = []
    let offset = 0
    while (true) {
      const url = `${base}?where=1%3D1&outFields=*&f=geojson&outSR=4326&resultOffset=${offset}&resultRecordCount=2000`
      console.log(`  Downloading SAU atlas page offset=${offset}...`)
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const page = j.features || []
      features.push(...page)
      if (page.length < 2000) break
      offset += page.length
    }
    writeFileSync(cachePath, JSON.stringify({ type: 'FeatureCollection', features }))
    console.log(`  Cached: ${features.length} features`)
  }
  const fc = JSON.parse(readFileSync(cachePath, 'utf-8'))
  const out: GeoFeature[] = []
  for (const f of fc.features || []) {
    const geom = f.geometry
    if (!geom) continue
    let coords: [number, number][] = []
    if (geom.type === 'LineString') coords = geom.coordinates
    else if (geom.type === 'MultiLineString') coords = geom.coordinates[0] || []
    if (coords.length < 2) continue
    out.push({ coords, props: f.properties || {} })
  }
  console.log(`  SAU Atlas features: ${out.length}`)
  return out
}

// ── Step 3: class/lane → AADT mapping ──

/** Riyadh PMS CLASS + NO_OF_LANE → estimated AADT (both directions combined).
 * Derived from typical Gulf urban arterial volume ranges; MoT station counts
 * are much lower because they're placed on rural corridors, not urban sections.
 * Riyadh central arterials (King Fahd Rd, Northern Ring Rd, etc.) carry 80k+. */
function riyadhPmsAadt(cls: string, lanes: number): number {
  const c = (cls || '').toUpperCase().trim()
  const L = Math.max(1, lanes || 2)
  if (c === 'A') {
    if (L >= 5) return 50000  // King Fahd Rd, Northern Ring Rd, main arterials
    if (L >= 4) return 35000
    return 22000
  }
  if (c === 'B') {
    if (L >= 4) return 18000
    if (L >= 3) return 12000
    return 8000
  }
  if (c === 'C') {
    if (L >= 3) return 6000
    return 3500
  }
  if (c === 'D') {
    if (L >= 2) return 1800
    return 900
  }
  return 4000  // unknown class fallback
}

/** SA Atlas RTT_DESCRI → AADT estimate (rural national averages). */
function sauAtlasAadt(rttDescri: string): number {
  const s = (rttDescri || '').toLowerCase()
  if (s.includes('primary')) return 6000     // Primary Route — rural Saudi highways
  if (s.includes('secondary')) return 1500   // Secondary Route — collector roads
  return 800                                  // Unknown / Local
}

// ── Geometry helpers ──

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

function pointToSegmentDist(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat
  const py = pLat * 110540
  const ax = aLon * 111320 * cosLat
  const ay = aLat * 110540
  const bx = bLon * 111320 * cosLat
  const by = bLat * 110540
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}

/** Distance from a point to a polyline (min over all segments). */
function pointToPolylineDist(pLat: number, pLon: number, coords: [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    if (d < best) best = d
  }
  return best
}

/** Spatial grid index of polylines by integer lat/lon cell (~1 km). */
function buildPolylineGrid(features: GeoFeature[]): Map<string, GeoFeature[]> {
  const grid = new Map<string, GeoFeature[]>()
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

/** Find nearest polyline within search radius via the grid index. */
function nearestInGrid(
  midLat: number, midLon: number,
  grid: Map<string, GeoFeature[]>,
  searchRadiusM: number,
): { feat: GeoFeature; dist: number } | null {
  const reach = Math.max(1, Math.ceil(searchRadiusM / 1000))
  let best: GeoFeature | null = null
  let bestDist = searchRadiusM
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
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
  return best ? { feat: best, dist: bestDist } : null
}

// ── Step 4: enrich roads.arrow ──

function cnossosSplit(aadt: number): { light: number; medium: number; heavy: number; moto: number } {
  // SA has high heavy-vehicle share due to oil/petrochemical freight
  // Light 78%, Medium 10%, Heavy 11%, Moto 1%
  return {
    light: Math.round(aadt * 0.78),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.11),
    moto: Math.round(aadt * 0.01),
  }
}

async function main() {
  console.log(`=== SA Roads Enrichment — MoT + Riyadh PMS + SAU Atlas (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  mkdirSync(CACHE_DIR, { recursive: true })

  // ── Load sources ──
  console.log(`Loading MoT traffic-density XLSX...`)
  const motStations = await loadMotStations()
  const refAadt = buildRefAadtMap(motStations)
  console.log(`  Ref→AADT map: ${refAadt.size} road refs`)
  for (const [ref, aadt] of [...refAadt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    Road ${ref}: ${aadt.toLocaleString()} veh/day (avg of ${motStations.filter(s => s.road_ref === ref).length} station(s))`)
  }

  console.log(`\nLoading Riyadh PMS lanes (ArcGIS FeatureServer)...`)
  const riyadhPms = await loadRiyadhPms()
  const riyadhGrid = buildPolylineGrid(riyadhPms)
  console.log(`  Riyadh PMS grid cells: ${riyadhGrid.size}`)

  console.log(`\nLoading SAU Atlas national roads (ArcGIS FeatureServer)...`)
  const sauAtlas = await loadSauAtlas()
  const atlasGrid = buildPolylineGrid(sauAtlas)
  console.log(`  SAU Atlas grid cells: ${atlasGrid.size}`)

  // ── Iterate SA hexes ──
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, SA_BBOX)) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`\nSA-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let motMatched = 0, pmsMatched = 0, atlasMatched = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const roadPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(roadPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const refCol = table.getChild('ref')
    const highwayCol = table.getChild('highway')
    const existingSourceId = table.getChild('source_id')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')
    const sourceId = new Uint16Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(sourceId[i], MY_DATASET_ID)) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, SA_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      let aadt = 0
      let matchedBy: 'mot' | 'pms' | 'atlas' | null = null

      // Tier 1: MoT ref match
      const ref = String(refCol?.get(i) ?? '').trim()
      if (ref) {
        // ref can be "10;40" or "E65" — try each token, strip letter prefix
        for (const tok of ref.split(/[;,]/)) {
          const clean = tok.trim().replace(/^[A-Za-z]+/, '')
          if (refAadt.has(clean)) {
            aadt = refAadt.get(clean)!
            matchedBy = 'mot'
            motMatched++
            break
          }
        }
      }

      // Tier 2: Riyadh PMS (inside Riyadh bbox only)
      if (!matchedBy && inBbox(midLat, midLon, RIYADH_BBOX)) {
        const near = nearestInGrid(midLat, midLon, riyadhGrid, 200)
        if (near) {
          aadt = riyadhPmsAadt(near.feat.props.CLASS || '', parseInt(near.feat.props.NO_OF_LANE) || 2)
          matchedBy = 'pms'
          pmsMatched++
        }
      }

      // Tier 3: SAU Atlas spatial fallback
      if (!matchedBy) {
        const near = nearestInGrid(midLat, midLon, atlasGrid, 500)
        if (near) {
          aadt = sauAtlasAadt(near.feat.props.RTT_DESCRI || '')
          matchedBy = 'atlas'
          atlasMatched++
        }
      }

      if (!matchedBy || aadt <= 0) continue

      const split = cnossosSplit(aadt)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      hexMatched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }

      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())

      const newTable = makeTable(columns)
      writeFileSync(roadPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length} hexes, ${motMatched + pmsMatched + atlasMatched} matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:     ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip): ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):   ${excluded.toLocaleString()}`)
  console.log(`  Matched by MoT ref:      ${motMatched.toLocaleString()}`)
  console.log(`  Matched by Riyadh PMS:   ${pmsMatched.toLocaleString()}`)
  console.log(`  Matched by SAU Atlas:    ${atlasMatched.toLocaleString()}`)
  const totalMatched = motMatched + pmsMatched + atlasMatched
  console.log(`  Total matched:           ${totalMatched.toLocaleString()} (${(100 * totalMatched / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:           ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
