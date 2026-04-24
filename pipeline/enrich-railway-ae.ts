/**
 * Enrich AE railways.arrow — Dubai RTA GTFS + CNOSSOS class defaults.
 *
 * Dubai Roads & Transport Authority publishes a unified GTFS (7z archive) via
 * Dubai Pulse containing Metro (Red 1, Red 2, Green), Tram (T1), Water Bus, and
 * 163 bus routes. Only metro + tram are of interest for rail noise.
 *
 *   Direct URL (Dubai Pulse CKAN, ~10 MB, anonymous, 7z):
 *     https://www.dubaipulse.gov.ae/dataset/73765e8f-e8c4-443c-9687-288072ed9d12
 *       /resource/11515bd3-bdba-466f-ab65-f057bd123ab5/download/gtfs.7z
 *
 * Critical pipeline limitation: Dubai Metro (Red Line + Green Line) is tagged
 * `railway=subway` in OSM. The `osm-extract` crate only accepts rail/tram/
 * light_rail/narrow_gauge/funicular, so Dubai Metro is NOT in railways.arrow.
 * Same bug affects Taipei, Kaohsiung, Seoul, Singapore, Tokyo, Mexico City.
 * GTFS stops for metro routes are still parsed but won't find matching segments.
 *
 * Only the Dubai Tram T1 (Al Sufouh / Al Marina, OSM `railway=tram`) will be
 * enriched by GTFS (278 Wednesday trips → ~278 trams/day).
 *
 * For the rest of the UAE rail network (Etihad Rail freight Stage 1
 * Ghuweifat↔Fujairah operational 2023, Ruwais refinery sidings, Abu Dhabi
 * airport APM, Yas Island people mover, Palm Jumeirah Monorail), we apply
 * CNOSSOS-EU class defaults based on OSM rail_type + usage:
 *
 *   rail_type=0 (rail)        usage=0 (main)       → 40 trains/day (Etihad Rail freight)
 *   rail_type=0 (rail)        usage=1 (branch)     → 15 trains/day
 *   rail_type=0 (rail)        usage=2 (industrial) → 25 trains/day (Ruwais refinery)
 *   rail_type=1 (tram)                             → 200 trains/day (fallback if GTFS misses)
 *   rail_type=2 (light_rail)                       → 200 trains/day (Yas Island APM)
 *   rail_type=3 (narrow_gauge)                     → 40 trains/day (Palm Monorail, theme parks)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ae.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ae.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ae.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, createReadStream, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { latLngToCell, cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ae-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ae`)
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-stop-frequencies.json')
const SEVENZ_BIN = resolve(import.meta.dirname, '../pipeline/node_modules/7zip-bin/linux/x64/7za')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

interface FeedConfig {
  id: string
  name: string
  url: string
}

const FEEDS: FeedConfig[] = [
  {
    id: 'rta-dubai',
    name: 'Dubai RTA unified (Metro Red/Green + Tram T1 + Water Bus + buses)',
    url: 'https://www.dubaipulse.gov.ae/dataset/73765e8f-e8c4-443c-9687-288072ed9d12/resource/11515bd3-bdba-466f-ab65-f057bd123ab5/download/gtfs.7z',
  },
]

// UAE bbox (inclusive of Musandam enclave)
const AE_BBOX: [number, number, number, number] = [22.3, 51.0, 26.3, 56.7]

// GTFS route_type: 2=Rail, 100-109=Railway subtypes, 0=Tram, 900-906=Tram subtypes,
// 1=Subway/Metro, 400-405=Urban Railway/Monorail subtypes
const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
const TRAM_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906])
const METRO_TYPES = new Set([1, 400, 401, 402, 403, 404, 405])
const ALL_RAIL_AND_TRAM = new Set([...RAIL_TYPES, ...TRAM_TYPES, ...METRO_TYPES])

interface GtfsStop {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
}

type RouteFamily = 'rail' | 'tram' | 'metro'

interface StopTrainCount {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
  family: RouteFamily
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
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = false
      } else current += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { fields.push(current.trim()); current = '' }
      else current += ch
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
    if (!headers) { headers = parseCsvLine(line); continue }
    const values = parseCsvLine(line)
    const row: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) row[headers[i]] = values[i] || ''
    results.push(row)
  }
  return results
}

// ── Date helpers ──

function parseGtfsDate(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.substring(0, 4))
  const m = parseInt(yyyymmdd.substring(4, 6)) - 1
  const d = parseInt(yyyymmdd.substring(6, 8))
  return new Date(y, m, d).getTime()
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-${yyyymmdd.substring(6, 8)}`
}

/** Find a Wednesday within the GTFS calendar validity period (midpoint heuristic). */
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

