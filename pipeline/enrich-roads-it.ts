/**
 * Enrich IT roads.arrow with ANAS TGM (Traffico Giornaliero Medio = AADT) data.
 *
 * Downloads shapefile from MIT open data portal, converts to GeoJSON via ogr2ogr,
 * parses road geometries + TGM values, matches to OSM road segments by proximity
 * (nearest within 50m), adds aadt_light + traffic_source=1 columns to Arrow.
 *
 * Source: Ministero delle Infrastrutture e dei Trasporti — TGM Nov 2015
 * https://dati.mit.gov.it/catalog/dataset/a9b851f0-cb05-4e7e-ae43-040926a368db
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-it.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-it.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-it.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/it`)
const CACHE_GEOJSON = resolve(CACHE_DIR, 'tgm-roads.geojson')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const TGM_URL = 'https://dati.mit.gov.it/catalog/dataset/a9b851f0-cb05-4e7e-ae43-040926a368db/resource/09935ff0-da89-4b11-afe9-9902fad9ea57/download/tgm_nov2015.zip'

// Italy bounding box (lat/lon) for sanity checks
const IT_BBOX = { minLat: 35.5, maxLat: 47.1, minLon: 6.6, maxLon: 18.6 }

// ── Types ──

interface TgmSegment {
  aadt: number         // TGM value (total AADT)
  lat: number          // centroid latitude
  lon: number          // centroid longitude
  coords: [number, number][]  // full geometry for precise matching
}

// ── Step 1: Download + convert shapefile ──

async function downloadAndConvert(): Promise<any> {
  if (!forceDownload && existsSync(CACHE_GEOJSON) && !enrichOnly) {
    console.log(`  Using cached GeoJSON: ${CACHE_GEOJSON}`)
    return JSON.parse(readFileSync(CACHE_GEOJSON, 'utf-8'))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_GEOJSON)) {
      console.error('ERROR: --enrich-only but no cached data found')
      process.exit(1)
    }
    return JSON.parse(readFileSync(CACHE_GEOJSON, 'utf-8'))
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  const zipPath = resolve(CACHE_DIR, 'tgm_nov2015.zip')
  const shpDir = resolve(CACHE_DIR, 'shp')

  // Download ZIP
  console.log('  Downloading TGM shapefile from MIT...')
  const res = await fetch(TGM_URL, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`TGM download error: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(zipPath, buf)
  console.log(`  Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)

  // Extract
  mkdirSync(shpDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${shpDir}"`, { timeout: 60_000 })

  // Find .shp file(s) in extracted contents
  const shpFiles = findFiles(shpDir, '.shp')
  if (shpFiles.length === 0) {
    throw new Error(`No .shp files found in extracted archive at ${shpDir}`)
  }
  console.log(`  Found ${shpFiles.length} shapefile(s): ${shpFiles.map(f => f.split('/').pop()).join(', ')}`)

  // Convert to GeoJSON via ogr2ogr (reproject to WGS84)
  const shpFile = shpFiles[0]
  console.log(`  Converting ${shpFile.split('/').pop()} to GeoJSON via ogr2ogr...`)
  execSync(
    `ogr2ogr -f GeoJSON -t_srs EPSG:4326 "${CACHE_GEOJSON}" "${shpFile}"`,
    { timeout: 120_000 }
  )

  // Clean up
  execSync(`rm -rf "${shpDir}" "${zipPath}"`)

  const geojson = JSON.parse(readFileSync(CACHE_GEOJSON, 'utf-8'))
  console.log(`  Converted: ${geojson.features?.length || 0} features`)
  return geojson
}

/** Recursively find files with given extension */
function findFiles(dir: string, ext: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, ext))
    } else if (entry.name.toLowerCase().endsWith(ext)) {
      results.push(fullPath)
    }
  }
  return results
}

// ── Step 2: Parse GeoJSON into TGM segments ──

