/**
 * Enrich ES railways.arrow with real train counts from RENFE GTFS.
 *
 * Downloads RENFE national GTFS (google_transit.zip), parses stop_times +
 * trips + routes + calendar to count trains per day per stop, matches GTFS
 * stops to OSM railway segments by proximity (500m), writes trains_passenger
 * column to railways.arrow.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-es.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-es.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-es.ts --enrich-only
 */

import { writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { SOURCE_ID_ES_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { writeRailTrains, type RailRow } from './lib/railways-arrow.js'
import { makeCountryGate } from './lib/country-polygon.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import {
  RAIL_TYPES, nearestGridStop,
  parseCsvLine, parseCsvStream, parseGtfsDate, formatDate, findTargetWednesday,
  describeIncompleteFeeds, logRetractSkippedIncompleteInputs, readMergedStopCache, writeMergedStopCache,
  type GtfsStop,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_ES_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/es`)
const CACHE_STOP_FREQ = resolve(CACHE_DIR, 'renfe-stop-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// Spain has multiple complementary rail GTFS feeds. We download all of them
// and merge stop frequencies before matching to OSM railways.
interface FeedConfig {
  id: string
  name: string
  urls: string[]  // try in order; first 200 wins
}

const FEEDS: FeedConfig[] = [
  {
    id: 'renfe-av-ld-md',
    name: 'Renfe Alta Velocidad / Larga Distancia / Media Distancia',
    urls: [
      'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-renfe-alta-velocidad-larga-distancia-media-distancia-gtfs-2620.zip?alt=media',
    ],
  },
  {
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías (commuter — Madrid, Barcelona, Valencia, Bilbao, Asturias, etc.)',
    urls: [
      'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-unknown-renfe-cercanias-gtfs-2653.zip?alt=media',
    ],
  },
  {
    id: 'fgc-catalunya',
    name: 'FGC — Ferrocarrils de la Generalitat de Catalunya',
    urls: [
      'https://www.fgc.cat/google/google_transit.zip',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-catalunya-ferrocarrils-de-la-generalitat-de-catalunya-gtfs-1856.zip?alt=media',
    ],
  },
]

// Spain bounding box (with margin for border areas)
const BBOX: [number, number, number, number] = [35.5, -10.0, 44.0, 5.0] // [minLat, minLon, maxLat, maxLon]

// RENFE/Cercanías/FGC are heavy/suburban RAIL — only rail route_types (GTFS 2 +
// 100-109) enter the stop pool, so a tram-route stop can never be matched by a
// heavy-rail (rail_type=0) segment. Spanish street trams are separate operators,
// absent from these feeds, and get a class default via the rail_type gate instead.

interface StopTrainCount {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
  trains_passenger: number
  trains_freight: number
}

// ── Step 1: Download all configured GTFS feeds ──

async function downloadAllGtfs(): Promise<Array<{ feed: FeedConfig; dir: string }>> {
  const results: Array<{ feed: FeedConfig; dir: string }> = []

  for (const feed of FEEDS) {
    const extractDir = resolve(CACHE_DIR, `gtfs-${feed.id}`)

    if (!forceDownload && existsSync(resolve(extractDir, 'stops.txt'))) {
      console.log(`  [${feed.id}] Using cached GTFS: ${extractDir}`)
      results.push({ feed, dir: extractDir })
      continue
    }
    if (enrichOnly) {
      if (!existsSync(resolve(extractDir, 'stops.txt'))) {
        console.log(`  [${feed.id}] --enrich-only but no cached GTFS, skipping`)
        continue
      }
      results.push({ feed, dir: extractDir })
      continue
    }

    mkdirSync(CACHE_DIR, { recursive: true })
    const zipPath = resolve(CACHE_DIR, `gtfs-${feed.id}.zip`)

    let downloaded = false
    for (const url of feed.urls) {
      try {
        console.log(`  [${feed.id}] Downloading from ${url}...`)
        const res = await fetch(url, {
          signal: AbortSignal.timeout(300_000),
          headers: { 'Accept': 'application/zip, application/octet-stream, */*' },
          redirect: 'follow',
        })
        if (!res.ok) {
          console.log(`  [${feed.id}] HTTP ${res.status}, trying next...`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(zipPath, buf)
        console.log(`  [${feed.id}] Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)
        downloaded = true
        break
      } catch (err: any) {
        console.log(`  [${feed.id}] Failed: ${err.message}, trying next...`)
      }
    }

    if (!downloaded) {
      console.log(`  [${feed.id}] All URLs failed — skipping`)
      continue
    }

    mkdirSync(extractDir, { recursive: true })
    execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })

    let hasFiles = true
    for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
      if (!existsSync(resolve(extractDir, f))) {
        console.log(`  [${feed.id}] Missing ${f}, skipping`)
        hasFiles = false
        break
      }
    }

    execSync(`rm -f "${zipPath}"`)

    if (hasFiles) results.push({ feed, dir: extractDir })
  }

  if (results.length === 0) {
    throw new Error('Failed to download any Spanish GTFS feed')
  }

  console.log(`\n  ${results.length}/${FEEDS.length} ES feeds available`)
  return results
}