// ── Step 1: Download GTFS 7z ──

async function downloadAllGtfs(): Promise<Array<{ feed: FeedConfig; dir: string }>> {
  const results: Array<{ feed: FeedConfig; dir: string }> = []

  // Ensure 7za is executable
  try { chmodSync(SEVENZ_BIN, 0o755) } catch {}

  for (const feed of FEEDS) {
    const extractParent = resolve(CACHE_DIR, `gtfs-${feed.id}`)

    if (!forceDownload && existsSync(extractParent)) {
      // find the actual GTFS dir (could be nested like GTFS_20250823/)
      const subs = readdirSync(extractParent).filter(f => existsSync(resolve(extractParent, f, 'stops.txt')))
      if (subs.length > 0) {
        console.log(`  [${feed.id}] Using cached GTFS: ${resolve(extractParent, subs[0])}`)
        results.push({ feed, dir: resolve(extractParent, subs[0]) })
        continue
      }
      if (existsSync(resolve(extractParent, 'stops.txt'))) {
        console.log(`  [${feed.id}] Using cached GTFS: ${extractParent}`)
        results.push({ feed, dir: extractParent })
        continue
      }
    }
    if (enrichOnly) {
      if (!existsSync(extractParent)) {
        console.log(`  [${feed.id}] --enrich-only but no cached GTFS, skipping`)
        continue
      }
    }

    mkdirSync(CACHE_DIR, { recursive: true })
    const archivePath = resolve(CACHE_DIR, `${feed.id}.7z`)

    if (!existsSync(archivePath) || forceDownload) {
      console.log(`  [${feed.id}] Downloading from ${feed.url}...`)
      try {
        const res = await fetch(feed.url, {
          signal: AbortSignal.timeout(600_000),
          headers: {
            'Accept': 'application/x-7z-compressed, application/octet-stream, */*',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.dubaipulse.gov.ae/dataset/dubai-gtfs',
          },
          redirect: 'follow',
        })
        if (!res.ok) {
          console.log(`  [${feed.id}] HTTP ${res.status}, skipping feed`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(archivePath, buf)
        console.log(`  [${feed.id}] Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)
      } catch (err: any) {
        console.log(`  [${feed.id}] Failed: ${err.message}, skipping feed`)
        continue
      }
    }

    mkdirSync(extractParent, { recursive: true })
    try {
      execSync(`"${SEVENZ_BIN}" x -y -o"${extractParent}" "${archivePath}" > /dev/null`, { timeout: 120_000 })
    } catch (err: any) {
      console.log(`  [${feed.id}] 7z extraction failed: ${err.message}`)
      continue
    }

    // 7z nests inside GTFS_{YYYYMMDD}/ — find the real directory
    const subs = readdirSync(extractParent).filter(f => {
      try { return existsSync(resolve(extractParent, f, 'stops.txt')) } catch { return false }
    })
    let gtfsDir: string
    if (subs.length > 0) gtfsDir = resolve(extractParent, subs[0])
    else if (existsSync(resolve(extractParent, 'stops.txt'))) gtfsDir = extractParent
    else {
      console.log(`  [${feed.id}] Could not find stops.txt in extracted archive`)
      continue
    }

    for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
      if (!existsSync(resolve(gtfsDir, f))) {
        console.log(`  [${feed.id}] Missing ${f}, skipping feed`)
        continue
      }
    }

    results.push({ feed, dir: gtfsDir })
  }

  if (results.length === 0) {
    console.log(`  No GTFS feeds available — will use class defaults only.`)
  } else {
    console.log(`  ${results.length}/${FEEDS.length} AE feeds available`)
  }
  return results
}

// ── Step 2: Parse GTFS and compute stop frequencies ──

async function computeStopFrequenciesForFeed(feed: FeedConfig, extractDir: string): Promise<StopTrainCount[]> {
  console.log(`\n  [${feed.id}] Parsing GTFS files from ${extractDir}...`)
  const startTime = Date.now()

  // ── routes.txt → rail/tram/metro routes ──
  const routesRaw = await parseCsvStream(resolve(extractDir, 'routes.txt'))
  const routeTypeMap = new Map<string, number>()
  for (const r of routesRaw) routeTypeMap.set(r['route_id'], parseInt(r['route_type'] || '3'))
  console.log(`  ${routeTypeMap.size} routes total`)

  const routeFamily = new Map<string, RouteFamily>()
  let nRail = 0, nTram = 0, nMetro = 0
  for (const [routeId, routeType] of routeTypeMap) {
    if (RAIL_TYPES.has(routeType)) { routeFamily.set(routeId, 'rail'); nRail++ }
    else if (TRAM_TYPES.has(routeType)) { routeFamily.set(routeId, 'tram'); nTram++ }
    else if (METRO_TYPES.has(routeType)) { routeFamily.set(routeId, 'metro'); nMetro++ }
  }
  console.log(`  Rail/tram/metro routes: ${routeFamily.size} (rail=${nRail}, tram=${nTram}, metro=${nMetro})`)

  if (routeFamily.size === 0) return []

  // ── calendar.txt ──
  const activeServiceIds = new Set<string>()
  const calendarPath = resolve(extractDir, 'calendar.txt')
  const calendarDatesPath = resolve(extractDir, 'calendar_dates.txt')

  if (existsSync(calendarPath)) {
    const calendarRaw = await parseCsvStream(calendarPath)
    const targetDate = findTargetWednesday(calendarRaw)
    console.log(`  Target date: ${formatDate(targetDate)} (Wednesday)`)
    for (const r of calendarRaw) {
      const start = r['start_date'] || ''
      const end = r['end_date'] || ''
      if (r['wednesday'] === '1' && targetDate >= start && targetDate <= end) {
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
  }
  console.log(`  Active service IDs on target date: ${activeServiceIds.size}`)

  // ── trips.txt — each trip_id → route_family ──
  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  const tripFamily = new Map<string, RouteFamily>()
  for (const r of tripsRaw) {
    const fam = routeFamily.get(r['route_id'])
    if (!fam) continue
    if (activeServiceIds.size > 0 && !activeServiceIds.has(r['service_id'])) continue
    tripFamily.set(r['trip_id'], fam)
  }
  console.log(`  ${tripFamily.size} rail/tram/metro trips on target day (of ${tripsRaw.length} total)`)
  if (tripFamily.size === 0) return []

  // ── stop_times.txt (streaming) — track per-(stop_id, family) counts ──
  console.log(`  Reading stop_times.txt (streaming)...`)
  const stopDepartures = new Map<string, Map<RouteFamily, number>>()
  const stStream = createReadStream(resolve(extractDir, 'stop_times.txt'), { encoding: 'utf-8' })
  const stRl = createInterface({ input: stStream, crlfDelay: Infinity })
  let stHeaders: string[] | null = null
  let stLines = 0, stMatched = 0
  let tripIdIdx = -1, stopIdIdx = -1
  let lastProgressTime = Date.now()

  for await (const rawLine of stRl) {
    const line = stHeaders === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue
    if (!stHeaders) {
      stHeaders = parseCsvLine(line)
      tripIdIdx = stHeaders.indexOf('trip_id')
      stopIdIdx = stHeaders.indexOf('stop_id')
      if (tripIdIdx < 0 || stopIdIdx < 0) throw new Error(`stop_times.txt missing trip_id/stop_id`)
      continue
    }
    stLines++
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    const fam = tripFamily.get(tripId)
    if (!fam) continue
    const stopId = fields[stopIdIdx]
    let fams = stopDepartures.get(stopId)
    if (!fams) { fams = new Map(); stopDepartures.set(stopId, fams) }
    fams.set(fam, (fams.get(fam) || 0) + 1)
    stMatched++
    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`    ... ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stop-times`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  ${stLines} stop_times lines, ${stMatched} rail stop-times, ${stopDepartures.size} unique stops`)

  // ── stops.txt ──
  const stopsRaw = await parseCsvStream(resolve(extractDir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  let skippedNoCoords = 0, skippedOutOfBounds = 0
  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) { skippedNoCoords++; continue }
    const [minLat, minLon, maxLat, maxLon] = AE_BBOX
    if (lat < minLat - 1 || lat > maxLat + 1 || lon < minLon - 1 || lon > maxLon + 1) {
      skippedOutOfBounds++
      continue
    }
    let h3r4: string
    try { h3r4 = latLngToCell(lat, lon, 4) } catch { continue }
    stopsMap.set(r['stop_id'], {
      stop_id: r['stop_id'],
      lat, lon,
      name: (r['stop_name'] || '').trim(),
      h3r4,
    })
  }
  console.log(`  ${stopsMap.size} stops with valid coords (skipped out-of-bounds: ${skippedOutOfBounds})`)

  // ── parent_station resolution ──
  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const parentId = (r['parent_station'] || '').trim()
    if (parentId) childToParent.set(r['stop_id'], parentId)
  }

  // Emit one StopTrainCount per (stop, family)
  const results: StopTrainCount[] = []
  let resolvedViaParent = 0
  for (const [stopId, families] of stopDepartures) {
    let stop = stopsMap.get(stopId)
    if (!stop) {
      const parentId = childToParent.get(stopId)
      if (parentId) { stop = stopsMap.get(parentId); if (stop) resolvedViaParent++ }
    }
    if (!stop) continue
    for (const [fam, count] of families) {
      results.push({
        stop_id: stop.stop_id,
        lat: stop.lat, lon: stop.lon,
        name: stop.name, h3r4: stop.h3r4,
        family: fam,
        trains_passenger: count,
        trains_freight: 0,
      })
    }
  }

  // Dedup by (coord, family) — stops with same coords but different families stay separate
  const dedupMap = new Map<string, StopTrainCount>()
  for (const sc of results) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
    const existing = dedupMap.get(key)
    if (existing) existing.trains_passenger += sc.trains_passenger
    else dedupMap.set(key, { ...sc })
  }
  const deduped = [...dedupMap.values()]

  console.log(`  [${feed.id}] ${deduped.length} (stop, family) rows (${resolvedViaParent} resolved via parent)`)
  console.log(`  [${feed.id}] GTFS parsing took ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  const paxSorted = [...deduped].sort((a, b) => b.trains_passenger - a.trains_passenger)
  if (paxSorted.length > 0) {
    console.log(`  Top stops:`)
    for (const s of paxSorted.slice(0, 8)) {
      console.log(`    ${s.trains_passenger} trains/day  [${s.family}]  ${s.name} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }
  return deduped
}

// ── CNOSSOS class defaults (fallback where GTFS doesn't match) ──

function defaultTrains(railType: number, usage: number): { pax: number; frt: number } {
  // light_rail = Abu Dhabi airport APM, Yas Island people mover
  if (railType === 2) return { pax: 200, frt: 0 }
  // tram = Dubai Tram T1 (fallback if GTFS miss)
  if (railType === 1) return { pax: 200, frt: 0 }
  // narrow_gauge = Palm Jumeirah Monorail, Ferrari World / Warner Bros theme park rides
  if (railType === 3) return { pax: 40, frt: 0 }
  // funicular (rare)
  if (railType === 4) return { pax: 20, frt: 0 }
  // rail_type=0 = Etihad Rail (heavy freight), Dubai Metro depot tracks
  if (usage === 1) return { pax: 5, frt: 15 }   // branch (spur to Jebel Ali, etc.)
  if (usage === 2) return { pax: 0, frt: 25 }   // industrial (Ruwais refinery sidings)
  return { pax: 5, frt: 40 }                    // main (Etihad Rail Stage 1 Ghuweifat↔Fujairah freight)
}

// ── Geometry ──

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

// ── Step 3: Match + enrich all UAE railway hexes ──

function enrichHexes(allStopCounts: StopTrainCount[]): void {
  // Index stops by (hex, family) so matching only considers the right family
  const stopsByHexFam = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    const key = `${sc.h3r4}/${sc.family}`
    if (!stopsByHexFam.has(key)) stopsByHexFam.set(key, [])
    stopsByHexFam.get(key)!.push(sc)
  }
  const hexesWithStops = new Set<string>()
  for (const k of stopsByHexFam.keys()) hexesWithStops.add(k.split('/')[0])
  console.log(`  GTFS stops span ${hexesWithStops.size} H3R4 hexes`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const aeHexes: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= AE_BBOX[0] && lat <= AE_BBOX[2] && lon >= AE_BBOX[1] && lon <= AE_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) aeHexes.push(hex)
      }
    } catch {}
  }
  console.log(`  UAE hexes with railways.arrow: ${aeHexes.length}`)

  let totalRails = 0
  let matchedFromGtfs = 0, matchedFromDefaults = 0
  let skippedService = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < aeHexes.length; hi++) {
    const hexId = aeHexes[hi]
    const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
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

    // Always overwrite (fresh enrichment per run — this script owns AE railways)
    const existingSourceId = table.getChild('source_id')
    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    const sourceId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    totalRails += n

    // Build per-family spatial grids for stops in this hex
    const buildGrid = (fam: RouteFamily) => {
      const grid = new Map<string, StopTrainCount[]>()
      const stops = stopsByHexFam.get(`${hexId}/${fam}`) || []
      for (const sc of stops) {
        const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key)!.push(sc)
      }
      return grid
    }
    const tramGrid = buildGrid('tram')
    const railGrid = buildGrid('rail')
    // metro stops are never matched — Dubai Metro is railway=subway (not extracted)

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = serviceCol ? ((serviceCol.get(i) as number) ?? 0) : 0
      if (service > 0) { skippedService++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      // Pick the right family grid: tram→tram, rail→rail, light_rail→(none for AE)
      let grid: Map<string, StopTrainCount[]> | null = null
      if (rt === 1) grid = tramGrid
      else if (rt === 0) grid = railGrid
      // rt===2 light_rail has no GTFS feed in UAE → fall through to defaults

      if (grid && grid.size > 0) {
        let bestDist = 500
        let bestStop: StopTrainCount | null = null
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = `${Math.floor(midLat * 100) + dy}_${Math.floor(midLon * 100) + dx}`
            const cell = grid.get(k)
            if (!cell) continue
            for (const sc of cell) {
              const d = pointToSegmentDist(sc.lat, sc.lon, sLat, sLon, eLat, eLon)
              if (d < bestDist) { bestDist = d; bestStop = sc }
            }
          }
        }
        if (bestStop) {
          trainsPax[i] = bestStop.trains_passenger
          trainsFrt[i] = bestStop.trains_freight
          sourceId[i] = MY_DATASET_ID
          hexMatched++
          matchedFromGtfs++
          continue
        }
      }

      // Fallback: CNOSSOS class default
      const def = defaultTrains(rt, us)
      trainsPax[i] = def.pax
      trainsFrt[i] = def.frt
      sourceId[i] = MY_DATASET_ID
      hexMatched++
      matchedFromDefaults++
    }

    if (hexMatched === 0) continue

    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (field.name === 'trains_passenger') continue
      if (field.name === 'trains_freight') continue
      if (field.name === 'source_id') continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
    columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())

    columns['source_id'] = vectorFromArray(sourceId, new Uint16())

    const newTable = makeTable(columns)
    writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
    hexesUpdated++

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${aeHexes.length} hexes, ${matchedFromGtfs} GTFS + ${matchedFromDefaults} defaults`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total UAE rail segments scanned: ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks: ${skippedService.toLocaleString()}`)
  console.log(`  Matched from GTFS (Dubai Tram T1): ${matchedFromGtfs.toLocaleString()}`)
  console.log(`  Matched from CNOSSOS defaults: ${matchedFromDefaults.toLocaleString()}`)
  console.log(`  Total enriched: ${(matchedFromGtfs + matchedFromDefaults).toLocaleString()} (${((matchedFromGtfs + matchedFromDefaults) / Math.max(totalRails, 1) * 100).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${aeHexes.length}`)
}

