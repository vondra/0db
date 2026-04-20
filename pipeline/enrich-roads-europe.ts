/**
 * Continental road enrichment (Europe): EU city traffic volume dataset.
 *
 * Downloads harmonized traffic data from 36 European cities (Nature Scientific Data, 2025),
 * matches to OSM road segments by osm_id, writes aadt_light + aadt_heavy + traffic_source=1
 * into roads.arrow for each matching H3R4 hex.
 *
 * Dataset: "Harmonized Annual Averaged Traffic Data at Street Segment Level for European Cities"
 * GitHub: https://github.com/XavB64/traffic-volume-data-EU-cities
 * License: CC BY 4.0
 *
 * Each city's treated/ folder contains GeoJSON files with AADT + optional TR_AADT (truck AADT),
 * already matched to OSM way IDs (osmid column). We use direct osm_id join — no proximity needed.
 *
 * Usage:
 *   cd pipeline && npx tsx enrich-roads-europe.ts
 *   cd pipeline && npx tsx enrich-roads-europe.ts --force-download
 *   cd pipeline && npx tsx enrich-roads-europe.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { latLngToCell } from 'h3-js'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('eu-city-traffic')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, '../data/enrichment/global/eu-city-traffic')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const REPO_BASE = 'https://raw.githubusercontent.com/XavB64/traffic-volume-data-EU-cities/main'
const API_BASE = 'https://api.github.com/repos/XavB64/traffic-volume-data-EU-cities/contents'

// Cities with treated_data=True from cities_summary.csv.
// Format: [country_folder, city_folder, city_name]
// We pick the latest year available for each city.
const CITIES: [string, string, string][] = [
  ['Austria', 'Vienna', 'Vienna'],
  ['Czechia', 'Brno', 'Brno'],
  ['Denmark', 'Copenhagen', 'Copenhagen'],
  ['Finland', 'Helsinki', 'Helsinki'],
  ['France', 'Paris', 'Paris'],
  ['France', 'Grenoble', 'Grenoble'],
  ['France', 'Toulouse', 'Toulouse'],
  ['France', 'Lyon', 'Lyon'],
  ['France', 'Lille', 'Lille'],
  ['France', 'Bordeaux', 'Bordeaux'],
  ['France', 'Rennes', 'Rennes'],
  ['France', 'Marseille', 'Marseille'],
  ['France', 'Rouen', 'Rouen'],
  ['France', 'Montpellier', 'Montpellier'],
  ['France', 'Tours', 'Tours'],
  ['Germany', 'Berlin', 'Berlin'],
  ['Germany', 'Hamburg', 'Hamburg'],
  ['Ireland', 'Dublin', 'Dublin'],
  ['Italy', 'Milan', 'Milan'],
  ['Luxembourg', 'Luxembourg', 'Luxembourg'],
  ['Netherlands', 'Amsterdam', 'Amsterdam'],
  ['Norway', 'Oslo', 'Oslo'],
  ['Portugal', 'Lisbon', 'Lisbon'],
  ['Spain', 'Valencia', 'Valencia'],
  ['Spain', 'Barcelona', 'Barcelona'],
  ['Spain', 'Madrid', 'Madrid'],
  ['Sweden', 'Malmo', 'Malmo'],
  ['Sweden', 'Stockholm', 'Stockholm'],
  ['Switzerland', 'Zurich', 'Zurich'],
  ['Switzerland', 'Geneva', 'Geneva'],
  ['United Kingdom', 'London', 'London'],
  ['United Kingdom', 'Birmingham', 'Birmingham'],
  ['United Kingdom', 'Manchester', 'Manchester'],
  ['United Kingdom', 'Glasgow', 'Glasgow'],
  ['United Kingdom', 'Edinburgh', 'Edinburgh'],
  ['United Kingdom', 'Cardiff', 'Cardiff'],
]

// ── Types ──

interface TrafficRecord {
  aadt: number          // total AADT (vehicles/day)
  truckAadt: number     // truck AADT (0 if not available)
  twoWheelAadt: number  // 2-wheel AADT (0 if not available)
  isOneway: boolean     // raw_oneway — if true, AADT is one-direction only
  lat: number
  lon: number
}

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * 110540
  const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180)
  return Math.sqrt(dx * dx + dy * dy)
}

// ── Step 1: Download GeoJSON files ──

/** Discover treated GeoJSON files for a city via GitHub API */
async function discoverFiles(country: string, city: string): Promise<string[]> {
  const path = encodeURIComponent(`${country}/${city}/treated`)
    .replace(/%2F/g, '/')
  const url = `${API_BASE}/${path}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'Accept': 'application/vnd.github.v3+json' },
  })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`GitHub API ${res.status} for ${url}`)
  }

  const items = await res.json() as { name: string; download_url: string }[]
  return items
    .filter(i => i.name.endsWith('.geojson') || i.name.endsWith('.GeoJSON'))
    .map(i => i.name)
    .sort()  // alphabetical = chronological for same-format names
}

/** Pick the latest-year file from a list of GeoJSON filenames */
function pickLatestFile(files: string[]): string | null {
  if (files.length === 0) return null

  // Extract year from filenames like "Berlin_AADT_AAWT_2023.geojson"
  let best: string | null = null
  let bestYear = 0
  for (const f of files) {
    const m = f.match(/(\d{4})\.geojson$/i)
    if (m) {
      const year = parseInt(m[1])
      if (year > bestYear) {
        bestYear = year
        best = f
      }
    }
  }
  return best || files[files.length - 1]  // fallback to last alphabetically
}

/** Download a single city's GeoJSON, caching locally */
async function downloadCity(
  country: string, city: string, cityName: string
): Promise<any | null> {
  const cacheFile = resolve(CACHE_DIR, `${cityName.toLowerCase()}.geojson`)

  // Check cache
  if (enrichOnly || (!forceDownload && existsSync(cacheFile))) {
    if (!existsSync(cacheFile)) {
      console.log(`  SKIP ${cityName}: --enrich-only but no cache`)
      return null
    }
    return JSON.parse(readFileSync(cacheFile, 'utf-8'))
  }

  // Discover available files
  const files = await discoverFiles(country, city)
  const chosen = pickLatestFile(files)
  if (!chosen) {
    console.log(`  SKIP ${cityName}: no treated GeoJSON files found`)
    return null
  }

  // Download
  const encodedPath = `${country}/${city}/treated/${chosen}`
    .split('/').map(encodeURIComponent).join('/')
  const url = `${REPO_BASE}/${encodedPath}`
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) {
    console.log(`  SKIP ${cityName}: download failed (${res.status})`)
    return null
  }

  const text = await res.text()
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, text)

  const data = JSON.parse(text)
  const n = data.features?.length || 0
  console.log(`  ${cityName}: downloaded ${chosen} (${n} features, ${(text.length / 1024).toFixed(0)} KB)`)
  return data
}

// ── Step 2: Parse GeoJSON → TrafficRecords grouped by H3R4 hex ──

function parseCity(geojson: any): Map<string, TrafficRecord[]> {
  const byHex = new Map<string, TrafficRecord[]>()
  const features = geojson.features || []

  for (const f of features) {
    const props = f.properties || {}
    const geom = f.geometry

    // Must have AADT
    const aadt = props.AADT ?? props.AAWT ?? 0
    if (!aadt || aadt <= 0) continue

    const truckAadt = props.TR_AADT ?? props.TR_AAWT ?? 0
    const twoWheelAadt = props['2W_AADT'] ?? props['2W_AAWT'] ?? 0
    const isOneway = props.raw_oneway === true

    // Get representative coordinate for H3 hex lookup
    let lat: number, lon: number
    if (!geom || !geom.coordinates) continue

    if (geom.type === 'Point') {
      lon = geom.coordinates[0]
      lat = geom.coordinates[1]
    } else if (geom.type === 'LineString') {
      // Midpoint of line
      const coords = geom.coordinates as number[][]
      const mid = Math.floor(coords.length / 2)
      lon = coords[mid][0]
      lat = coords[mid][1]
    } else {
      continue
    }

    if (isNaN(lat) || isNaN(lon)) continue

    // Compute H3R4 hex
    let h3r4: string
    try {
      h3r4 = latLngToCell(lat, lon, 4)
    } catch {
      continue
    }

    const record: TrafficRecord = {
      aadt: Math.round(aadt),
      truckAadt: Math.max(0, Math.round(truckAadt)),
      twoWheelAadt: Math.max(0, Math.round(twoWheelAadt)),
      isOneway,
      lat,
      lon,
    }

    let list = byHex.get(h3r4)
    if (!list) {
      list = []
      byHex.set(h3r4, list)
    }
    list.push(record)
  }

  return byHex
}

// ── Step 3: Enrich Arrow files ──

function enrichHexes(allRecords: Map<string, TrafficRecord[]>): {
  totalRoads: number
  totalMatched: number
  hexesUpdated: number
  matchByClass: Map<number, { matched: number; total: number }>
} {
  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalRoads = 0
  let totalMatched = 0
  let hexesUpdated = 0
  const matchByClass = new Map<number, { matched: number; total: number }>()

  let lastProgress = Date.now()
  let hexesProcessed = 0

  for (const hexId of hexDirs) {
    hexesProcessed++

    // Progress every 10s
    if (Date.now() - lastProgress > 10_000) {
      console.log(`  progress: ${hexesProcessed}/${hexDirs.length} hexes, ${totalMatched} matched so far`)
      lastProgress = Date.now()
    }

    // Check if this hex has any traffic records
    const records = allRecords.get(hexId)
    if (!records || records.length === 0) continue

    const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
    if (!existsSync(roadsPath)) continue

    const buf = readFileSync(roadsPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalRoads += n

    // Build spatial grid from traffic records for fast proximity lookup
    const CELL = 0.001 // ~111m grid cells
    const grid = new Map<string, TrafficRecord[]>()
    for (const r of records) {
      const key = `${Math.floor(r.lat / CELL)},${Math.floor(r.lon / CELL)}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(r)
    }

    const startLatCol = table.getChild('start_lat')!
    const startLonCol = table.getChild('start_lon')!
    const endLatCol = table.getChild('end_lat')!
    const endLonCol = table.getChild('end_lon')!
    const roadClassCol = table.getChild('road_class')
    const onewayCol = table.getChild('oneway')

    // Existing enrichment columns (may exist from previous run)
    const existingAadtLight = table.getChild('aadt_light')
    const existingAadtMedium = table.getChild('aadt_medium')
    const existingAadtHeavy = table.getChild('aadt_heavy')
    const existingAadtMoto = table.getChild('aadt_moto')
    const existingTrafficSource = table.getChild('traffic_source')
    const existingDatasetId = table.getChild('roads_dataset_id')

    // Seed output columns from whatever's already in the Arrow (per-row state).
    // `shouldOverwrite()` then decides if we replace with eu-city-traffic data.
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    const trafficSource = new Uint8Array(n)
    const datasetId = new Uint16Array(n)

    for (let i = 0; i < n; i++) {
      aadtLight[i] = existingAadtLight ? (existingAadtLight.get(i) as number) ?? 0 : 0
      aadtMedium[i] = existingAadtMedium ? (existingAadtMedium.get(i) as number) ?? 0 : 0
      aadtHeavy[i] = existingAadtHeavy ? (existingAadtHeavy.get(i) as number) ?? 0 : 0
      aadtMoto[i] = existingAadtMoto ? (existingAadtMoto.get(i) as number) ?? 0 : 0
      trafficSource[i] = existingTrafficSource ? (existingTrafficSource.get(i) as number) ?? 0 : 0
      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    }

    let hexMatched = 0
    const MAX_DIST = 50 // meters

    for (let i = 0; i < n; i++) {
      const roadClass = roadClassCol ? (roadClassCol.get(i) as number) : 5
      if (!matchByClass.has(roadClass)) matchByClass.set(roadClass, { matched: 0, total: 0 })
      matchByClass.get(roadClass)!.total++

      // Priority check: if a higher-priority dataset already owns this row, leave it alone.
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) {
        if (datasetId[i] !== 0) {
          matchByClass.get(roadClass)!.matched++
          hexMatched++
        }
        continue
      }

      // Midpoint of Arrow road segment
      const midLat = ((startLatCol.get(i) as number) + (endLatCol.get(i) as number)) / 2
      const midLon = ((startLonCol.get(i) as number) + (endLonCol.get(i) as number)) / 2

      // Search nearby grid cells for closest traffic record
      const cy = Math.floor(midLat / CELL)
      const cx = Math.floor(midLon / CELL)
      let bestDist = MAX_DIST + 1
      let record: TrafficRecord | null = null
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const candidates = grid.get(`${cy + dy},${cx + dx}`)
          if (!candidates) continue
          for (const c of candidates) {
            const d = flatDist(midLat, midLon, c.lat, c.lon)
            if (d < bestDist) { bestDist = d; record = c; }
          }
        }
      }
      if (!record) continue

      // Convert directional → bidirectional total.
      // Arrow stores bidirectional total; pipeline-worker applies oneway_factor=0.5.
      // Dataset raw_oneway=true means the measurement is for ONE direction only.
      const dirFactor = record.isOneway ? 2 : 1

      const totalAadt = record.aadt * dirFactor
      const lightAadt = totalAadt - (record.truckAadt * dirFactor) - (record.twoWheelAadt * dirFactor)

      // Whole-row atomic write — payload + dataset_id together, gated by priority above.
      aadtLight[i] = Math.max(0, Math.round(lightAadt))
      aadtMedium[i] = 0  // dataset doesn't distinguish medium vehicles
      aadtHeavy[i] = Math.max(0, Math.round(record.truckAadt * dirFactor))
      aadtMoto[i] = Math.max(0, Math.round(record.twoWheelAadt * dirFactor))
      trafficSource[i] = 1
      datasetId[i] = MY_DATASET_ID
      hexMatched++
      matchByClass.get(roadClass)!.matched++
    }

    if (hexMatched === 0) continue

    // Copy ALL existing columns by iterating schema
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      columns[field.name] = table.getChild(field.name)!
    }

    // Add/overwrite enrichment columns
    columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
    columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
    columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
    columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
    columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())
    columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())

    const newTable = makeTable(columns)
    // MUST use 'file' format — Rust FileReader requires ARROW1 magic bytes
    writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++
  }

  return { totalRoads, totalMatched, hexesUpdated, matchByClass }
}

