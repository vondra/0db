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

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { SOURCE_ID_ES_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { pointToSegmentDist } from './lib/spatial.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'

const MY_SOURCE_ID = SOURCE_ID_ES_NATIONAL_RAILWAY

const YEAR = process.env.DATA_YEAR || '2026'
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
const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])

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

// CNOSSOS operator-class fallback (owner-confirmed L2: fill by type, no silent
// track). Mirrors enrich-railway-kr.ts; industrial freight=8 mirrors
// enrich-railway-th.ts; heavy-rail main=50pax/10frt is a conservative floor —
// RENFE/Cercanías GTFS covers the busy lines, so an unmatched main is a minor line.
// rail_type: 0=rail 1=tram 2=light_rail 3=narrow_gauge 4=funicular; usage: 0=main 1=branch 2=industrial
function defaultTrains(railType: number, usage: number): { pax: number; frt: number } {
  if (railType === 2) return { pax: 250, frt: 0 } // light_rail (urban)
  if (railType === 1) return { pax: 200, frt: 0 } // tram
  if (railType === 3) return { pax: 30, frt: 0 }  // narrow gauge
  if (railType === 4) return { pax: 30, frt: 0 }  // funicular
  if (usage === 1) return { pax: 80, frt: 0 }     // heavy-rail branch
  if (usage === 2) return { pax: 0, frt: 8 }      // industrial spur
  return { pax: 50, frt: 10 }                     // heavy-rail main without a GTFS match
}

async function enrichHexes(allStopCounts: StopTrainCount[]): Promise<void> {
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

  let totalRails = 0, totalStamped = 0, gtfsHits = 0, skippedService = 0, hexesUpdated = 0
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

    let matchWasGtfs = false
    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexId, 'railways.arrow'),
      (row) => {
        matchWasGtfs = false
        // Family gate: RENFE/Cercanías/FGC are heavy/suburban RAIL, so only
        // rail_type==0 may inherit a GTFS count. Spanish street trams are separate
        // operators absent from these feeds → tram/light_rail get a class default.
        if (row.railType === 0 && grid.size > 0) {
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
        // No GTFS match (or non-heavy-rail): CNOSSOS class default.
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
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by RENFE/FGC GTFS: ${gtfsHits.toLocaleString()}`)
  console.log(`  Stamped (incl. defaults):  ${totalStamped.toLocaleString()}`)
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

  let merged: StopTrainCount[]
  if (!forceDownload && existsSync(CACHE_STOP_FREQ)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_STOP_FREQ}`)
    merged = JSON.parse(readFileSync(CACHE_STOP_FREQ, 'utf-8'))
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
    writeFileSync(CACHE_STOP_FREQ, JSON.stringify(merged))
    console.log(`  Cached merged frequencies to ${CACHE_STOP_FREQ}`)
  }

  if (merged.length === 0) {
    console.log('\n  No stop frequencies computed. Nothing to enrich.')
    return
  }

  console.log(`\n  Enriching railways.arrow files...`)
  await enrichHexes(merged)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
