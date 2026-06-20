/**
 * Enrich MX railways.arrow with Mexican GTFS feeds.
 *
 * CDMX SEMOVI publishes a unified GTFS containing Metro, Metrobús, Trolebús,
 * Tren Ligero, Cablebús, Tren Suburbano, Pumabús, RTP, and concession corridors.
 * Distributed via mdb-latest mirror (origin datos.cdmx.gob.mx is firewalled).
 *
 * Other Mexican feeds in MobilityData are mostly bus-only — Toluca and Jilotepec.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-mx.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-mx.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-mx.ts --enrich-only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { SOURCE_ID_MX_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { pointToSegmentDist } from './lib/spatial.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import { makeCountryGate } from './lib/country-polygon.js'
import {
  RAIL_TYPES, TRAM_TYPES, METRO_TYPES, routeFamily,
  parseCsvLine, parseCsvStream, parseGtfsDate, formatDate, findTargetWednesday,
  type GtfsStop, type StopTrainCount,
} from './lib/gtfs-enrich-core.js'

const MY_SOURCE_ID = SOURCE_ID_MX_NATIONAL_RAILWAY

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/mx`)
// Versioned filename: the family-aware schema added a mandatory `family` field, so a
// pre-migration cache must NOT be reused (a family-less stop would fall into tramGrid →
// heavy rail loses its count, trams re-inherit it). A new name forces a clean rebuild.
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-family-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

interface FeedConfig {
  id: string
  name: string
  urls: string[]
}

const FEEDS: FeedConfig[] = [
  {
    id: 'cdmx-semovi',
    name: 'CDMX SEMOVI unified (Metro + Metrobús + Trolebús + Tren Ligero + Cablebús + Suburbano)',
    urls: [
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/mx-unknown-pumabus-gtfs-1830.zip?alt=media',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/mx-distrito-federal-corredores-concesionados-gtfs-1099.zip?alt=media',
    ],
  },
  {
    id: 'toluca-movimex',
    name: 'Toluca + Metropolitan Area (Movimex)',
    urls: [
      'https://datos.movimex.gob.mx/gtfs/toluca.gtfs.zip',
    ],
  },
]

// Mexico bbox
const PT_BBOX: [number, number, number, number] = [14.5, -118.4, 32.7, -86.7]

// ── Step 1: Download GTFS feeds ──

/**
 * Download all configured GTFS feeds and return a list of extraction directories.
 * Each feed is cached in its own subdirectory so multiple feeds can coexist.
 */
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
          signal: AbortSignal.timeout(600_000),
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
      console.log(`  [${feed.id}] All URLs failed — skipping this feed`)
      continue
    }

    mkdirSync(extractDir, { recursive: true })
    execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })

    for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
      if (!existsSync(resolve(extractDir, f))) {
        console.log(`  [${feed.id}] Missing ${f}, skipping feed`)
        downloaded = false
        break
      }
    }

    execSync(`rm -f "${zipPath}"`)

    if (downloaded) results.push({ feed, dir: extractDir })
  }

  if (results.length === 0) {
    throw new Error('Failed to download any Mexican GTFS feed')
  }

  console.log(`  ${results.length}/${FEEDS.length} MX feeds available`)
  return results
}

// ── Step 2: Parse GTFS and compute stop frequencies ──

