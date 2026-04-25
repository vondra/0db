/**
 * Enrich DE roads.arrow with BASt SVZ 2021 traffic census data.
 *
 * Downloads Autobahnen + Bundesstraßen Excel files from BASt, parses
 * per-section vehicle class counts, converts UTM32→WGS84, matches to
 * OSM roads by ref tag + proximity, writes aadt_* columns.
 *
 * Vehicle class mapping (BASt → CNOSSOS):
 *   LVm  (cars + light vans)        → aadt_light   (Category 1)
 *   Bus + LoA (buses + medium trucks) → aadt_medium  (Category 2)
 *   LZ   (heavy trucks + trailer)   → aadt_heavy   (Category 3)
 *   Krad (motorcycles)               → aadt_moto    (Category 4)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-de.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-de.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-de.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import proj4 from 'proj4'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_DE_BAST_AUTOBAHN, SOURCE_ID_DE_BAST_BUNDESSTRASSEN } from './lib/source-ids.generated.js'

// CensusSection.ref starts with 'A' for Autobahn, 'B' for Bundesstraßen — pick per row.
const AUTOBAHN_DATASET_ID = SOURCE_ID_DE_BAST_AUTOBAHN
const BUNDESSTR_DATASET_ID = SOURCE_ID_DE_BAST_BUNDESSTRASSEN
const MY_SOURCE_ID = AUTOBAHN_DATASET_ID  // default for gating; actual write picks per row

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/de`)
const CACHE_AUTOBAHN = resolve(CACHE_DIR, 'svz-autobahnen-2021.xlsx')
const CACHE_BUNDESSTR = resolve(CACHE_DIR, 'svz-bundesstrassen-2021.xlsx')
const CACHE_JSON = resolve(CACHE_DIR, 'svz-census.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// BASt download URLs (need ?__blob=publicationFile parameter)
const AUTOBAHN_URL = 'https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/2021/Autobahnen-2021.xlsx?__blob=publicationFile&v=1'
const BUNDESSTR_URL = 'https://www.bast.de/DE/Publikationen/Statistik/Verkehrsdaten/2021/Bundesstrassen-2021.xlsx?__blob=publicationFile&v=1'

// EPSG:25832 (ETRS89 / UTM zone 32N) → WGS84
proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')
const toWGS84 = (x: number, y: number): [number, number] => {
  const [lon, lat] = proj4('EPSG:25832', 'WGS84', [x, y])
  return [lat, lon]
}

// ── Types ──

interface CensusSection {
  road: string          // "A 1", "B 4"
  ref: string           // normalized: "A1", "B4"
  tkzst: string         // counting station ID
  lat: number
  lon: number
  dtv: number           // total AADT
  aadt_light: number    // LVm (cars + light vans)
  aadt_medium: number   // Bus + LoA
  aadt_heavy: number    // LZ (heavy trucks + trailer)
  aadt_moto: number     // Krad (motorcycles)
}

// ── Step 1: Download BASt SVZ Excel files ──

async function downloadSvz(): Promise<CensusSection[]> {
  // Check for pre-parsed JSON cache
  if (!forceDownload && existsSync(CACHE_JSON)) {
    console.log(`  Using cached parsed data: ${CACHE_JSON}`)
    return JSON.parse(readFileSync(CACHE_JSON, 'utf-8'))
  }
  if (enrichOnly && !existsSync(CACHE_JSON)) {
    // Try to parse from Excel cache
    if (existsSync(CACHE_AUTOBAHN) && existsSync(CACHE_BUNDESSTR)) {
      console.log('  Parsing from cached Excel files...')
      return await parseBothFiles()
    }
    console.error('ERROR: --enrich-only but no cached data found')
    process.exit(1)
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  // Download both Excel files
  for (const [url, path, name] of [
    [AUTOBAHN_URL, CACHE_AUTOBAHN, 'Autobahnen'],
    [BUNDESSTR_URL, CACHE_BUNDESSTR, 'Bundesstraßen'],
  ] as const) {
    if (!forceDownload && existsSync(path)) {
      console.log(`  Using cached ${name}: ${path}`)
      continue
    }
    console.log(`  Downloading ${name} from BASt...`)
    const res = await fetch(url, {
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (QuietMap noise enrichment)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
    console.log(`  Cached ${name}: ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
  }

  return await parseBothFiles()
}

async function parseBothFiles(): Promise<CensusSection[]> {
  const XLSX = (await import('xlsx')).default || await import('xlsx')
  const sections: CensusSection[] = []

  for (const [path, label] of [
    [CACHE_AUTOBAHN, 'Autobahnen'],
    [CACHE_BUNDESSTR, 'Bundesstraßen'],
  ] as const) {
    const wb = XLSX.readFile(path)
    const ws = wb.Sheets['Zeilenformat']
    if (!ws) {
      console.log(`  WARN: No Zeilenformat sheet in ${label}`)
      continue
    }

    const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
    const headers = data[0] as string[]

    // Find column indices
    const col = (name: string): number => {
      const idx = headers.indexOf(name)
      if (idx < 0) console.log(`  WARN: Column ${name} not found in ${label}`)
      return idx
    }

    const iStr = col('Str')
    const iTKZST = col('TKZST')
    const iDTV = col('DTV')
    const iLVm = col('DTVLVm')
    const iBus = col('DTVBus')
    const iLoA = col('DTVLoA')
    const iLZ = col('DTVLZ')
    const iKrad = col('DTVKrad')
    const iX = col('X_Koordinate')
    const iY = col('Y_Koordinate')

    let parsed = 0
    let skipped = 0
    for (let i = 1; i < data.length; i++) {
      const row = data[i]
      const road = String(row[iStr] || '').trim()
      const x = Number(row[iX])
      const y = Number(row[iY])
      const dtv = Number(row[iDTV])

      if (!road || !x || !y || x < 100000 || y < 5000000 || !dtv) {
        skipped++
        continue
      }

      const [lat, lon] = toWGS84(x, y)
      if (lat < 47 || lat > 55.5 || lon < 5.5 || lon > 15.5) {
        skipped++ // outside Germany
        continue
      }

      const ref = road.replace(/\s+/g, '')  // "A 1" → "A1"

      sections.push({
        road,
        ref,
        tkzst: String(row[iTKZST] || ''),
        lat, lon,
        dtv: Math.round(dtv),
        aadt_light: Math.round(Number(row[iLVm]) || 0),
        aadt_medium: Math.round((Number(row[iBus]) || 0) + (Number(row[iLoA]) || 0)),
        aadt_heavy: Math.round(Number(row[iLZ]) || 0),
        aadt_moto: Math.round(Number(row[iKrad]) || 0),
      })
      parsed++
    }

    console.log(`  ${label}: ${parsed} sections parsed, ${skipped} skipped (no coords/DTV)`)
  }

  // Cache as JSON
  writeFileSync(CACHE_JSON, JSON.stringify(sections))
  console.log(`  Cached ${sections.length} sections to ${CACHE_JSON}`)
  return sections
}

// ── Step 2: Build spatial index ──

function buildSpatialGrid(sections: CensusSection[]): Map<string, CensusSection[]> {
  const grid = new Map<string, CensusSection[]>()
  const CELL = 0.01  // ~1.1 km cells
  for (const s of sections) {
    const key = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`
    const list = grid.get(key) || []
    list.push(s)
    grid.set(key, list)
  }
  return grid
}

function findNearby(grid: Map<string, CensusSection[]>, lat: number, lon: number, maxDist: number): CensusSection[] {
  const CELL = 0.01
  const r = Math.ceil(maxDist / 1100 / CELL) // search radius in cells
  const gy = Math.floor(lat / CELL)
  const gx = Math.floor(lon / CELL)
  const result: CensusSection[] = []
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const key = `${gy + dy},${gx + dx}`
      const list = grid.get(key)
      if (list) result.push(...list)
    }
  }
  return result
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Step 3: Enrich Arrow files ──

async function enrichArrows(sections: CensusSection[]) {
  const grid = buildSpatialGrid(sections)
  console.log(`\n  Spatial grid: ${grid.size} cells for ${sections.length} sections`)

  // Build ref lookup for fast matching
  const refIndex = new Map<string, CensusSection[]>()
  for (const s of sections) {
    const list = refIndex.get(s.ref) || []
    list.push(s)
    refIndex.set(s.ref, list)
  }
  console.log(`  Ref index: ${refIndex.size} unique road refs`)

  // Pre-filter: use H3 cell center to find hexes in Germany bbox (no file I/O needed)
  const allHexes = readdirSync(H3R4_DIR).filter(d => !d.startsWith('.'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat > 46 && lat < 56 && lon > 4 && lon > 4 && lon < 16) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  German hexes: ${hexDirs.length} (of ${allHexes.length} total)\n`)

  let totalSegments = 0
  let matchedSegments = 0
  let preservedSegments = 0
  let hexesUpdated = 0
  const matchByClass: Record<string, { matched: number; total: number }> = {}
  const classNames = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'other']
  for (const c of classNames) matchByClass[c] = { matched: 0, total: 0 }

  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'roads.arrow')

    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows

    // Read existing columns
    const osmIds = table.getChild('osm_id')
    const refs = table.getChild('ref')
    const startLats = table.getChild('start_lat')
    const startLons = table.getChild('start_lon')
    const endLats = table.getChild('end_lat')
    const endLons = table.getChild('end_lon')
    const roadClasses = table.getChild('road_class')
    const existingLight = table.getChild('aadt_light')
    const existingMedium = table.getChild('aadt_medium')
    const existingHeavy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')
    const existingSourceId = table.getChild('source_id')

    if (!osmIds || !startLats || !startLons) continue

    // Prepare enrichment arrays
    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const sourceId = new Uint16Array(numRows)

    // Seed output columns from existing Arrow state; priority rule decides per row.
    for (let i = 0; i < numRows; i++) {
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMedium?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHeavy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      const rc = roadClasses?.get(i) ?? 7
      const className = classNames[Math.min(rc, 6)]
      matchByClass[className].total++
      totalSegments++

      // Priority gate: if a higher-priority dataset already owns this row, leave it.
      // Both BASt ids have priority 80, so gating with MY_SOURCE_ID is representative.
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) {
        if (sourceId[i] !== 0) preservedSegments++
        continue
      }

      // Match by ref + proximity
      const midLat = ((startLats.get(i) ?? 0) + (endLats?.get(i) ?? startLats.get(i) ?? 0)) / 2
      const midLon = ((startLons.get(i) ?? 0) + (endLons?.get(i) ?? startLons.get(i) ?? 0)) / 2

      const osmRef = refs?.get(i)?.toString().trim() || ''
      // Normalize OSM ref: "A 1" → "A1", "B 38" → "B38"
      const normRef = osmRef.replace(/\s+/g, '')

      let bestSection: CensusSection | null = null
      let bestDist = Infinity

      // Strategy 1: Match by ref — only consider sections with the same road ref
      if (normRef && refIndex.has(normRef)) {
        const candidates = refIndex.get(normRef)!
        for (const c of candidates) {
          const dist = haversineM(midLat, midLon, c.lat, c.lon)
          if (dist < bestDist) {
            bestDist = dist
            bestSection = c
          }
        }
      }

      // Strategy 2: For motorways/trunk without ref match, try proximity to any Autobahn/Bundesstraße
      // (conservative: only match within 2km and only if road class matches)
      if (!bestSection && (rc === 0 || rc === 1) && midLat > 47 && midLat < 55.5) {
        const nearby = findNearby(grid, midLat, midLon, 2000)
        for (const c of nearby) {
          // Only match Autobahn to A-roads, trunk to B-roads
          const isAutobahn = c.ref.startsWith('A')
          if (rc === 0 && !isAutobahn) continue
          if (rc === 1 && isAutobahn) continue

          const dist = haversineM(midLat, midLon, c.lat, c.lon)
          if (dist < bestDist && dist < 2000) {
            bestDist = dist
            bestSection = c
          }
        }
      }

      // Apply match (within reasonable distance)
      const maxMatchDist = normRef ? 15000 : 2000  // 15km for ref-matched, 2km for proximity-only
      if (bestSection && bestDist < maxMatchDist) {
        // Whole-row atomic write — payload + dataset_id together.
        // Pick dataset per row based on ref prefix: A* = Autobahn, B* = Bundesstraßen.
        const pickedId = bestSection.ref.startsWith('A') ? AUTOBAHN_DATASET_ID : BUNDESSTR_DATASET_ID
        aadtLight[i] = bestSection.aadt_light
        aadtMedium[i] = bestSection.aadt_medium
        aadtHeavy[i] = bestSection.aadt_heavy
        aadtMoto[i] = bestSection.aadt_moto
        sourceId[i] = pickedId
        hexMatched++
        matchedSegments++
        matchByClass[className].matched++
      }
    }

    if (hexMatched > 0) {
      // Rebuild table with enrichment columns
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
      columns['source_id'] = vectorFromArray(sourceId, new Uint16())

      const enrichedTable = makeTable(columns)
      const outBuf = tableToIPC(enrichedTable, 'file')
      writeFileSync(arrowPath, outBuf)
      hexesUpdated++
    }

    // Progress every hex (German hexes are large)
    if (hi % 10 === 0) {
      process.stdout.write(`\r  [${Math.round((Date.now() - startTime) / 1000)}s] ${hi+1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matchedSegments} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments: ${totalSegments}`)
  console.log(`  Pre-existing (preserved): ${preservedSegments}`)
  console.log(`  Newly matched: ${matchedSegments} (${(100 * matchedSegments / Math.max(totalSegments, 1)).toFixed(1)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}`)
  console.log(`\n  By road class:`)
  for (const [cls, stats] of Object.entries(matchByClass)) {
    if (stats.total > 0) {
      console.log(`    ${cls.padEnd(12)}: ${stats.matched}/${stats.total} (${(100 * stats.matched / stats.total).toFixed(1)}%)`)
    }
  }

  // Top AADT spot-check
  const topSections = sections.sort((a, b) => b.dtv - a.dtv).slice(0, 10)
  console.log(`\n  Top 10 highest-AADT sections:`)
  for (const s of topSections) {
    const hv = Math.round(100 * s.aadt_heavy / (s.aadt_light + s.aadt_medium + s.aadt_heavy + s.aadt_moto))
    console.log(`    ${s.road.padEnd(8)} DTV=${s.dtv.toLocaleString().padStart(7)}  HV=${hv}%  (${s.lat.toFixed(3)}, ${s.lon.toFixed(3)})`)
  }
}

// ── Main ──

async function main() {
  console.log(`=== DE Road Traffic Enrichment (BASt SVZ 2021) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}`)
  console.log(`  Year: ${YEAR}\n`)

  const sections = await downloadSvz()
  console.log(`\n  Total census sections: ${sections.length}`)

  // Summary stats
  const autobahn = sections.filter(s => s.ref.startsWith('A'))
  const bundesstr = sections.filter(s => s.ref.startsWith('B'))
  console.log(`  Autobahn (A): ${autobahn.length} sections`)
  console.log(`  Bundesstraßen (B): ${bundesstr.length} sections`)

  const avgDTV = Math.round(sections.reduce((s, c) => s + c.dtv, 0) / sections.length)
  console.log(`  Average DTV: ${avgDTV.toLocaleString()}`)

  await enrichArrows(sections)

  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error(err); process.exit(1) })
