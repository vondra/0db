/**
 * Enrich CZ railways.arrow with real train counts from CZPTT timetable.
 *
 * Downloads JR2026.zip (national timetable, 13k+ train XMLs), parses train
 * paths, counts trains per station-pair segment per day, matches to OSM
 * railway segments via station coordinates, writes trains_passenger +
 * trains_freight columns to railways.arrow.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-cz.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-cz.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-cz.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_CZ_SZCD_GTFS } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_CZ_SZCD_GTFS

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cz`)
const CACHE_TRAINS = resolve(CACHE_DIR, 'czptt-segment-counts.json')
const CACHE_STATIONS = resolve(CACHE_DIR, 'osm-stations.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const CZPTT_URL = 'https://portal.cisjr.cz/pub/draha/celostatni/szdc/2026/JR2026.zip'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// Target date for counting trains (Wednesday = typical weekday)
// JR2026 validity: varies per train (some Dec 2025, some Mar 2026).
// Pick a Wednesday well inside validity: April 2026.
const TARGET_DATE = '2026-04-08'

// ── Types ──

interface SegmentCount {
  from_code: string
  from_name: string
  to_code: string
  to_name: string
  passenger: number  // Os, Sp, R, IC, EC, rj, RJ, LE, SC, EN etc
  freight: number    // Nex, Pn, Mn etc
}

interface StationGPS {
  name: string
  lat: number
  lon: number
}

// ── Step 1: Download + parse CZPTT ──

async function getTrainCounts(): Promise<Map<string, SegmentCount>> {
  if (!forceDownload && existsSync(CACHE_TRAINS)) {
    console.log(`  Using cached train counts: ${CACHE_TRAINS}`)
    const data = JSON.parse(readFileSync(CACHE_TRAINS, 'utf-8'))
    return new Map(Object.entries(data))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_TRAINS)) { console.error('ERROR: --enrich-only but no cache'); process.exit(1) }
    const data = JSON.parse(readFileSync(CACHE_TRAINS, 'utf-8'))
    return new Map(Object.entries(data))
  }

  console.log('  Downloading CZPTT timetable...')
  const zipPath = resolve(CACHE_DIR, 'JR2026.zip')
  const xmlDir = resolve(CACHE_DIR, 'czptt-xml')
  mkdirSync(CACHE_DIR, { recursive: true })

  if (!existsSync(zipPath) || forceDownload) {
    const res = await fetch(CZPTT_URL, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) throw new Error(`CZPTT download error: ${res.status}`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    console.log(`  Downloaded ${(readFileSync(zipPath).length / 1e6).toFixed(1)} MB`)
  }

  console.log('  Extracting XMLs...')
  mkdirSync(xmlDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${xmlDir}"`, { timeout: 120000 })
  const xmlFiles = readdirSync(xmlDir).filter(f => f.endsWith('.xml'))
  console.log(`  ${xmlFiles.length} train definitions`)

  // Parse target date
  const targetMs = new Date(TARGET_DATE).getTime()
  const segments = new Map<string, SegmentCount>()
  let trainsRunning = 0

  // NOTE: CIS JR JR2026.zip contains ONLY passenger trains (all files are PA_ prefix).
  // Freight trains are NOT published in this dataset. Verified 2026-04-10:
  //   - All 13,252 XML files have ObjectType=PA (passenger)
  //   - OperationalTrainNumber is always digits-only (no Nex/Pn/Mn letter prefixes)
  //   - TrafficType values are only "11", "C1"-"C4" (all passenger codes per UIC)
  // Freight timetables are managed by SŽ but not publicly published as machine-readable.
  // All trains from this source are counted as passenger; trains_freight remains 0.
  let passengerTrains = 0
  let freightTrains = 0
  let unknownTrains = 0

  for (const file of xmlFiles) {
    const xml = readFileSync(resolve(xmlDir, file), 'utf-8')

    // Check if train runs on target date via PlannedCalendar
    const bitmapMatch = xml.match(/<BitmapDays>([^<]+)</)
    const startMatch = xml.match(/<PlannedCalendar>[\s\S]*?<StartDateTime>([^<]+)</)
    const endMatch = xml.match(/<PlannedCalendar>[\s\S]*?<EndDateTime>([^<]+)</)
    if (!bitmapMatch || !startMatch || !endMatch) continue

    const startDate = new Date(startMatch[1].substring(0, 10))
    const endDate = new Date(endMatch[1].substring(0, 10))
    const bitmap = bitmapMatch[1]

    if (targetMs < startDate.getTime() || targetMs > endDate.getTime()) continue
    const dayOffset = Math.floor((targetMs - startDate.getTime()) / 86400000)
    if (dayOffset >= bitmap.length || bitmap[dayOffset] !== '1') continue

    trainsRunning++

    // Detect train type. JR2026 is passenger-only in practice, but check ObjectType
    // for forward-compatibility if SŽ ever publishes freight data.
    const objTypeMatch = xml.match(/<ObjectType>([^<]+)</)
    const objType = objTypeMatch?.[1] || ''
    // PA = Passenger, NA = Freight (if ever published), TR = Train Run reference
    const isFreight = objType === 'NA'
    if (isFreight) freightTrains++
    else if (objType === 'PA') passengerTrains++
    else unknownTrains++

    // Extract station sequence
    const locRegex = /<LocationPrimaryCode>(\d+)<\/LocationPrimaryCode>\s*<PrimaryLocationName>([^<]+)</g
    const stations: { code: string; name: string }[] = []
    let m
    while ((m = locRegex.exec(xml)) !== null) {
      // Deduplicate consecutive same station (multiple platform entries)
      const code = m[1]
      if (stations.length === 0 || stations[stations.length - 1].code !== code) {
        stations.push({ code, name: m[2] })
      }
    }

    // Count trains per adjacent station pair
    for (let i = 0; i < stations.length - 1; i++) {
      const key = `${stations[i].code}-${stations[i + 1].code}`
      if (!segments.has(key)) {
        segments.set(key, {
          from_code: stations[i].code,
          from_name: stations[i].name,
          to_code: stations[i + 1].code,
          to_name: stations[i + 1].name,
          passenger: 0,
          freight: 0,
        })
      }
      const seg = segments.get(key)!
      if (isFreight) seg.freight++
      else seg.passenger++
    }
  }

  console.log(`  ${trainsRunning} trains running on ${TARGET_DATE}`)
  console.log(`    passenger (PA): ${passengerTrains}, freight (NA): ${freightTrains}, other: ${unknownTrains}`)
  console.log(`  ${segments.size} station-pair segments`)
  if (freightTrains === 0) {
    console.log(`  NOTE: JR2026.zip is passenger-only. Freight data not available from this source.`)
  }

  // Cache
  const obj: Record<string, SegmentCount> = {}
  for (const [k, v] of segments) obj[k] = v
  writeFileSync(CACHE_TRAINS, JSON.stringify(obj))

  // Cleanup XMLs to save space
  execSync(`rm -rf "${xmlDir}"`)

  return segments
}

// ── Step 2: Get station GPS from OSM ──

async function getStationGPS(): Promise<Map<string, StationGPS>> {
  if (!forceDownload && existsSync(CACHE_STATIONS)) {
    const data = JSON.parse(readFileSync(CACHE_STATIONS, 'utf-8'))
    return new Map(Object.entries(data))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_STATIONS)) { console.error('ERROR: --enrich-only but no station cache'); process.exit(1) }
    const data = JSON.parse(readFileSync(CACHE_STATIONS, 'utf-8'))
    return new Map(Object.entries(data))
  }

  console.log('  Downloading station coordinates from OSM...')
  const query = `[out:json];area["ISO3166-1"="CZ"]->.cz;(node["railway"="station"](area.cz);node["railway"="halt"](area.cz););out;`
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  let lines: { lat: number; lon: number; tags?: { name?: string } }[]
  try {
    const json = JSON.parse(text)
    lines = json.elements.filter((e: any) => e.tags?.name)
  } catch {
    // Overpass may be overloaded, try CSV fallback via bbox
    console.log('  Overpass JSON failed, trying bbox query...')
    const res2 = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent('[out:json];(node["railway"="station"](48.5,12.0,51.1,18.9);node["railway"="halt"](48.5,12.0,51.1,18.9););out;'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(120000),
    })
    const json2 = await res2.json() as any
    lines = json2.elements.filter((e: any) => e.tags?.name)
  }

  const stations = new Map<string, StationGPS>()
  for (const el of lines) {
    const name = el.tags!.name!
    stations.set(name, { name, lat: el.lat, lon: el.lon })
  }
  console.log(`  ${stations.size} OSM stations with GPS`)

  const obj: Record<string, StationGPS> = {}
  for (const [k, v] of stations) obj[k] = v
  writeFileSync(CACHE_STATIONS, JSON.stringify(obj))

  return stations
}

// ── Step 3: Match CZPTT station-pairs to OSM railway segments ──

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

/** Distance from point P to line segment A→B in meters (flat-earth). */
function pointToSegmentDist(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const cosLat = Math.cos((pLat + (aLat + bLat) / 2) / 2 * Math.PI / 180)
  // Convert to local meters relative to P
  const ax = (aLon - pLon) * 111320 * cosLat
  const ay = (aLat - pLat) * 110540
  const bx = (bLon - pLon) * 111320 * cosLat
  const by = (bLat - pLat) * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1) return Math.sqrt(ax * ax + ay * ay) // degenerate (A≈B)
  // Project P onto AB, clamp t to [0,1]
  const t = Math.max(0, Math.min(1, (-ax * dx + -ay * dy) / lenSq))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt(cx * cx + cy * cy)
}