// ── Step 2: Compute stop frequencies for one feed ──

async function computeStopFrequenciesForFeed(feed: FeedConfig, extractDir: string): Promise<StopTrainCount[]> {
  console.log(`\n  [${feed.id}] Parsing GTFS files...`)
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
    if (RAIL_TYPES.has(routeType)) {
      railRouteIds.add(routeId)
    }
  }
  console.log(`  ${railRouteIds.size} rail routes`)
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

  console.log(`  [${feed.id}] ${deduped.length} stops with train counts (${resolvedViaParent} resolved via parent station)`)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  [${feed.id}] GTFS parsing took ${elapsed}s`)

  return deduped
}

/** Merge per-feed stop counts, deduplicating by coordinates. */
function mergeStopCounts(perFeed: StopTrainCount[][]): StopTrainCount[] {
  const map = new Map<string, StopTrainCount>()
  for (const counts of perFeed) {
    for (const sc of counts) {
      const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}`
      const existing = map.get(key)
      if (existing) {
        existing.trains_passenger += sc.trains_passenger
        existing.trains_freight += sc.trains_freight
      } else {
        map.set(key, { ...sc })
      }
    }
  }
  const merged = [...map.values()]

  const paxCounts = merged.map(s => s.trains_passenger).sort((a, b) => b - a)
  if (paxCounts.length > 0) {
    console.log(`\n  Merged: ${merged.length} unique stops`)
    console.log(`  Train frequency: max=${paxCounts[0]}, median=${paxCounts[Math.floor(paxCounts.length / 2)]}, min=${paxCounts[paxCounts.length - 1]}`)
    const top5 = [...merged].sort((a, b) => b.trains_passenger - a.trains_passenger).slice(0, 5)
    console.log('  Busiest stops:')
    for (const s of top5) {
      console.log(`    ${s.trains_passenger} trains/day: ${s.name} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }

  return merged
}

// ── Step 3: Match stops to railway segments ──

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: the deleted
// class-default table, verbatim. A row still owned by MY_SOURCE_ID whose counts exactly
// equal its class tuple was filled by that fallback, not measured — exact-tuple + family
// ambiguity is negligible (/tmp/quietmap-v4/gtfs-rail-misjoin.md §3); for heavy rail the
// retract's `when` additionally re-runs today's stop join, so a live-covered row is
// re-stamped by `match`, never disowned (non-heavy rows never had a join — the ES feeds
// are heavy/suburban rail only — so every non-heavy stamp under this id WAS the fallback).
// No-match rows now return null: source_id stays 0 and the ENGINE default table
// (engine/noise-compute/src/emission/railway.rs::default_traffic) owns the "we don't
// know" case. DELETE this retract (and OLD_FALLBACK) after the world rail repaint
// confirms 0 retractions.
// rail_type: 0=rail 1=tram 2=light_rail 3=narrow_gauge 4=funicular; usage: 0=main 1=branch 2=industrial
const OLD_FALLBACK = (railType: number, usage: number): [pax: number, frt: number] => {
  if (railType === 2) return [250, 0]
  if (railType === 1) return [200, 0]
  if (railType === 3) return [30, 0]
  if (railType === 4) return [30, 0]
  if (usage === 1) return [80, 0]
  if (usage === 2) return [0, 8]
  return [50, 10]
}
const wasOldFallbackStamp = (row: RailRow): boolean => {
  const [pax, frt] = OLD_FALLBACK(row.railType, row.usage)
  return row.existingPax === pax && row.existingFrt === frt
}

async function enrichHexes(allStopCounts: StopTrainCount[], retractSafe: boolean): Promise<void> {
  // COUNTRY GATE (#26C): a national feed can carry international through-services
  // (RENFE AV/LD runs into France, Celta into Portugal), so the raw stop list may
  // contain foreign stations — joining those would stamp a neighbour's track under
  // this feed's id, and the same-rank higher-id tiebreak can beat the neighbour's
  // own national source (mechanism: the PL feed stamped 11,856 km of CZ track,
  // 7fac2349). A national feed only speaks for its own country's network: foreign
  // stops are dropped BEFORE any grid is built.
  const inEs = makeCountryGate('ES')
  const rawCount = allStopCounts.length
  allStopCounts = allStopCounts.filter((sc) => inEs(sc.lat, sc.lon))
  if (rawCount !== allStopCounts.length) {
    console.log(`  country gate: ${rawCount - allStopCounts.length} foreign stops dropped (international through-services)`)
  }
  // Group RENFE/Cercanías/FGC stops by H3R4 hex
  const stopsByHex = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    if (!stopsByHex.has(sc.h3r4)) stopsByHex.set(sc.h3r4, [])
    stopsByHex.get(sc.h3r4)!.push(sc)
  }
  console.log(`  Stops span ${stopsByHex.size} H3R4 hexes`)

  // Scan ALL Spanish hexes (not just ones with stops) so class defaults reach
  // every track — a tram that no longer inherits RENFE's count gets its own value.
  const hexDirs = iterateCountryHexes(H3R4_DIR, BBOX, 'railways.arrow')
  console.log(`  ES hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, totalStamped = 0, totalRetracted = 0, skippedService = 0, hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    // Build this hex's stop grid once (0.01° ≈ 1 km cells).
    const grid = new Map<string, StopTrainCount[]>()
    for (const sc of stopsByHex.get(hexId) || []) {
      const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(sc)
    }

    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexId, 'railways.arrow'),
      (row) => {
        // Family gate: RENFE/Cercanías/FGC are heavy/suburban RAIL, so only
        // rail_type==0 may inherit a GTFS count. Spanish street trams are separate
        // operators absent from these feeds → those rows return null below.
        if (row.railType === 0) {
          const bestStop = nearestGridStop(grid, row)
          if (bestStop) {
            return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
          }
        }
        // No GTFS match (or non-heavy-rail): return null — the row stays/goes
        // source_id=0 and the ENGINE default table (emission/railway.rs::default_traffic)
        // owns the unknown. Never stamp a guess under MY_SOURCE_ID.
        return null
      },
      undefined,
      // CRITICAL-1b: retract only over a provably complete snapshot (retractSafe) —
      // with a silently skipped feed, "no stop covers this row" is an input artifact,
      // not evidence, and would disown REAL stamps.
      retractSafe ? {
        sourceId: MY_SOURCE_ID,
        // Disown a legacy pre-2026-07-10 class-default stamp; heavy rail keeps the
        // 500 m stop-join corroboration (a live-covered row is re-stamped by `match`),
        // non-heavy rows never had a join, so the exact tuple alone is the signature.
        when: (row) => {
          // Country-bleed disown (#26C): ANY owned row physically outside ES is
          // foreign track this feed must not speak for — even when its count was
          // a real through-train figure, ownership belongs to the local country's
          // own timetable (its national enricher re-stamps on its next run).
          if (!inEs(row.midLat, row.midLon)) return true
          if (!wasOldFallbackStamp(row)) return false
          return row.railType !== 0 || nearestGridStop(grid, row) === null
        },
      } : undefined,
    )
    totalRails += r.rows
    totalStamped += r.matched
    totalRetracted += r.retracted
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    if (hi % 200 === 0 || hi === hexDirs.length - 1) {
      console.log(`  [${((Date.now() - startTime) / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${totalStamped.toLocaleString()} GTFS-stamped, ${totalRetracted.toLocaleString()} retracted`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Railway segments scanned:  ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by RENFE/FGC GTFS: ${totalStamped.toLocaleString()}`)
  console.log(`  Retracted legacy defaults: ${totalRetracted.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)
}

// ── Main ──

async function main() {
  console.log(`=== ES Railway Enrichment — Multi-feed GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot — every configured feed loaded non-empty THIS run (or a cache that
  // proves it). downloadAllGtfs tolerates per-feed failure so enrichment can still
  // stamp from the rest, but a missing feed makes the retract's join corroboration
  // read "no coverage" over that feed's region and disown REAL stamps. Only the
  // retract is gated — never the stamping.
  let merged: StopTrainCount[]
  let retractUnsafeDetail: string
  if (!forceDownload && existsSync(CACHE_STOP_FREQ)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_STOP_FREQ}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_STOP_FREQ)
    merged = cached.stops
    retractUnsafeDetail = cached.feedsLoadedNonEmpty === null
      ? `legacy merged cache without feed provenance — delete ${CACHE_STOP_FREQ} to rebuild from the cached feed extracts`
      : describeIncompleteFeeds(FEEDS.map(f => f.id), cached.feedsLoadedNonEmpty)
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const feeds = await downloadAllGtfs()
    const perFeed: StopTrainCount[][] = []
    for (const { feed, dir } of feeds) {
      const counts = await computeStopFrequenciesForFeed(feed, dir)
      perFeed.push(counts)
    }
    merged = mergeStopCounts(perFeed)
    mkdirSync(CACHE_DIR, { recursive: true })
    const feedsLoadedNonEmpty = feeds.filter((_, i) => perFeed[i].length > 0).map(({ feed }) => feed.id)
    retractUnsafeDetail = describeIncompleteFeeds(FEEDS.map(f => f.id), feedsLoadedNonEmpty)
    if (retractUnsafeDetail === '') {
      writeMergedStopCache(CACHE_STOP_FREQ, feedsLoadedNonEmpty, merged)
      console.log(`  Cached merged frequencies to ${CACHE_STOP_FREQ}`)
    } else {
      // Never persist a partial snapshot: a poisoned cache would silently starve
      // every later cache-served run (both enrichment and the retract evidence).
      console.log(`  NOT caching partial merged snapshot (${retractUnsafeDetail})`)
    }
  }
  const retractSafe = retractUnsafeDetail === ''
  if (!retractSafe) logRetractSkippedIncompleteInputs(retractUnsafeDetail)

  if (merged.length === 0) {
    console.log('\n  No stop frequencies computed. Nothing to enrich.')
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
