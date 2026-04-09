/**
 * Enrich ES railways.arrow with real train counts from RENFE GTFS.
 *
 * Downloads RENFE national GTFS (google_transit.zip), parses stop_times +
 * trips + routes + calendar to count trains per day per stop, matches GTFS
 * stops to OSM railway segments by proximity (500m), writes trains_passenger
 * column to railways.arrow.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-es.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-es.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-es.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { latLngToCell } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/es`)
const CACHE_STOP_FREQ = resolve(CACHE_DIR, 'renfe-stop-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// RENFE national GTFS
const RENFE_GTFS_URL = 'http://data.renfe.com/dataset/34be0058-3a3d-4ee1-89cd-512e1226f53f/resource/25d6b043-9e47-4f99-bd91-edd51d782450/download/google_transit.zip'

// Spain bounding box (with margin for border areas)
const BBOX: [number, number, number, number] = [35.5, -10.0, 44.0, 5.0] // [minLat, minLon, maxLat, maxLon]

// GTFS route_type: 2=Rail, 100-109=extended railway types, 0=Tram, 900-906=Tram extended
const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
const TRAM_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906])
const ALL_RAIL = new Set([...RAIL_TYPES, ...TRAM_TYPES])

// ── Types ──

interface GtfsStop {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
}

interface StopTrainCount {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
  trains_passenger: number
  trains_freight: number
}

// ── CSV parsing ──

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current.trim())
  return fields
}

async function parseCsvStream(filePath: string): Promise<Record<string, string>[]> {
  const results: Record<string, string>[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let headers: string[] | null = null
  for await (const rawLine of rl) {
    const line = headers === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue

    if (!headers) {
      headers = parseCsvLine(line)
      continue
    }
    const values = parseCsvLine(line)
    const row: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] || ''
    }
    results.push(row)
  }
  return results
}

// ── GTFS date helpers ──

function parseGtfsDate(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.substring(0, 4))
  const m = parseInt(yyyymmdd.substring(4, 6)) - 1
  const d = parseInt(yyyymmdd.substring(6, 8))
  return new Date(y, m, d).getTime()
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-${yyyymmdd.substring(6, 8)}`
}

function findTargetWednesday(calendarRows: Record<string, string>[]): string {
  let minDate = '99999999'
  let maxDate = '00000000'
  for (const row of calendarRows) {
    const start = row['start_date'] || ''
    const end = row['end_date'] || ''
    if (start && start < minDate) minDate = start
    if (end && end > maxDate) maxDate = end
  }

  if (minDate === '99999999') {
    const now = new Date()
    now.setDate(now.getDate() + 7)
    while (now.getDay() !== 3) now.setDate(now.getDate() + 1)
    return now.toISOString().substring(0, 10).replace(/-/g, '')
  }

  const startMs = parseGtfsDate(minDate)
  const endMs = parseGtfsDate(maxDate)
  const midMs = startMs + (endMs - startMs) / 2
  const mid = new Date(midMs)
  const day = mid.getDay()
  const offset = (3 - day + 7) % 7
  mid.setDate(mid.getDate() + offset)
  return mid.toISOString().substring(0, 10).replace(/-/g, '')
}

// ── Step 1: Download + parse RENFE GTFS ──

async function downloadAndExtractGtfs(): Promise<string> {
  const extractDir = resolve(CACHE_DIR, 'renfe-gtfs')

  if (!forceDownload && existsSync(resolve(extractDir, 'stops.txt'))) {
    console.log(`  Using cached GTFS: ${extractDir}`)
    return extractDir
  }
  if (enrichOnly) {
    if (!existsSync(resolve(extractDir, 'stops.txt'))) {
      console.error('ERROR: --enrich-only but no cached GTFS')
      process.exit(1)
    }
    return extractDir
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  const zipPath = resolve(CACHE_DIR, 'renfe-google_transit.zip')

  console.log(`  Downloading RENFE GTFS from ${RENFE_GTFS_URL}...`)
  const res = await fetch(RENFE_GTFS_URL, {
    signal: AbortSignal.timeout(300_000),
    headers: { 'Accept': 'application/zip, application/octet-stream, */*' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`RENFE GTFS download failed: ${res.status} ${res.statusText}`)

  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(zipPath, buf)
  console.log(`  Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)

  mkdirSync(extractDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })

  // Verify essential files
  for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
    if (!existsSync(resolve(extractDir, f))) {
      throw new Error(`RENFE GTFS missing required file: ${f}`)
    }
  }

  execSync(`rm -f "${zipPath}"`)
  console.log(`  Extracted GTFS to ${extractDir}`)
  return extractDir
}

// ── Step 2: Compute stop frequencies ──

async function computeStopFrequencies(extractDir: string): Promise<StopTrainCount[]> {
  if (!forceDownload && existsSync(CACHE_STOP_FREQ)) {
    console.log(`  Using cached stop frequencies: ${CACHE_STOP_FREQ}`)
    return JSON.parse(readFileSync(CACHE_STOP_FREQ, 'utf-8'))
  }

  console.log('  Parsing GTFS files...')
  const startTime = Date.now()

  // Parse routes.txt
  console.log('  Reading routes.txt...')
  const routesRaw = await parseCsvStream(resolve(extractDir, 'routes.txt'))
  const routeTypeMap = new Map<string, number>()
  for (const r of routesRaw) {
    const routeType = parseInt(r['route_type'] || '3')
    routeTypeMap.set(r['route_id'], routeType)
  }
  console.log(`  ${routeTypeMap.size} routes total`)

  const railRouteIds = new Set<string>()
  for (const [routeId, routeType] of routeTypeMap) {
    if (ALL_RAIL.has(routeType)) {
      railRouteIds.add(routeId)
    }
  }
  console.log(`  ${railRouteIds.size} rail/tram routes`)
  if (railRouteIds.size === 0) {
    console.log('  WARNING: No rail routes found. Check route_types in GTFS.')
    // RENFE may use route_type=2 or extended types. Try all if none found.
    for (const [routeId] of routeTypeMap) {
      railRouteIds.add(routeId)
    }
    console.log(`  Fallback: using all ${railRouteIds.size} routes`)
  }

  // Parse calendar
  console.log('  Reading calendar...')
  const calendarPath = resolve(extractDir, 'calendar.txt')
  const calendarDatesPath = resolve(extractDir, 'calendar_dates.txt')
  const activeServiceIds = new Set<string>()

  if (existsSync(calendarPath)) {
    const calendarRaw = await parseCsvStream(calendarPath)
    const targetDate = findTargetWednesday(calendarRaw)
    console.log(`  Target date: ${formatDate(targetDate)} (Wednesday)`)

    for (const r of calendarRaw) {
      const start = r['start_date'] || ''
      const end = r['end_date'] || ''
      const wednesday = r['wednesday'] || '0'
      if (wednesday === '1' && targetDate >= start && targetDate <= end) {
        activeServiceIds.add(r['service_id'])
      }
    }

    if (existsSync(calendarDatesPath)) {
      const calDates = await parseCsvStream(calendarDatesPath)
      for (const r of calDates) {
        if (r['date'] !== targetDate) continue
        if (r['exception_type'] === '1') activeServiceIds.add(r['service_id'])
        if (r['exception_type'] === '2') activeServiceIds.delete(r['service_id'])
      }
    }
  } else if (existsSync(calendarDatesPath)) {
    console.log('  No calendar.txt, using calendar_dates.txt only')
    const calDates = await parseCsvStream(calendarDatesPath)
    const dateCounts = new Map<string, number>()
    for (const r of calDates) {
      if (r['exception_type'] === '1') {
        const d = r['date'] || ''
        dateCounts.set(d, (dateCounts.get(d) || 0) + 1)
      }
    }
    const wednesdays = [...dateCounts.entries()]
      .filter(([d]) => new Date(parseGtfsDate(d)).getDay() === 3)
      .sort((a, b) => b[1] - a[1])
    if (wednesdays.length > 0) {
      const targetDate = wednesdays[0][0]
      console.log(`  Target date (from calendar_dates): ${formatDate(targetDate)} (Wednesday, ${wednesdays[0][1]} services)`)
      for (const r of calDates) {
        if (r['date'] === targetDate && r['exception_type'] === '1') {
          activeServiceIds.add(r['service_id'])
        }
      }
    } else {
      const best = [...dateCounts.entries()].sort((a, b) => b[1] - a[1])
      if (best.length > 0) {
        console.log(`  No Wednesday found, using busiest date: ${formatDate(best[0][0])}`)
        for (const r of calDates) {
          if (r['date'] === best[0][0] && r['exception_type'] === '1') {
            activeServiceIds.add(r['service_id'])
          }
        }
      }
    }
  } else {
    console.log('  WARNING: No calendar files found. Counting all trips.')
  }

  console.log(`  ${activeServiceIds.size} active service IDs on target date`)

  // Parse trips
  console.log('  Reading trips.txt...')
  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  const railTripIds = new Set<string>()
  for (const r of tripsRaw) {
    const routeId = r['route_id']
    const serviceId = r['service_id']
    if (!railRouteIds.has(routeId)) continue
    if (activeServiceIds.size > 0 && !activeServiceIds.has(serviceId)) continue
    railTripIds.add(r['trip_id'])
  }
  console.log(`  ${railTripIds.size} rail trips on target day (of ${tripsRaw.length} total)`)

  if (railTripIds.size === 0) {
    console.log('  WARNING: No active rail trips found.')
    return []
  }

  // Parse stop_times (streaming for large files)
  console.log('  Reading stop_times.txt...')
  const stopDepartures = new Map<string, number>()

  const stStream = createReadStream(resolve(extractDir, 'stop_times.txt'), { encoding: 'utf-8' })
  const stRl = createInterface({ input: stStream, crlfDelay: Infinity })
  let stHeaders: string[] | null = null
  let stLines = 0
  let stMatched = 0
  let tripIdIdx = -1
  let stopIdIdx = -1
  let lastProgressTime = Date.now()

  for await (const rawLine of stRl) {
    const line = stHeaders === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue

    if (!stHeaders) {
      stHeaders = parseCsvLine(line)
      tripIdIdx = stHeaders.indexOf('trip_id')
      stopIdIdx = stHeaders.indexOf('stop_id')
      if (tripIdIdx < 0 || stopIdIdx < 0) {
        throw new Error(`stop_times.txt missing required columns. Found: ${stHeaders.join(', ')}`)
      }
      continue
    }

    stLines++
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    if (!railTripIds.has(tripId)) continue

    const stopId = fields[stopIdIdx]
    stopDepartures.set(stopId, (stopDepartures.get(stopId) || 0) + 1)
    stMatched++

    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`    ... ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stop-times`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  ${stLines} stop_times lines, ${stMatched} rail stop-times, ${stopDepartures.size} unique stops`)

  // Parse stops
  console.log('  Reading stops.txt...')
  const stopsRaw = await parseCsvStream(resolve(extractDir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  const [minLat, minLon, maxLat, maxLon] = BBOX

  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue
    if (lat < minLat - 1 || lat > maxLat + 1 || lon < minLon - 1 || lon > maxLon + 1) continue

    let h3r4: string
    try { h3r4 = latLngToCell(lat, lon, 4) } catch { continue }

    stopsMap.set(r['stop_id'], {
      stop_id: r['stop_id'],
      lat, lon,
      name: (r['stop_name'] || '').trim(),
      h3r4,
    })
  }
  console.log(`  ${stopsMap.size} stops with valid coords`)

  // Resolve parent stations
  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const parentId = (r['parent_station'] || '').trim()
    if (parentId) childToParent.set(r['stop_id'], parentId)
  }

  // Build final stop frequency list
  const results: StopTrainCount[] = []
  let resolvedViaParent = 0

  for (const [stopId, count] of stopDepartures) {
    let stop = stopsMap.get(stopId)
    if (!stop) {
      const parentId = childToParent.get(stopId)
      if (parentId) {
        stop = stopsMap.get(parentId)
        if (stop) resolvedViaParent++
      }
    }
    if (!stop) continue

    results.push({
      stop_id: stop.stop_id,
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      h3r4: stop.h3r4,
      trains_passenger: count,
      trains_freight: 0,
    })
  }

  // Deduplicate by rounded lat/lon
  const dedupMap = new Map<string, StopTrainCount>()
  for (const sc of results) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}`
    const existing = dedupMap.get(key)
    if (existing) {
      existing.trains_passenger += sc.trains_passenger
    } else {
      dedupMap.set(key, { ...sc })
    }
  }
  const deduped = [...dedupMap.values()]

  console.log(`  ${deduped.length} stops with train counts (${resolvedViaParent} resolved via parent station)`)

  // Stats
  const paxCounts = deduped.map(s => s.trains_passenger).sort((a, b) => b - a)
  if (paxCounts.length > 0) {
    console.log(`  Train frequency: max=${paxCounts[0]}, median=${paxCounts[Math.floor(paxCounts.length / 2)]}, min=${paxCounts[paxCounts.length - 1]}`)
    const top5 = deduped.sort((a, b) => b.trains_passenger - a.trains_passenger).slice(0, 5)
    console.log('  Busiest stops:')
    for (const s of top5) {
      console.log(`    ${s.trains_passenger} trains/day: ${s.name} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  GTFS parsing took ${elapsed}s`)

  // Cache
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_STOP_FREQ, JSON.stringify(deduped))
  console.log(`  Cached to ${CACHE_STOP_FREQ}`)

  return deduped
}

// ── Step 3: Match stops to railway segments ──

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
  const ddx = px - cx
  const ddy = py - cy
  return Math.sqrt(ddx * ddx + ddy * ddy)
}

function enrichHexes(allStopCounts: StopTrainCount[]): void {
  // Group stops by H3R4 hex
  const stopsByHex = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    if (!stopsByHex.has(sc.h3r4)) stopsByHex.set(sc.h3r4, [])
    stopsByHex.get(sc.h3r4)!.push(sc)
  }
  console.log(`  Stops span ${stopsByHex.size} H3R4 hexes`)

  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalRails = 0
  let totalMatched = 0
  let hexesUpdated = 0
  let hexesScanned = 0
  let totalPreExisting = 0
  const startTime = Date.now()

  for (const hexId of hexDirs) {
    const hexStops = stopsByHex.get(hexId)
    if (!hexStops) continue

    const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
    if (!existsSync(railPath)) continue

    hexesScanned++
    const buf = readFileSync(railPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const serviceCol = table.getChild('service')

    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)

    for (let i = 0; i < n; i++) {
      trainsPax[i] = existingPax ? (existingPax.get(i) as number ?? 0) : 0
      trainsFrt[i] = existingFrt ? (existingFrt.get(i) as number ?? 0) : 0
      if (trainsPax[i] > 0 || trainsFrt[i] > 0) totalPreExisting++
    }

    totalRails += n

    // Build spatial grid for stops in this hex
    const grid = new Map<string, StopTrainCount[]>()
    for (const sc of hexStops) {
      const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(sc)
    }

    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      const service = serviceCol ? (serviceCol.get(i) as number ?? 0) : 0
      if (service > 0) continue
      if (trainsPax[i] > 0 || trainsFrt[i] > 0) continue

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      let bestDist = 500
      let bestStop: StopTrainCount | null = null

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${Math.floor(midLat * 100) + dy}_${Math.floor(midLon * 100) + dx}`
          const cell = grid.get(k)
          if (!cell) continue
          for (const sc of cell) {
            const d = pointToSegmentDist(sc.lat, sc.lon, sLat, sLon, eLat, eLon)
            if (d < bestDist) {
              bestDist = d
              bestStop = sc
            }
          }
        }
      }

      if (!bestStop) continue

      trainsPax[i] = bestStop.trains_passenger
      trainsFrt[i] = bestStop.trains_freight
      hexMatched++
    }

    if (hexMatched === 0) continue

    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (field.name === 'trains_passenger') continue
      if (field.name === 'trains_freight') continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
    columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())

    const newTable = makeTable(columns)
    writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++

    if (Date.now() - startTime > 0 && hexesScanned % 50 === 0) {
      console.log(`  [${((Date.now() - startTime) / 1000).toFixed(0)}s] ${hexesScanned} hexes, ${totalMatched} segments matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Railway segments in matched hexes: ${totalRails}`)
  console.log(`  Pre-existing enrichments (preserved): ${totalPreExisting}`)
  console.log(`  Newly matched from RENFE GTFS: ${totalMatched} (${totalRails > 0 ? (totalMatched / totalRails * 100).toFixed(1) : 0}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}`)
  console.log(`  Hexes scanned: ${hexesScanned}`)
}

// ── Main ──

async function main() {
  console.log(`=== ES Railway Enrichment — RENFE GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const extractDir = await downloadAndExtractGtfs()
  const stopFreqs = await computeStopFrequencies(extractDir)

  if (stopFreqs.length === 0) {
    console.log('\n  No stop frequencies computed. Nothing to enrich.')
    return
  }

  console.log(`\n  Enriching railways.arrow files...`)
  enrichHexes(stopFreqs)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