async function computeStopFrequenciesForFeed(feed: FeedConfig, extractDir: string): Promise<StopTrainCount[]> {
  console.log(`\n  [${feed.id}] Parsing GTFS files...`)
  const startTime = Date.now()

  // ── routes.txt: route_id -> route_type ──
  console.log(`  Reading routes.txt...`)
  const routesRaw = await parseCsvStream(resolve(extractDir, 'routes.txt'))
  const routeTypeMap = new Map<string, number>()
  for (const r of routesRaw) {
    routeTypeMap.set(r['route_id'], parseInt(r['route_type'] || '3'))
  }
  console.log(`  ${routeTypeMap.size} routes total`)

  const routeFam = new Map<string, 'rail' | 'tram'>()
  for (const [routeId, routeType] of routeTypeMap) {
    const fam = routeFamily(routeType)
    if (fam) routeFam.set(routeId, fam)
  }
  console.log(`  ${routeFam.size} rail/tram routes`)

  if (routeFam.size === 0) {
    console.log(`  WARNING: No rail routes found. Returning empty.`)
    return []
  }

  // ── calendar.txt / calendar_dates.txt ──
  console.log(`  Reading calendar...`)
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
  } else if (existsSync(calendarDatesPath)) {
    console.log(`  No calendar.txt, using calendar_dates.txt only`)
    const calDates = await parseCsvStream(calendarDatesPath)
    const dateCounts = new Map<string, number>()
    for (const r of calDates) {
      if (r['exception_type'] === '1') {
        dateCounts.set(r['date'] || '', (dateCounts.get(r['date'] || '') || 0) + 1)
      }
    }
    const wednesdays = [...dateCounts.entries()]
      .filter(([d]) => new Date(parseGtfsDate(d)).getDay() === 3)
      .sort((a, b) => b[1] - a[1])

    if (wednesdays.length > 0) {
      const targetDate = wednesdays[0][0]
      console.log(`  Target date (from calendar_dates): ${formatDate(targetDate)} (${wednesdays[0][1]} services)`)
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
    console.log(`  WARNING: No calendar files. Counting all trips.`)
  }

  console.log(`  ${activeServiceIds.size} active service IDs on target date`)

  // ── trips.txt ──
  console.log(`  Reading trips.txt...`)
  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  const tripFam = new Map<string, 'rail' | 'tram'>()
  for (const r of tripsRaw) {
    const fam = routeFam.get(r['route_id'])
    if (!fam) continue
    if (activeServiceIds.size > 0 && !activeServiceIds.has(r['service_id'])) continue
    tripFam.set(r['trip_id'], fam)
  }
  console.log(`  ${tripFam.size} rail trips on target day (of ${tripsRaw.length} total)`)

  if (tripFam.size === 0) {
    console.log(`  WARNING: No active rail trips. Returning empty.`)
    return []
  }

  // ── frequencies.txt: headway-based service expansion ──
  // CDMX SEMOVI publishes Metro/Tren Ligero as frequency-based trips: a single
  // template trip in stop_times.txt repeated every `headway_secs`. Counting each
  // stop_time as one departure understates Línea 1 by ~225× (it runs ~285-570
  // trains/day, not 2). Expand each trip to its daily departure count so the
  // per-stop train counts reflect real service.
  const freqPath = resolve(extractDir, 'frequencies.txt')
  const tripDepartures = new Map<string, number>()  // trip_id → departures/day (default 1)
  if (existsSync(freqPath)) {
    const freqRaw = await parseCsvStream(freqPath)
    const toSecs = (t: string): number => {
      const [h, m, s] = (t || '').split(':').map((v) => parseInt(v, 10))
      return (h || 0) * 3600 + (m || 0) * 60 + (s || 0)
    }
    for (const r of freqRaw) {
      const tid = r['trip_id']
      if (!tid || !tripFam.has(tid)) continue
      const headway = parseInt(r['headway_secs'] || '0', 10)
      const span = toSecs(r['end_time']) - toSecs(r['start_time'])
      if (headway <= 0 || span <= 0) continue
      tripDepartures.set(tid, (tripDepartures.get(tid) || 0) + Math.round(span / headway))
    }
    console.log(`  frequencies.txt: ${tripDepartures.size} rail trips expanded by headway (else 1 departure)`)
  }

  // ── stop_times.txt (stream for large files) ──
  console.log(`  Reading stop_times.txt (streaming)...`)
  const stopDepartures = new Map<string, { rail: number; tram: number }>()

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
        throw new Error(`stop_times.txt missing trip_id/stop_id. Found: ${stHeaders.join(', ')}`)
      }
      continue
    }

    stLines++
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    const fam = tripFam.get(tripId)
    if (!fam) continue

    const stopId = fields[stopIdIdx]
    let counts = stopDepartures.get(stopId)
    if (!counts) { counts = { rail: 0, tram: 0 }; stopDepartures.set(stopId, counts) }
    counts[fam] += tripDepartures.get(tripId) ?? 1   // headway-expanded departures, else 1
    stMatched++

    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`    ... ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stop-times`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  ${stLines} stop_times lines, ${stMatched} rail stop-times, ${stopDepartures.size} unique stops`)

  // ── stops.txt ──
  console.log(`  Reading stops.txt...`)
  const stopsRaw = await parseCsvStream(resolve(extractDir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  let skippedNoCoords = 0
  let skippedOutOfBounds = 0

  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) { skippedNoCoords++; continue }

    // Bounding box check (1 degree margin for border stops)
    const [minLat, minLon, maxLat, maxLon] = PT_BBOX
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
  console.log(`  ${stopsMap.size} stops with valid coords`)
  if (skippedOutOfBounds > 0) console.log(`  Skipped (out of bounds): ${skippedOutOfBounds}`)

  // ── Resolve parent stations ──
  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const parentId = (r['parent_station'] || '').trim()
    if (parentId) childToParent.set(r['stop_id'], parentId)
  }

  // ── Build final list ──
  const results: StopTrainCount[] = []
  let resolvedViaParent = 0

  for (const [stopId, counts] of stopDepartures) {
    let stop = stopsMap.get(stopId)
    if (!stop) {
      const parentId = childToParent.get(stopId)
      if (parentId) {
        stop = stopsMap.get(parentId)
        if (stop) resolvedViaParent++
      }
    }
    if (!stop) continue

    for (const family of ['rail', 'tram'] as const) {
      if (counts[family] === 0) continue
      results.push({
        stop_id: stop.stop_id,
        lat: stop.lat,
        lon: stop.lon,
        name: stop.name,
        h3r4: stop.h3r4,
        family,
        trains_passenger: counts[family],
        trains_freight: 0,
      })
    }
  }

  // Deduplicate by coordinates + family
  const dedupMap = new Map<string, StopTrainCount>()
  for (const sc of results) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
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

/** Merge stop counts from multiple feeds, deduplicating by coordinates. */
function mergeStopCounts(perFeedCounts: StopTrainCount[][]): StopTrainCount[] {
  const mergeMap = new Map<string, StopTrainCount>()
  for (const counts of perFeedCounts) {
    for (const sc of counts) {
      const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
      const existing = mergeMap.get(key)
      if (existing) {
        existing.trains_passenger += sc.trains_passenger
        existing.trains_freight += sc.trains_freight
      } else {
        mergeMap.set(key, { ...sc })
      }
    }
  }
  const merged = [...mergeMap.values()]

  const paxCounts = merged.map(s => s.trains_passenger).sort((a, b) => b - a)
  if (paxCounts.length > 0) {
    console.log(`\n  Merged: ${merged.length} unique stops`)
    console.log(`  Train frequency: max=${paxCounts[0]}, median=${paxCounts[Math.floor(paxCounts.length / 2)]}, min=${paxCounts[paxCounts.length - 1]}`)
    const top5 = [...merged].sort((a, b) => b.trains_passenger - a.trains_passenger).slice(0, 5)
    console.log(`  Busiest stops:`)
    for (const s of top5) {
      console.log(`    ${s.trains_passenger} trains/day: ${s.name} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }

  return merged
}