// ── Main ──

async function main() {
  console.log(`=== AE Railway Enrichment — Dubai RTA GTFS + CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Try to reuse cached merged frequencies
  let merged: StopTrainCount[]
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_FREQUENCIES}`)
    merged = JSON.parse(readFileSync(CACHE_FREQUENCIES, 'utf-8'))
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const feeds = await downloadAllGtfs()
    const perFeedCounts: StopTrainCount[][] = []
    for (const { feed, dir } of feeds) {
      const counts = await computeStopFrequenciesForFeed(feed, dir)
      perFeedCounts.push(counts)
    }
    // Merge (only one feed for AE but keep the pattern)
    const mergeMap = new Map<string, StopTrainCount>()
    for (const counts of perFeedCounts) {
      for (const sc of counts) {
        const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}`
        const existing = mergeMap.get(key)
        if (existing) {
          existing.trains_passenger += sc.trains_passenger
          existing.trains_freight += sc.trains_freight
        } else mergeMap.set(key, { ...sc })
      }
    }
    merged = [...mergeMap.values()]
    writeFileSync(CACHE_FREQUENCIES, JSON.stringify(merged))
    console.log(`\n  Merged ${merged.length} stops, cached to ${CACHE_FREQUENCIES}`)
  }

  console.log(`\n  Enriching railways.arrow files (GTFS + class defaults)...`)
  enrichHexes(merged)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
