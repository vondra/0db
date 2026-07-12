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
 * Applied by: exact per-family GTFS match; segments the feed doesn't reach stay
 * source_id=0 (engine default_traffic owns unknowns — the Thailand class-default
 * fallback was purged 2026-07-10, see OLD_FALLBACK retract). SRT passenger stops
 * ×2 for bidirectional travel. Metro routes parsed but no matches — documented
 * in provenance.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-th.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-th.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-th.ts --enrich-only
 */

import { writeFileSync, readdirSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { shouldOverwrite } from './lib/provenance.js'
import { writeRailTrains, type RailRow } from './lib/railways-arrow.js'
import { makeCountryGate, segmentWhollyOutside } from './lib/country-polygon.js'
import { latLngToCell, cellToLatLng } from 'h3-js'
import { SOURCE_ID_TH_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { inBbox } from './lib/spatial.js'
import {
  RAIL_TYPES, TRAM_TYPES, METRO_TYPES, nearestGridStop, parseGtfsDate, formatDate,
  logRetractSkippedIncompleteInputs, readMergedStopCache, writeMergedStopCache,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_TH_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/th`)
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-stop-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const FEED_URL = 'https://namtang-api.otp.go.th/download/namtang-gtfs.zip'

// Scope: the exact CGAZ TH polygon via the central writeRailTrains countryGate (#31.7).
// Conservative bboxes that don't clip Chiang Mai (18.8N/98.99E),
// Korat (14.97N/102.1E), Udon Thani (17.41N/102.79E), Surat Thani (9.1N/99.3E).
const TH_BBOX: [number, number, number, number] = [5.5, 97.3, 20.5, 105.7]
// Neighbour exclusion boxes DELETED (#32, /gg #31 round-2 Codex): the central
// writeRailTrains countryGate (exact CGAZ polygon) owns national scope now, and
// the hand rectangles provably clipped DOMESTIC territory (the CN 'Vietnam' box
// held Nanning, IN 'Pakistan' held Ahmedabad, TH 'Malaysia' held Sungai Kolok).

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

// Route_type families + GtfsStop/StopTrainCount-adjacent generics live in lib/gtfs-enrich-core.ts.
// TH keeps its own 3-family RouteFamily (rail/tram/metro), compact CSV parser, inlined
// findTargetWednesday, and parseTime — they differ from the shared core, so stay here.

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

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: TH's deleted
// class-default table, verbatim (differs from the canonical EU table — SRT tuples).
// A row still owned by MY_SOURCE_ID whose counts exactly equal its class tuple was
// filled by that fallback, not measured — exact-tuple + family ambiguity is negligible
// (/tmp/quietmap-v4/gtfs-rail-misjoin.md §3), and the retract's `when` re-runs today's
// stop join, so a live-covered row is re-stamped by `match`, never disowned. No-match
// rows now return null: source_id stays 0 and the ENGINE default table
// (engine/noise-compute/src/emission/railway.rs::default_traffic) owns the "we don't
// know" case. DELETE this retract (and OLD_FALLBACK) after the world rail repaint
// confirms 0 retractions.
const OLD_FALLBACK = (railType: number, usage: number): [pax: number, frt: number] => {
  if (railType === 2) return [200, 0]  // light_rail (BTS, ARL elevated)
  if (railType === 1) return [200, 0]  // tram
  if (railType === 3) return [20, 0]   // narrow gauge
  if (railType === 4) return [10, 0]   // funicular
  if (usage === 1) return [6, 4]       // SRT branch line
  if (usage === 2) return [0, 8]       // industrial
  return [20, 10]                      // SRT main line
}
const wasOldFallbackStamp = (row: RailRow): boolean => {
  const [pax, frt] = OLD_FALLBACK(row.railType, row.usage)
  return row.existingPax === pax && row.existingFrt === frt
}

async function enrichHexes(allStopCounts: StopTrainCount[], retractSafe: boolean): Promise<void> {
  // COUNTRY GATE (#26C): a national feed can carry international through-services
  // (SRT runs to Sungai Kolok/Malaysia border and Vientiane/Laos), so the raw stop
  // list may contain foreign stations — joining those would stamp a neighbour's
  // track under this feed's id, and the same-rank higher-id tiebreak can beat the
  // neighbour's own national source (mechanism: the PL feed stamped 11,856 km of
  // CZ track, 7fac2349). A national feed only speaks for its own country's
  // network: foreign stops are dropped BEFORE any grid is built (the polygon gate
  // subsumes the coarse TH_BBOX pre-filter for stops; the row side is owned by
  // the central writeRailTrains countryGate — the old EXCLUDE_ZONES are gone, #32).
  const inTh = makeCountryGate('TH')
  const rawCount = allStopCounts.length
  allStopCounts = allStopCounts.filter((sc) => inTh(sc.lat, sc.lon))
  if (rawCount !== allStopCounts.length) {
    console.log(`  country gate: ${rawCount - allStopCounts.length} foreign stops dropped (international through-services)`)
  }
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

  // Scan all TH-bbox hexes (not just ones with stops) so the OLD_FALLBACK retract
  // reaches hexes whose stop coverage vanished (class defaults themselves are purged)
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const thHexes: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TH_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) thHexes.push(hex)
    } catch {}
  }
  console.log(`  TH hexes with railways.arrow: ${thHexes.length}`)

  let totalRails = 0, skippedService = 0, skippedExisting = 0
  let matchedGtfs = 0, totalRetracted = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < thHexes.length; hi++) {
    const hex = thHexes[hi]

    // Build family grids for this hex (GTFS stops indexed by 0.01-deg cell).
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

    // FAMILY routing (tram grid for rail_type 1/2, rail grid for 0) → GTFS
    // nearest-stop match, all inside the match closure; no-match rows return null
    // (engine default_traffic owns unknowns). writeRailTrains owns the service-skip,
    // the priority gate, the retract self-heal, and the byte-identical write.
    const r = await writeRailTrains(resolve(H3R4_DIR, hex, 'railways.arrow'), (row) => {
      if (!shouldOverwrite(row.existingSourceId, MY_SOURCE_ID)) return null
      if (!inBbox(row.midLat, row.midLon, TH_BBOX)) return null

      const rt = row.railType
      const grid = rt === 1 || rt === 2 ? tramGrid : rt === 0 ? railGrid : null
      const bestStop = grid ? nearestGridStop(grid, row) : null
      if (bestStop) {
        matchedGtfs++
        return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
      }

      // No GTFS match (or unhandled rail_type): return null — the row stays/goes
      // source_id=0 and the ENGINE default table (emission/railway.rs::default_traffic)
      // owns the unknown. Never stamp a guess under MY_SOURCE_ID.
      return null
    }, undefined,
    // CRITICAL-1b: retract only over a provably complete snapshot (retractSafe) —
    // with an empty/failed feed parse, "no stop covers this row" is an input
    // artifact, not evidence, and would disown REAL stamps.
    retractSafe ? {
      sourceId: MY_SOURCE_ID,
      // Disown a legacy pre-2026-07-10 class-default stamp ONLY when today's join no
      // longer reaches the row (same family routing + 500 m grid join as `match`) —
      // a row a live stop still covers is re-stamped with the real count instead.
      when: (row) => {
        // Country-bleed disown (#26C): ANY owned row physically wholly outside TH (start+mid+end — genuine border-straddlers stay ours; shared R9 predicate) is
        // foreign track this feed must not speak for — even when its count was
        // a real through-train figure, ownership belongs to the local country's
        // own timetable (its national enricher re-stamps on its next run).
        if (segmentWhollyOutside(inTh, row.midLat, row.midLon, row.startLat, row.startLon, row.endLat, row.endLon)) return true
        if (!wasOldFallbackStamp(row)) return false
        const grid = row.railType === 1 || row.railType === 2 ? tramGrid : row.railType === 0 ? railGrid : null
        return !grid || nearestGridStop(grid, row) === null
      },
    } : undefined,
    inTh, // #31.7 central country gate — see writeRailTrains
    )

    totalRails += r.rows
    totalRetracted += r.retracted
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${thHexes.length} hexes, ${matchedGtfs} GTFS, ${totalRetracted} retracted`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:      ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:   ${skippedService.toLocaleString()}`)
  console.log(`  Skipped already enriched: ${skippedExisting.toLocaleString()}`)
  console.log(`  Matched by GTFS:          ${matchedGtfs.toLocaleString()} (${(matchedGtfs / Math.max(totalRails, 1) * 100).toFixed(2)}%)`)
  console.log(`  Retracted legacy defaults: ${totalRetracted.toLocaleString()}`)
  console.log(`  Hexes updated:            ${hexesUpdated}/${thHexes.length}`)
}

async function main() {
  console.log(`=== TH Railway Enrichment — Namtang GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}`)

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot. TH has a SINGLE feed, so non-empty stops ARE the completeness proof
  // (both fresh and cached — a legacy bare-array cache proves itself the same way).
  // An empty snapshot would make the retract's join corroboration read "no coverage"
  // nationwide and wipe every legacy TH stamp. Only the retract is gated.
  let merged: StopTrainCount[]
  let retractUnsafeDetail: string
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`\n  Using cached stop frequencies: ${CACHE_FREQUENCIES}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_FREQUENCIES)
    merged = cached.stops
    retractUnsafeDetail = merged.length > 0 ? '' : `cached snapshot is empty: ${CACHE_FREQUENCIES}`
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const dir = await downloadGtfs()
    merged = await computeStopFrequencies(dir)
    retractUnsafeDetail = merged.length > 0 ? '' : 'namtang feed parsed to zero rail stops'
    if (retractUnsafeDetail === '') {
      writeMergedStopCache(CACHE_FREQUENCIES, ['namtang'], merged)
      console.log(`  Cached frequencies to ${CACHE_FREQUENCIES}`)
    } else {
      // Never persist an empty snapshot: a poisoned cache would silently starve
      // every later cache-served run (both enrichment and the retract evidence).
      console.log(`  NOT caching empty snapshot (${retractUnsafeDetail})`)
    }
  }
  const retractSafe = retractUnsafeDetail === ''
  if (!retractSafe) logRetractSkippedIncompleteInputs(retractUnsafeDetail)

  if (merged.length === 0) {
    console.log(`\nNo GTFS data to enrich. Exiting.`)
    return
  }

  console.log(`\n  Enriching railways.arrow files...`)
  await enrichHexes(merged, retractSafe)
  console.log(`\n=== Done ===`)
}

// Import-safe: run only when invoked directly — importing this file must never
// trigger a download/enrichment pass (pattern from enrich-roads-cz.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error('Error:', err); process.exit(1) })
}
