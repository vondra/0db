/**
 * Enrich TH railways.arrow with Namtang GTFS (OTP / สนข. official transit feed).
 *
 * Namtang (นามทาง) is the unified Thai transit feed published by the Office of
 * Transport and Traffic Policy and Planning (OTP / สนข., part of the Ministry
 * of Transport). A single 27 MB zipped GTFS covers:
 *
 *   - **BTS Skytrain (BTSC)** — 5 tram/LRT routes (Sukhumvit / Silom / etc.)
 *     OSM tag: `railway=light_rail` → extracted
 *   - **MRT Bangkok (BEM)** — 4 metro routes (Blue, Purple, Yellow, Pink)
 *     OSM tag: `railway=subway` → NOT extracted (pipeline bug — same as
 *     Dubai Metro, Taipei Metro, Singapore MRT, Seoul, Tokyo, HK, Mexico City)
 *   - **Airport Rail Link / SRT Red Line (SRTET)** — Suvarnabhumi↔Phaya Thai
 *     + Bangkok Red Line suburban
 *   - **State Railway of Thailand (SRT)** — 189 national rail routes (Bangkok↔
 *     Chiang Mai / Ubon Ratchathani / Nong Khai / Sungai Kolok / Haad Yai)
 *   - **BMTA + regional buses** (211 bus routes) — excluded from rail enrichment
 *   - 943 DLT intercity bus routes + 154 TSB + 98 TC — excluded
 *
 * Source: `https://namtang-api.otp.go.th/download/namtang-gtfs.zip` (anonymous,
 * updated daily, 27 MB zipped / 160 MB uncompressed, last-modified 2026-04-10).
 * Mirror: `https://github.com/asiripanich/bangkok-gtfs` (daily snapshots since
 * April 2022).
 *
 * Applied by: exact per-family GTFS match + CNOSSOS Thailand class defaults
 * fallback. SRT passenger stops ×2 for bidirectional travel. Metro routes
 * parsed but no matches — documented in provenance.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-th.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-th.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-th.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { latLngToCell, cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/th`)
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-stop-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const FEED_URL = 'https://namtang-api.otp.go.th/download/namtang-gtfs.zip'

// Thailand bbox + exclusion zones for neighbour countries.
// Conservative bboxes that don't clip Chiang Mai (18.8N/98.99E),
// Korat (14.97N/102.1E), Udon Thani (17.41N/102.79E), Surat Thani (9.1N/99.3E).
const TH_BBOX: [number, number, number, number] = [5.5, 97.3, 20.5, 105.7]
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Myanmar',  bbox: [10.0, 97.3, 20.5, 98.3] },
  { name: 'Laos',     bbox: [17.9, 101.0, 22.5, 106.0] },
  { name: 'Cambodia', bbox: [10.0, 103.3, 14.7, 107.0] },
  { name: 'Vietnam',  bbox: [8.0, 104.5, 23.5, 109.5] },
  { name: 'Malaysia', bbox: [1.0, 99.5, 6.3, 104.5] },
]
function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

type RouteFamily = 'rail' | 'tram' | 'metro'

interface GtfsStop { stop_id: string; lat: number; lon: number; name: string; h3r4: string }
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

// GTFS route_type families
const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
const TRAM_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906])
const METRO_TYPES = new Set([1, 400, 401, 402, 403, 404, 405])

// ── CSV parsing ──
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = '', inQuotes = false
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
  let minDate = '99999999', maxDate = '00000000'
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
  const midMs = parseGtfsDate(minDate) + (parseGtfsDate(maxDate) - parseGtfsDate(minDate)) / 2
  const mid = new Date(midMs)
  const offset = (3 - mid.getDay() + 7) % 7
  mid.setDate(mid.getDate() + offset)
  return mid.toISOString().substring(0, 10).replace(/-/g, '')
}

async function downloadGtfs(): Promise<string> {
  const extractDir = resolve(CACHE_DIR, 'gtfs-namtang')
  if (!forceDownload && existsSync(resolve(extractDir, 'stops.txt'))) {
    console.log(`  Using cached GTFS: ${extractDir}`)
    return extractDir
  }
  if (enrichOnly && !existsSync(resolve(extractDir, 'stops.txt'))) {
    throw new Error('--enrich-only but no cached GTFS')
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  const zipPath = resolve(CACHE_DIR, 'namtang-gtfs.zip')
  if (!existsSync(zipPath) || forceDownload) {
    console.log(`  Downloading Namtang GTFS from ${FEED_URL}...`)
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(600_000), headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    console.log(`  Downloaded.`)
  }
  mkdirSync(extractDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })
  return extractDir
}

async function computeStopFrequencies(dir: string): Promise<StopTrainCount[]> {
  console.log(`\n  Parsing GTFS files from ${dir}...`)
  const startTime = Date.now()

  // routes.txt
  const routesRaw = await parseCsvStream(resolve(dir, 'routes.txt'))
  const routeFamily = new Map<string, RouteFamily>()
  let nRail = 0, nTram = 0, nMetro = 0
  for (const r of routesRaw) {
    const rt = parseInt(r['route_type'] || '3')
    if (RAIL_TYPES.has(rt)) { routeFamily.set(r['route_id'], 'rail'); nRail++ }
    else if (TRAM_TYPES.has(rt)) { routeFamily.set(r['route_id'], 'tram'); nTram++ }
    else if (METRO_TYPES.has(rt)) { routeFamily.set(r['route_id'], 'metro'); nMetro++ }
  }
  console.log(`  Routes: ${routesRaw.length} total, ${routeFamily.size} rail-like (rail=${nRail}, tram=${nTram}, metro=${nMetro})`)

  // calendar
  const activeServiceIds = new Set<string>()
  const calendarPath = resolve(dir, 'calendar.txt')
  const calendarDatesPath = resolve(dir, 'calendar_dates.txt')
  if (existsSync(calendarPath)) {
    const cal = await parseCsvStream(calendarPath)
    const targetDate = findTargetWednesday(cal)
    console.log(`  Target date: ${formatDate(targetDate)} (Wednesday)`)
    for (const r of cal) {
      const start = r['start_date'] || ''
      const end = r['end_date'] || ''
      if (r['wednesday'] === '1' && targetDate >= start && targetDate <= end) activeServiceIds.add(r['service_id'])
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

  // trips
  const tripsRaw = await parseCsvStream(resolve(dir, 'trips.txt'))
  const tripFamily = new Map<string, RouteFamily>()
  for (const r of tripsRaw) {
    const fam = routeFamily.get(r['route_id'])
    if (!fam) continue
    if (activeServiceIds.size > 0 && !activeServiceIds.has(r['service_id'])) continue
    tripFamily.set(r['trip_id'], fam)
  }
  console.log(`  Rail trips on target day: ${tripFamily.size} (of ${tripsRaw.length} total)`)

  // frequencies.txt (for BTS / MRT which may use headway-based service)
  // Accumulate per-trip departures from frequencies if present
  const tripBoosts = new Map<string, number>()
  const freqPath = resolve(dir, 'frequencies.txt')
  if (existsSync(freqPath)) {
    const freqs = await parseCsvStream(freqPath)
    for (const f of freqs) {
      const tid = f['trip_id']
      if (!tripFamily.has(tid)) continue
      const startSec = parseTime(f['start_time'] || '')
      const endSec = parseTime(f['end_time'] || '')
      const headway = parseInt(f['headway_secs'] || '0')
      if (startSec < 0 || endSec < 0 || headway <= 0) continue
      const durSec = Math.max(0, endSec - startSec)
      const count = Math.max(1, Math.floor(durSec / headway))
      tripBoosts.set(tid, (tripBoosts.get(tid) || 0) + count)
    }
    console.log(`  frequencies.txt boosts: ${tripBoosts.size} trips`)
  }

  // stop_times (streamed for memory)
  console.log(`  Reading stop_times.txt (streaming)...`)
  const stopDepartures = new Map<string, Map<RouteFamily, number>>()
  const stStream = createReadStream(resolve(dir, 'stop_times.txt'), { encoding: 'utf-8' })
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
      if (tripIdIdx < 0 || stopIdIdx < 0) throw new Error(`stop_times.txt missing columns`)
      continue
    }
    stLines++
    const fields = parseCsvLine(line)
    const tid = fields[tripIdIdx]
    const fam = tripFamily.get(tid)
    if (!fam) continue
    const stopId = fields[stopIdIdx]
    const boost = tripBoosts.get(tid) || 1
    let fams = stopDepartures.get(stopId)
    if (!fams) { fams = new Map(); stopDepartures.set(stopId, fams) }
    fams.set(fam, (fams.get(fam) || 0) + boost)
    stMatched += boost
    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`    ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stops`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  ${stLines} stop_times, ${stMatched} rail stops across ${stopDepartures.size} unique stops`)

  // stops.txt
  const stopsRaw = await parseCsvStream(resolve(dir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue
    const [minLat, minLon, maxLat, maxLon] = TH_BBOX
    if (lat < minLat - 1 || lat > maxLat + 1 || lon < minLon - 1 || lon > maxLon + 1) continue
    let h3r4: string
    try { h3r4 = latLngToCell(lat, lon, 4) } catch { continue }
    stopsMap.set(r['stop_id'], { stop_id: r['stop_id'], lat, lon, name: (r['stop_name'] || '').trim(), h3r4 })
  }
  console.log(`  Stops with valid coords: ${stopsMap.size}`)

  // parent_station resolution
  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const p = (r['parent_station'] || '').trim()
    if (p) childToParent.set(r['stop_id'], p)
  }

  const results: StopTrainCount[] = []
  for (const [stopId, families] of stopDepartures) {
    let stop = stopsMap.get(stopId)
    if (!stop) {
      const pid = childToParent.get(stopId)
      if (pid) stop = stopsMap.get(pid)
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

  // Dedup by (coord, family)
  const dedupMap = new Map<string, StopTrainCount>()
  for (const sc of results) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
    const existing = dedupMap.get(key)
    if (existing) existing.trains_passenger += sc.trains_passenger
    else dedupMap.set(key, { ...sc })
  }
  const deduped = [...dedupMap.values()]

  console.log(`  ${deduped.length} unique (stop, family) rows`)
  console.log(`  Parsing took ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  const paxSorted = [...deduped].sort((a, b) => b.trains_passenger - a.trains_passenger)
  if (paxSorted.length > 0) {
    console.log(`  Top stops:`)
    for (const s of paxSorted.slice(0, 10)) {
      console.log(`    ${s.trains_passenger} trains/day  [${s.family}]  ${s.name.substring(0, 50)} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }
  return deduped
}

function parseTime(s: string): number {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s.trim())
  if (!m) return -1
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
}

// CNOSSOS class defaults (fallback for segments without GTFS match)
function defaultTrains(railType: number, usage: number): { pax: number; frt: number } {
  if (railType === 2) return { pax: 200, frt: 0 }  // light_rail (BTS, ARL elevated)
  if (railType === 1) return { pax: 200, frt: 0 }  // tram (none in TH outside Bangkok BTS fallback)
  if (railType === 3) return { pax: 20, frt: 0 }   // narrow gauge
  if (railType === 4) return { pax: 10, frt: 0 }   // funicular
  // rail_type=0 heavy rail
  if (usage === 1) return { pax: 6, frt: 4 }       // SRT branch line
  if (usage === 2) return { pax: 0, frt: 8 }       // industrial
  return { pax: 20, frt: 10 }                      // SRT main line (Bangkok↔Chiang Mai etc.)
}

// Geometry helpers
function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}
function pointToSegmentDist(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat
  const py = pLat * 110540
  const ax = aLon * 111320 * cosLat
  const ay = aLat * 110540
  const bx = bLon * 111320 * cosLat
  const by = bLat * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}

function enrichHexes(allStopCounts: StopTrainCount[]): void {
  // Index stops by (hex, family)
  const stopsByHexFam = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    const key = `${sc.h3r4}/${sc.family}`
    if (!stopsByHexFam.has(key)) stopsByHexFam.set(key, [])
    stopsByHexFam.get(key)!.push(sc)
  }
  const hexesWithStops = new Set<string>()
  for (const k of stopsByHexFam.keys()) hexesWithStops.add(k.split('/')[0])
  console.log(`  GTFS stops span ${hexesWithStops.size} H3R4 hexes`)

  // Scan all TH-bbox hexes (not just ones with stops) so we apply class defaults everywhere
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const thHexes: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TH_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) thHexes.push(hex)
    } catch {}
  }
  console.log(`  TH hexes with railways.arrow: ${thHexes.length}`)

  let totalRails = 0, skippedService = 0, skippedExisting = 0, excluded = 0
  let matchedGtfs = 0, matchedDefaults = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < thHexes.length; hi++) {
    const hex = thHexes[hi]
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

    // Build family grids for this hex
    const buildGrid = (fam: RouteFamily) => {
      const grid = new Map<string, StopTrainCount[]>()
      const stops = stopsByHexFam.get(`${hex}/${fam}`) || []
      for (const sc of stops) {
        const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key)!.push(sc)
      }
      return grid
    }
    const tramGrid = buildGrid('tram')
    const railGrid = buildGrid('rail')

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (trainsPax[i] > 0 || trainsFrt[i] > 0) { skippedExisting++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, TH_BBOX)) continue
      if (inExclusion(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0

      // GTFS match: tram for rt=1/2, rail for rt=0
      let grid: Map<string, StopTrainCount[]> | null = null
      if (rt === 1 || rt === 2) grid = tramGrid
      else if (rt === 0) grid = railGrid

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
          hexMatched++
          matchedGtfs++
          continue
        }
      }

      // Fallback: CNOSSOS class default
      const def = defaultTrains(rt, us)
      trainsPax[i] = def.pax
      trainsFrt[i] = def.frt
      hexMatched++
      matchedDefaults++
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
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${thHexes.length} hexes, ${matchedGtfs} GTFS + ${matchedDefaults} defaults`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:      ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:   ${skippedService.toLocaleString()}`)
  console.log(`  Skipped already enriched: ${skippedExisting.toLocaleString()}`)
  console.log(`  Excluded (neighbours):    ${excluded.toLocaleString()}`)
  console.log(`  Matched by GTFS:          ${matchedGtfs.toLocaleString()}`)
  console.log(`  Matched by class default: ${matchedDefaults.toLocaleString()}`)
  console.log(`  Total matched:            ${(matchedGtfs + matchedDefaults).toLocaleString()} (${((matchedGtfs + matchedDefaults) / Math.max(totalRails, 1) * 100).toFixed(2)}%)`)
  console.log(`  Hexes updated:            ${hexesUpdated}/${thHexes.length}`)
}

async function main() {
  console.log(`=== TH Railway Enrichment — Namtang GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}`)

  let merged: StopTrainCount[]
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`\n  Using cached stop frequencies: ${CACHE_FREQUENCIES}`)
    merged = JSON.parse(readFileSync(CACHE_FREQUENCIES, 'utf-8'))
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const dir = await downloadGtfs()
    merged = await computeStopFrequencies(dir)
    writeFileSync(CACHE_FREQUENCIES, JSON.stringify(merged))
    console.log(`  Cached frequencies to ${CACHE_FREQUENCIES}`)
  }

  console.log(`\n  Enriching railways.arrow files...`)
  enrichHexes(merged)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