/** Normalize station name for fuzzy matching */
function normName(s: string): string {
  return s.toLowerCase()
    .replace(/[- ]/g, '')
    .replace(/pha\s*hl\.?n\.?/i, 'prahahlavn')
    .replace(/hl\.?n\.?/i, 'hlavní nádraží')
    .replace(/[áà]/g, 'a').replace(/[éè]/g, 'e').replace(/[íì]/g, 'i')
    .replace(/[óò]/g, 'o').replace(/[úùů]/g, 'u').replace(/ý/g, 'y')
    .replace(/č/g, 'c').replace(/ď/g, 'd').replace(/ň/g, 'n')
    .replace(/ř/g, 'r').replace(/š/g, 's').replace(/ť/g, 't').replace(/ž/g, 'z')
    .replace(/ě/g, 'e')
}

function enrichHexes(
  segments: Map<string, SegmentCount>,
  stationGPS: Map<string, StationGPS>,
): void {
  // Build GPS lookup for CZPTT station codes
  // Match CZPTT station names to OSM station names
  const codeToGPS = new Map<string, { lat: number; lon: number }>()
  const normOSM = new Map<string, StationGPS>()
  for (const [name, gps] of stationGPS) normOSM.set(normName(name), gps)

  const allCodes = new Set<string>()
  for (const seg of segments.values()) {
    allCodes.add(seg.from_code)
    allCodes.add(seg.to_code)
  }

  let matched = 0, unmatched = 0
  for (const seg of segments.values()) {
    for (const { code, name } of [
      { code: seg.from_code, name: seg.from_name },
      { code: seg.to_code, name: seg.to_name },
    ]) {
      if (codeToGPS.has(code)) continue
      // Try exact name match first
      const osm = stationGPS.get(name) || normOSM.get(normName(name))
      if (osm) {
        codeToGPS.set(code, { lat: osm.lat, lon: osm.lon })
        matched++
      } else {
        unmatched++
      }
    }
  }
  console.log(`  Station name matching: ${matched} found, ${unmatched} not found in OSM`)

  // For each railway segment in Arrow, find the CZPTT segment whose from/to
  // stations are closest to the segment's start/end points
  // Pre-filter hexes to Czech Republic bbox using H3 center (no file I/O needed)
  const allHexes = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      // CZ bbox: ~48.5-51.1 N, ~12.0-18.9 E (expanded margin for border hexes)
      if (lat > 48.0 && lat < 51.5 && lon > 11.5 && lon < 19.5) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  Czech hexes (H3 bbox pre-filter): ${hexDirs.length} of ${allHexes.length} total`)

  // Pre-build list of CZPTT segments with GPS
  const gpsSegments: { key: string; seg: SegmentCount; fromLat: number; fromLon: number; toLat: number; toLon: number }[] = []
  for (const [key, seg] of segments) {
    const fromGPS = codeToGPS.get(seg.from_code)
    const toGPS = codeToGPS.get(seg.to_code)
    if (fromGPS && toGPS) {
      gpsSegments.push({ key, seg, fromLat: fromGPS.lat, fromLon: fromGPS.lon, toLat: toGPS.lat, toLon: toGPS.lon })
    }
  }
  console.log(`  ${gpsSegments.length} CZPTT segments with GPS (of ${segments.size} total)`)

  let totalRails = 0, totalMatched = 0, hexesUpdated = 0

  for (const hexId of hexDirs) {
    const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
    if (!existsSync(railPath)) continue

    const buf = readFileSync(railPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalRails += n

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const osmIdCol = table.getChild('osm_id')
    const railTypeCol = table.getChild('rail_type')
    const usageCol = table.getChild('usage')
    const serviceCol = table.getChild('service')

    // Seed output columns from existing Arrow state; priority rule decides per row.
    const existingTrainsPax = table.getChild('trains_passenger')
    const existingTrainsFrt = table.getChild('trains_freight')
    const existingSourceId = table.getChild('source_id')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    const sourceId = new Uint16Array(n)
    const matchedKeys: string[] = new Array(n).fill('')
    const mids: { lat: number; lon: number }[] = new Array(n)
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingTrainsPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingTrainsFrt?.get(i) as number) ?? 0
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    for (let i = 0; i < n; i++) {
      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2
      mids[i] = { lat: midLat, lon: midLon }

      // Priority gate: if a higher-priority dataset already owns this row, leave it.
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) continue

      let bestDist = 5000
      let bestSeg: SegmentCount | null = null
      let bestKey = ''

      for (const gs of gpsSegments) {
        const d = pointToSegmentDist(midLat, midLon, gs.fromLat, gs.fromLon, gs.toLat, gs.toLon)
        if (d < bestDist) {
          bestDist = d
          bestSeg = gs.seg
          // Canonicalize key: sort station codes so from→to = to→from
          const codes = [gs.seg.from_code, gs.seg.to_code].sort()
          bestKey = codes[0] + '-' + codes[1]
        }
      }

      if (bestSeg) {
        // Whole-row atomic write — payload + dataset_id together.
        trainsPax[i] = bestSeg.passenger
        trainsFrt[i] = bestSeg.freight
        sourceId[i] = MY_SOURCE_ID
        matchedKeys[i] = bestKey
        hexMatched++
      }
    }

    if (hexMatched === 0) continue

    // ── Parallel-way detection ──
    // For each matched segment, count distinct osm_ids with:
    // same czpttKey + within 50m + different osm_id + same rail_type + same usage + service=0
    const parallelDiv = new Uint8Array(n).fill(1)

    for (let i = 0; i < n; i++) {
      if (!matchedKeys[i]) continue
      const service_i = serviceCol ? (serviceCol.get(i) as number) : 0
      if (service_i > 0) continue // skip sidings/yards
      const oid_i = osmIdCol ? String(osmIdCol.get(i)) : '0'
      const rt_i = railTypeCol ? (railTypeCol.get(i) as number) : 0
      const usage_i = usageCol ? (usageCol.get(i) as number) : 0

      const neighborOsm = new Set<string>()
      neighborOsm.add(oid_i) // include self

      for (let j = 0; j < n; j++) {
        if (j === i) continue
        if (matchedKeys[j] !== matchedKeys[i]) continue // different timetable section
        const oid_j = osmIdCol ? String(osmIdCol.get(j)) : '0'
        if (oid_j === oid_i) continue // same way (different segments of it)
        if (neighborOsm.has(oid_j)) continue // already counted this way
        const rt_j = railTypeCol ? (railTypeCol.get(j) as number) : 0
        const usage_j = usageCol ? (usageCol.get(j) as number) : 0
        const service_j = serviceCol ? (serviceCol.get(j) as number) : 0
        if (rt_j !== rt_i || usage_j !== usage_i || service_j > 0) continue
        const d = flatDist(mids[i].lat, mids[i].lon, mids[j].lat, mids[j].lon)
        if (d < 50) neighborOsm.add(oid_j)
      }

      parallelDiv[i] = Math.min(neighborOsm.size, 3) as number
    }

    // Stats
    let parCount = 0
    for (let i = 0; i < n; i++) if (parallelDiv[i] > 1) parCount++
    if (parCount > 0) {
      console.log(`    ${hexId}: ${parCount}/${hexMatched} segments have parallel_divisor > 1`)
    }

    // Copy all existing columns + add train counts + parallel_divisor + dataset_id
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (['trains_passenger', 'trains_freight', 'parallel_divisor', 'source_id'].includes(field.name)) continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
    columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())
    columns['parallel_divisor'] = vectorFromArray(parallelDiv, new Uint8())
    columns['source_id'] = vectorFromArray(sourceId, new Uint16())

    const newTable = makeTable(columns)
    writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++

    if (hexesUpdated % 20 === 0) {
      console.log(`  [${hexesUpdated}/${hexDirs.length}] ${totalMatched} segments matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRails} railway segments matched (${(totalMatched / totalRails * 100).toFixed(1)}%)`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
}

// ── Main ──

async function main() {
  console.log(`=== CZ Railway Enrichment (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const segments = await getTrainCounts()
  const stationGPS = await getStationGPS()
  console.log(`\n  Enriching railways.arrow files...`)
  enrichHexes(segments, stationGPS)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