// ── Main ──

async function main() {
  console.log(`=== EU City Traffic Enrichment (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Download and parse all cities
  const allRecords = new Map<string, TrafficRecord[]>()
  let totalFeatures = 0
  let citiesLoaded = 0
  let lastProgress = Date.now()

  for (const [country, city, cityName] of CITIES) {
    if (Date.now() - lastProgress > 10_000) {
      console.log(`  download progress: ${citiesLoaded}/${CITIES.length} cities`)
      lastProgress = Date.now()
    }

    try {
      const geojson = await downloadCity(country, city, cityName)
      if (!geojson) continue

      const byHex = parseCity(geojson)
      let cityFeatures = 0

      for (const [hex, records] of byHex) {
        let existing = allRecords.get(hex)
        if (!existing) {
          existing = []
          allRecords.set(hex, existing)
        }
        existing.push(...records)
        cityFeatures += records.length
      }

      totalFeatures += cityFeatures
      citiesLoaded++
      console.log(`  ${cityName}: ${cityFeatures} records in ${byHex.size} hexes`)
    } catch (err) {
      console.log(`  SKIP ${cityName}: ${(err as Error).message}`)
    }
  }

  console.log(`\n  Total: ${totalFeatures} traffic records from ${citiesLoaded} cities in ${allRecords.size} hexes\n`)

  if (totalFeatures === 0) {
    console.log('  No traffic records to enrich. Done.')
    return
  }

  // Enrich Arrow files
  console.log('  Enriching Arrow files...')
  const { totalRoads, totalMatched, hexesUpdated, matchByClass } = enrichHexes(allRecords)

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRoads} segments enriched in matched hexes`)
  console.log(`  ${hexesUpdated} / ${allRecords.size} hexes updated`)
  console.log(`\n  Per road class:`)

  const classNames = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_st']
  for (const [cls, stats] of [...matchByClass.entries()].sort((a, b) => a[0] - b[0])) {
    const pct = stats.total > 0 ? (stats.matched / stats.total * 100).toFixed(1) : '0.0'
    console.log(`    ${(classNames[cls] || `class_${cls}`).padEnd(12)} ${stats.matched} / ${stats.total} (${pct}%)`)
  }

  // Write provenance
  const provPath = resolve(CACHE_DIR, 'provenance.md')
  const provenance = `# EU City Traffic Enrichment Provenance

## Sources used
- **EU city traffic**: "Harmonized Annual Averaged Traffic Data at Street Segment Level for European Cities"
  - GitHub: https://github.com/XavB64/traffic-volume-data-EU-cities
  - Paper: Nature Scientific Data, 2025
  - License: CC BY 4.0
  - ${citiesLoaded} cities, ${totalFeatures} traffic records
  - Downloaded: ${new Date().toISOString().split('T')[0]}

## Matching
- Direct osm_id join (dataset already matched to OSM way IDs)
- ${totalMatched} segments enriched across ${hexesUpdated} H3R4 hexes
- Preserves existing country-specific enrichment (traffic_source=1 from prior runs)
- Directional correction: raw_oneway=true measurements doubled to bidirectional total
- AADT split: light = total - truck - 2wheel; heavy = TR_AADT; moto = 2W_AADT

## Cities included
${CITIES.map(c => `- ${c[2]} (${c[0]})`).join('\n')}

## Gaps
- No vehicle class breakdown for many cities (only total AADT)
- Point geometries (sensor locations) matched via osmid, not spatial proximity
- Some cities have low OSM matching rates (see dataset's osm_distance column)
`
  writeFileSync(provPath, provenance)

  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