// ── Step 3: Match stops to railway segments and write Arrow ──

// CNOSSOS operator-class fallback (owner-confirmed L2: fill by type, no silent track).
// Mirrors enrich-railway-kr.ts; industrial freight=8 mirrors th.ts; heavy-rail main=50/10
// is a conservative floor (GTFS covers the busy lines, an unmatched main is a minor line).
// rail_type: 0=rail 1=tram 2=light_rail 3=narrow_gauge 4=funicular; usage: 0=main 1=branch 2=industrial
function defaultTrains(railType: number, usage: number): { pax: number; frt: number } {
  if (railType === 2) return { pax: 250, frt: 0 }
  if (railType === 1) return { pax: 200, frt: 0 }
  if (railType === 3) return { pax: 30, frt: 0 }
  if (railType === 4) return { pax: 30, frt: 0 }
  if (usage === 1) return { pax: 80, frt: 0 }
  if (usage === 2) return { pax: 0, frt: 8 }
  return { pax: 50, frt: 10 }
}

async function enrichHexes(allStopCounts: StopTrainCount[]): Promise<void> {
  // Group stops by H3R4 hex
  const stopsByHex = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    if (!stopsByHex.has(sc.h3r4)) stopsByHex.set(sc.h3r4, [])
    stopsByHex.get(sc.h3r4)!.push(sc)
  }
  console.log(`  Stops span ${stopsByHex.size} H3R4 hexes`)

  // Scan ALL Mexican hexes (not just ones with stops) so class defaults reach
  // every track — a tram that no longer inherits a suburban count gets its own value.
  const hexDirs = iterateCountryHexes(H3R4_DIR, PT_BBOX, 'railways.arrow')
  console.log(`  MX hexes with railways.arrow: ${hexDirs.length}`)

  // Gate every segment to Mexican soil: PT_BBOX overlaps Guatemala/Belize, so the
  // class-default fallback would otherwise stamp MX defaults onto cross-border rail.
  // Created here (not module scope): makeCountryGate may download+convert the CGAZ
  // polygon on first run — keep that off the import path.
  const inMX = makeCountryGate('MX')

  let totalRails = 0, totalStamped = 0, gtfsHits = 0, skippedService = 0, hexesUpdated = 0, outsideMX = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    // Build this hex's two family grids once (0.01° ≈ 1 km cells).
    const railGrid = new Map<string, StopTrainCount[]>()
    const tramGrid = new Map<string, StopTrainCount[]>()
    for (const sc of stopsByHex.get(hexId) || []) {
      const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
      const grid = sc.family === 'rail' ? railGrid : tramGrid
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(sc)
    }

    let matchWasGtfs = false
    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexId, 'railways.arrow'),
      (row) => {
        matchWasGtfs = false
        // Country gate first: skip segments outside Mexico (Guatemala/Belize) so
        // neither a GTFS match nor the class default stamps them with MX data.
        if (!inMX(row.midLat, row.midLon)) { outsideMX++; return null }
        // Family gate: heavy rail (rail_type 0) → suburban rail stops; tram/light_rail
        // (rail_type 1/2) → metro/light-rail stops. Cross-family matches can't happen.
        const grid = row.railType === 0 ? railGrid : (row.railType === 1 || row.railType === 2) ? tramGrid : null
        if (grid && grid.size > 0) {
          let bestDist = 500
          let bestStop: StopTrainCount | null = null
          const gy = Math.floor(row.midLat * 100), gx = Math.floor(row.midLon * 100)
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const cell = grid.get(`${gy + dy}_${gx + dx}`)
            if (!cell) continue
            for (const sc of cell) {
              const d = pointToSegmentDist(sc.lat, sc.lon, row.startLat, row.startLon, row.endLat, row.endLon)
              if (d < bestDist) { bestDist = d; bestStop = sc }
            }
          }
          if (bestStop) {
            matchWasGtfs = true
            return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
          }
        }
        // No GTFS match (or unhandled rail_type): CNOSSOS class default.
        const def = defaultTrains(row.railType, row.usage)
        return { pax: def.pax, frt: def.frt, sourceId: MY_SOURCE_ID }
      },
      () => { if (matchWasGtfs) gtfsHits++ }, // count only post-gate (applied) GTFS matches
    )
    totalRails += r.rows
    totalStamped += r.matched
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    if (hi % 200 === 0 || hi === hexDirs.length - 1) {
      console.log(`  [${((Date.now() - startTime) / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${totalStamped.toLocaleString()} stamped (${gtfsHits.toLocaleString()} via GTFS)`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Railway segments scanned:  ${totalRails.toLocaleString()}`)
  console.log(`  Outside MX polygon:        ${outsideMX.toLocaleString()}`)
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by GTFS:           ${gtfsHits.toLocaleString()}`)
  console.log(`  Stamped (incl. defaults):  ${totalStamped.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)
}

// ── Main ──

async function main() {
  console.log(`=== MX Railway Enrichment — Multi-feed GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Try to reuse cached merged frequencies if present and not forced
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

    merged = mergeStopCounts(perFeedCounts)

    writeFileSync(CACHE_FREQUENCIES, JSON.stringify(merged))
    console.log(`  Cached merged frequencies to ${CACHE_FREQUENCIES}`)
  }

  if (merged.length === 0) {
    console.log(`\nNo GTFS data to enrich. Exiting.`)
    return
  }

  console.log(`\n  Enriching railways.arrow files...`)
  await enrichHexes(merged)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