function parseTgmFeatures(geojson: any): TgmSegment[] {
  const segments: TgmSegment[] = []
  const features = geojson.features || []

  // Log available property names from first feature for debugging
  if (features.length > 0) {
    const props = Object.keys(features[0].properties || {})
    console.log(`  Feature properties: ${props.join(', ')}`)
  }

  let skippedNoAadt = 0
  let skippedNoGeom = 0
  let skippedOutOfBounds = 0

  for (const f of features) {
    const props = f.properties || {}
    const geom = f.geometry

    if (!geom || !geom.coordinates) { skippedNoGeom++; continue }

    // Try common field names for TGM/AADT value
    const aadt = findAadtValue(props)
    if (!aadt || aadt <= 0) { skippedNoAadt++; continue }

    // Extract coordinates — handle LineString and MultiLineString
    let coords: [number, number][] = []
    if (geom.type === 'LineString') {
      coords = geom.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number])
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        coords.push(...line.map((c: number[]) => [c[1], c[0]] as [number, number]))
      }
    } else if (geom.type === 'Point') {
      coords = [[geom.coordinates[1], geom.coordinates[0]]]
    } else {
      continue
    }

    if (coords.length === 0) continue

    // Compute centroid
    const lat = coords.reduce((s, c) => s + c[0], 0) / coords.length
    const lon = coords.reduce((s, c) => s + c[1], 0) / coords.length

    // Bounding box check
    if (lat < IT_BBOX.minLat || lat > IT_BBOX.maxLat ||
        lon < IT_BBOX.minLon || lon > IT_BBOX.maxLon) {
      skippedOutOfBounds++
      continue
    }

    segments.push({ aadt, lat, lon, coords })
  }

  console.log(`  Parsed ${segments.length} TGM segments`)
  if (skippedNoAadt > 0) console.log(`  Skipped (no AADT value): ${skippedNoAadt}`)
  if (skippedNoGeom > 0) console.log(`  Skipped (no geometry): ${skippedNoGeom}`)
  if (skippedOutOfBounds > 0) console.log(`  Skipped (out of bounds): ${skippedOutOfBounds}`)

  // AADT distribution
  const aadts = segments.map(s => s.aadt).sort((a, b) => a - b)
  if (aadts.length > 0) {
    console.log(`  AADT range: ${aadts[0]} - ${aadts[aadts.length - 1]}, median: ${aadts[Math.floor(aadts.length / 2)]}`)
  }

  return segments
}

/** Try to find the AADT/TGM value from shapefile properties.
 *  The MIT TGM shapefile uses various field names. */
function findAadtValue(props: Record<string, any>): number {
  // Common field names in Italian traffic data:
  // TGM = Traffico Giornaliero Medio (AADT equivalent)
  // TGM_TOT, TGM_TOTALE, TGMTOT, TGM
  // AADT, ADT
  const candidates = [
    'TGM', 'tgm', 'Tgm',
    'TGM_TOT', 'tgm_tot', 'TGM_TOTALE', 'tgm_totale',
    'TGMTOT', 'tgmtot',
    'TGM_TOTAL', 'tgm_total',
    'AADT', 'aadt', 'ADT', 'adt',
    'TRAFFICO', 'traffico',
    'MEDIA', 'media',
    'TGM_2015', 'tgm_2015',
    'TGM_NOV', 'tgm_nov',
    'VOLUME', 'volume',
    'FLUSSO', 'flusso',
  ]

  for (const key of candidates) {
    const v = props[key]
    if (v !== undefined && v !== null) {
      const num = typeof v === 'number' ? v : parseFloat(String(v))
      if (!isNaN(num) && num > 0) return Math.round(num)
    }
  }

  // Fallback: try any numeric field with a plausible AADT range
  for (const [key, v] of Object.entries(props)) {
    if (typeof v === 'number' && v >= 100 && v <= 200_000) {
      // Heuristic: large-ish integer in traffic range
      if (/tgm|traffic|flusso|volume|media|veicol/i.test(key)) {
        return Math.round(v)
      }
    }
  }

  return 0
}

// ── Step 3: Enrich Arrow files ──

/** Distance from point to line segment in meters */
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
  const ddx = px - cx
  const ddy = py - cy
  return Math.sqrt(ddx * ddx + ddy * ddy)
}

/** Flat-earth distance in meters */
function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

/** Distance from point (lat,lon) to a polyline (array of [lat,lon]) in meters */
function pointToPolylineDist(pLat: number, pLon: number, coords: [number, number][]): number {
  if (coords.length === 0) return Infinity
  if (coords.length === 1) return flatDist(pLat, pLon, coords[0][0], coords[0][1])

  let minDist = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    if (d < minDist) minDist = d
  }
  return minDist
}

