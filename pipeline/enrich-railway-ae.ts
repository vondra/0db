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
 * The rest of the UAE rail network (Etihad Rail freight, Ruwais refinery
 * sidings, Abu Dhabi airport APM, Yas Island people mover, Palm Jumeirah
 * Monorail) has no public timetable and STAYS at source_id=0 — the engine
 * default table (emission/railway.rs::default_traffic) owns those rows. The
 * pre-2026-07-10 CNOSSOS class-default stamping was purged; its tuple table
 * survives only as the OLD_FALLBACK retract signature below.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-ae.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-ae.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-ae.ts --enrich-only
 */

import { writeFileSync, readdirSync, existsSync, mkdirSync, createReadStream, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { shouldOverwrite } from './lib/provenance.js'
import { writeRailTrains, type RailRow } from './lib/railways-arrow.js'
import { latLngToCell, cellToLatLng } from 'h3-js'
import { SOURCE_ID_AE_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import {
  RAIL_TYPES, TRAM_TYPES, METRO_TYPES, nearestGridStop, parseGtfsDate, formatDate,
  describeIncompleteFeeds, logRetractSkippedIncompleteInputs, readMergedStopCache,
  writeMergedStopCache, type GtfsStop,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_AE_NATIONAL_RAILWAY

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

const ALL_RAIL_AND_TRAM = new Set([...RAIL_TYPES, ...TRAM_TYPES, ...METRO_TYPES])

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

// ── Date helpers (parseGtfsDate/formatDate hoisted to lib/gtfs-enrich-core.ts) ──

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

    // NOTE: this used to `continue` the INNER file loop — a no-op that let a feed
    // missing trips.txt/routes.txt through to the parser. Flag + outer continue,
    // the same shape enrich-railway-be.ts uses.
    let requiredFilesOk = true
    for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
      if (!existsSync(resolve(gtfsDir, f))) {
        console.log(`  [${feed.id}] Missing ${f}, skipping feed`)
        requiredFilesOk = false
        break
      }
    }
    if (!requiredFilesOk) continue

    results.push({ feed, dir: gtfsDir })
  }

  if (results.length === 0) {
    // Class-default stamping was purged 2026-07-10 — zero feeds now means zero
    // stamping AND (via the retractSafe gate in main) a skipped retract.
    console.log(`  No GTFS feeds available — nothing will be stamped.`)
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

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: AE's deleted
// class-default table, verbatim (differs from the canonical EU table — Etihad Rail is
// freight-heavy). A row still owned by MY_SOURCE_ID whose counts exactly equal its
// class tuple was filled by that fallback, not measured — exact-tuple + family
// ambiguity is negligible (/tmp/quietmap-v4/gtfs-rail-misjoin.md §3), and the retract's
// `when` re-runs today's stop join, so a live-covered row is re-stamped by `match`,
// never disowned. No-match rows now return null: source_id stays 0 and the ENGINE
// default table (engine/noise-compute/src/emission/railway.rs::default_traffic) owns
// the "we don't know" case. DELETE this retract (and OLD_FALLBACK) after the world
// rail repaint confirms 0 retractions.
const OLD_FALLBACK = (railType: number, usage: number): [pax: number, frt: number] => {
  if (railType === 2) return [200, 0]  // light_rail (Abu Dhabi APM, Yas Island)
  if (railType === 1) return [200, 0]  // tram (Dubai Tram T1 GTFS miss)
  if (railType === 3) return [40, 0]   // narrow_gauge (Palm Monorail, theme parks)
  if (railType === 4) return [20, 0]   // funicular
  if (usage === 1) return [5, 15]      // branch (spur to Jebel Ali, etc.)
  if (usage === 2) return [0, 25]      // industrial (Ruwais refinery sidings)
  return [5, 40]                       // main (Etihad Rail Stage 1 freight)
}
const wasOldFallbackStamp = (row: RailRow): boolean => {
  const [pax, frt] = OLD_FALLBACK(row.railType, row.usage)
  return row.existingPax === pax && row.existingFrt === frt
}

// ── Step 3: Match + enrich all UAE railway hexes ──

async function enrichHexes(allStopCounts: StopTrainCount[], retractSafe: boolean): Promise<void> {
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
  let matchedFromGtfs = 0, totalRetracted = 0
  let skippedService = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < aeHexes.length; hi++) {
    const hexId = aeHexes[hi]

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

    // FAMILY routing (tram grid for rail_type 1, rail grid for 0) → GTFS
    // nearest-stop match, all inside the match closure; no-match rows return null
    // (engine default_traffic owns unknowns). writeRailTrains owns the service-skip,
    // the priority gate, the retract self-heal, and the byte-identical write.
    const r = await writeRailTrains(resolve(H3R4_DIR, hexId, 'railways.arrow'), (row) => {
      if (!shouldOverwrite(row.existingSourceId, MY_SOURCE_ID)) return null

      const rt = row.railType

      // Pick the right family grid: tram→tram, rail→rail, light_rail→(none for AE)
      const grid = rt === 1 ? tramGrid : rt === 0 ? railGrid : null
      const bestStop = grid ? nearestGridStop(grid, row) : null
      if (bestStop) {
        matchedFromGtfs++
        return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
      }

      // No GTFS match (or unhandled rail_type): return null — the row stays/goes
      // source_id=0 and the ENGINE default table (emission/railway.rs::default_traffic)
      // owns the unknown. Never stamp a guess under MY_SOURCE_ID.
      return null
    }, undefined,
    // CRITICAL-1b: retract only over a provably complete snapshot (retractSafe) —
    // with a missing/empty feed, "no stop covers this row" is an input artifact,
    // not evidence, and would disown REAL stamps.
    retractSafe ? {
      sourceId: MY_SOURCE_ID,
      // Disown a legacy pre-2026-07-10 class-default stamp ONLY when today's join no
      // longer reaches the row (same family routing + 500 m grid join as `match`) —
      // a row a live stop still covers is re-stamped with the real count instead.
      when: (row) => {
        if (!wasOldFallbackStamp(row)) return false
        const grid = row.railType === 1 ? tramGrid : row.railType === 0 ? railGrid : null
        return !grid || nearestGridStop(grid, row) === null
      },
    } : undefined)

    totalRails += r.rows
    totalRetracted += r.retracted
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${aeHexes.length} hexes, ${matchedFromGtfs} GTFS, ${totalRetracted} retracted`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total UAE rail segments scanned: ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks: ${skippedService.toLocaleString()}`)
  console.log(`  Matched from GTFS (Dubai Tram T1): ${matchedFromGtfs.toLocaleString()} (${(matchedFromGtfs / Math.max(totalRails, 1) * 100).toFixed(2)}%)`)
  console.log(`  Retracted legacy defaults: ${totalRetracted.toLocaleString()}`)
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

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot — the RTA feed loaded non-empty this run (or a cache that proves it).
  // downloadAllGtfs tolerates TOTAL failure (returns zero feeds), and this main used
  // to proceed regardless: an empty snapshot makes the retract's join corroboration
  // read "no coverage" everywhere and wipe every legacy AE stamp. Only the retract
  // is gated — never the stamping.
  let merged: StopTrainCount[]
  let retractUnsafeDetail: string
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_FREQUENCIES}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_FREQUENCIES)
    merged = cached.stops
    retractUnsafeDetail = cached.feedsLoadedNonEmpty === null
      // Legacy bare-array cache: with a SINGLE configured feed, non-empty stops are
      // themselves the completeness proof (the one feed parsed non-empty when the
      // cache was written). The FEEDS.length===1 term is the tripwire that voids
      // this shortcut the day a second AE feed is added.
      ? (FEEDS.length === 1 && merged.length > 0 ? '' : `legacy merged cache without feed provenance — delete ${CACHE_FREQUENCIES} to rebuild from the cached feed extract`)
      : describeIncompleteFeeds(FEEDS.map(f => f.id), cached.feedsLoadedNonEmpty)
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
    const feedsLoadedNonEmpty = feeds.filter((_, i) => perFeedCounts[i].length > 0).map(({ feed }) => feed.id)
    retractUnsafeDetail = describeIncompleteFeeds(FEEDS.map(f => f.id), feedsLoadedNonEmpty)
    if (retractUnsafeDetail === '') {
      writeMergedStopCache(CACHE_FREQUENCIES, feedsLoadedNonEmpty, merged)
      console.log(`\n  Merged ${merged.length} stops, cached to ${CACHE_FREQUENCIES}`)
    } else {
      // Never persist a partial snapshot: a poisoned cache would silently starve
      // every later cache-served run (both enrichment and the retract evidence).
      console.log(`\n  NOT caching partial merged snapshot (${retractUnsafeDetail})`)
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