function enrichHexes(tgmSegments: TgmSegment[]): void {
  // Build spatial grid (0.01 deg ~ 1km cells) for TGM segments
  const grid = new Map<string, TgmSegment[]>()
  for (const seg of tgmSegments) {
    const key = `${Math.floor(seg.lat * 100)}_${Math.floor(seg.lon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(seg)
  }

  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalRoads = 0
  let totalMatched = 0
  let hexesUpdated = 0
  const matchByClass = new Map<number, { matched: number; total: number }>()
  const startTime = Date.now()

  for (const hexId of hexDirs) {
    const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
    if (!existsSync(roadsPath)) continue

    const buf = readFileSync(roadsPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const roadClassCol = table.getChild('road_class')

    // Check if any road in this hex is within Italy's bbox
    let hasItalianRoads = false
    for (let i = 0; i < Math.min(n, 20); i++) {
      const lat = (startLat.get(i) as number + endLat.get(i) as number) / 2
      const lon = (startLon.get(i) as number + endLon.get(i) as number) / 2
      if (lat >= IT_BBOX.minLat && lat <= IT_BBOX.maxLat &&
          lon >= IT_BBOX.minLon && lon <= IT_BBOX.maxLon) {
        hasItalianRoads = true
        break
      }
    }
    if (!hasItalianRoads) continue

    totalRoads += n

    // Read existing columns
    const existingAadtLight = table.getChild('aadt_light')
    const existingTrafficSource = table.getChild('traffic_source')

    const aadtLight = new Int32Array(n)
    const trafficSource = new Uint8Array(n)

    // Preserve existing enrichments
    for (let i = 0; i < n; i++) {
      aadtLight[i] = existingAadtLight ? (existingAadtLight.get(i) as number ?? 0) : 0
      trafficSource[i] = existingTrafficSource ? (existingTrafficSource.get(i) as number ?? 0) : 0
    }

    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      // Skip segments already enriched by another source
      if (trafficSource[i] > 0) continue

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      // Skip if outside Italy
      if (midLat < IT_BBOX.minLat || midLat > IT_BBOX.maxLat ||
          midLon < IT_BBOX.minLon || midLon > IT_BBOX.maxLon) continue

      const roadClass = roadClassCol ? (roadClassCol.get(i) as number) : 5
      if (!matchByClass.has(roadClass)) matchByClass.set(roadClass, { matched: 0, total: 0 })
      matchByClass.get(roadClass)!.total++

      // Find nearest TGM segment within 50m
      const gridKey = `${Math.floor(midLat * 100)}_${Math.floor(midLon * 100)}`
      let bestDist = 50 // max 50m
      let bestSeg: TgmSegment | null = null

      // Check 3x3 grid cells around the road midpoint
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${Math.floor(midLat * 100) + dy}_${Math.floor(midLon * 100) + dx}`
          const cell = grid.get(k)
          if (!cell) continue
          for (const seg of cell) {
            // Quick centroid distance pre-filter (skip if > 2km away)
            const centroidDist = flatDist(midLat, midLon, seg.lat, seg.lon)
            if (centroidDist > 2000) continue

            // Precise: distance from road midpoint to TGM polyline
            const d = pointToPolylineDist(midLat, midLon, seg.coords)
            if (d < bestDist) {
              bestDist = d
              bestSeg = seg
            }
          }
        }
      }

      if (!bestSeg) continue

      aadtLight[i] = bestSeg.aadt
      trafficSource[i] = 1
      hexMatched++
      matchByClass.get(roadClass)!.matched++
    }

    if (hexMatched === 0) continue

    // Copy ALL existing columns
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (field.name === 'aadt_light' || field.name === 'traffic_source') continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
    columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())

    const newTable = makeTable(columns)
    // MUST use 'file' format — Rust FileReader requires ARROW1 magic bytes
    writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++

    // Progress every 10s
    const elapsed = Date.now() - startTime
    if (elapsed > 0 && hexesUpdated % 10 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hexesUpdated} hexes updated, ${totalMatched} segments matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRoads} segments matched (${totalRoads > 0 ? (totalMatched / totalRoads * 100).toFixed(1) : 0}%)`)
  console.log(`  ${hexesUpdated} hexes updated`)
  console.log(`\n  Per road class:`)
  for (const [cls, stats] of [...matchByClass.entries()].sort((a, b) => a[0] - b[0])) {
    const names = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_st']
    const pct = stats.total > 0 ? (stats.matched / stats.total * 100).toFixed(1) : '0.0'
    console.log(`    ${(names[cls] || `class_${cls}`).padEnd(12)} ${stats.matched} / ${stats.total} (${pct}%)`)
  }
}

// ── Main ──

async function main() {
  console.log(`=== IT Road Traffic Enrichment — ANAS TGM (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const geojson = await downloadAndConvert()
  const features = geojson.features || []
  console.log(`\n  Parsing ${features.length} TGM features...`)

  const tgmSegments = parseTgmFeatures(geojson)
  if (tgmSegments.length === 0) {
    console.error('ERROR: No valid TGM segments found. Check shapefile properties.')
    process.exit(1)
  }

  console.log(`\n  Enriching roads.arrow files...`)
  enrichHexes(tgmSegments)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
