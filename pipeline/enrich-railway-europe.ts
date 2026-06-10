/**
 * Enrich railways.arrow with real train frequencies from GTFS feeds.
 *
 * Downloads GTFS feeds (starting with Germany / GTFS.DE), parses
 * stop_times + trips + routes + calendar to count trains per day per
 * stop, then matches GTFS stops to OSM railway segments by proximity
 * and writes trains_passenger / trains_freight columns.
 *
 * WHY: Most railways.arrow segments have trains_passenger=0 and
 * trains_freight=0, falling back to default_traffic(rail_type, usage).
 * GTFS feeds provide actual train frequencies for passenger services.
 *
 * Usage:
 *   npx tsx enrich-railway-europe.ts
 *   npx tsx enrich-railway-europe.ts --force-download
 *   npx tsx enrich-railway-europe.ts --enrich-only
 *   npx tsx enrich-railway-europe.ts --feed=de          # Germany only
 *   npx tsx enrich-railway-europe.ts --feed=de,ch,at    # Multiple feeds
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { SOURCE_ID_GLOBAL_GTFS_TRANSIT } from './lib/source-ids.generated.js'
import { pointToSegmentDist } from './lib/spatial.js'
import { writeRailTrains } from './lib/railways-arrow.js'

const MY_SOURCE_ID = SOURCE_ID_GLOBAL_GTFS_TRANSIT

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, '../data/enrichment/global/gtfs')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// Parse --feed=xx,yy argument
const feedArg = process.argv.find(a => a.startsWith('--feed='))
const requestedFeeds = feedArg ? feedArg.replace('--feed=', '').split(',').map(s => s.trim().toLowerCase()) : null

// ── Feed registry ──

interface FeedConfig {
  id: string
  name: string
  url: string
  country: string       // ISO 3166-1 alpha-2
  boundingBox: [number, number, number, number]  // [minLat, minLon, maxLat, maxLon] for sanity checks
  // GTFS route_type values that count as rail (2=rail, 0=tram, 1=subway, etc)
  railRouteTypes: Set<number>
}

// GTFS route_type: 0=Tram, 1=Subway, 2=Rail, 3=Bus, 4=Ferry, 5=Cable, 6=Gondola, 7=Funicular
// Extended: 100-199=Railway, 200-299=Coach, 400-499=Urban Rail, 700-799=Bus, 900-999=Tram, 1000-1099=Water
const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
const TRAM_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906])
const METRO_TYPES = new Set([1, 400, 401, 402, 403, 404, 405])
// Per-feed allow-list value: feeds with surface trams/light-rail/metro use this, rail-only feeds use
// RAIL_TYPES. METRO_TYPES is included so metro routes survive the per-feed filter and routeFamily can
// map them to the 'tram' family (they enrich OSM light_rail, rail_type 2) — without it, metro-bearing
// feeds (e.g. Sofia) would fall back to class defaults instead of real frequencies.
const ALL_RAIL_AND_TRAM = new Set([...RAIL_TYPES, ...TRAM_TYPES, ...METRO_TYPES])

// GTFS route family → OSM rail_type family (rail_type 0=rail, 1=tram, 2=light_rail).
// Metro/light-metro is grouped with tram: OSM tags light-metro as light_rail (rail_type 2)
// while GTFS tags it route_type 1 (Porto etc.), and true underground subways have no OSM
// segment so never match. Conscious Occam trade-off — a subway STOP within 500 m of a
// surface tram/light_rail segment can match it; accepted over a 3-family scheme that would
// miss GTFS-tram-tagged light rails. Bus/ferry/etc. → null (skipped).
function routeFamily(routeType: number): 'rail' | 'tram' | null {
  if (RAIL_TYPES.has(routeType)) return 'rail'
  if (TRAM_TYPES.has(routeType) || METRO_TYPES.has(routeType)) return 'tram'
  return null
}

const FEEDS: FeedConfig[] = [
  {
    id: 'de',
    name: 'Germany (DELFI)',
    url: 'https://data.public-transport.earth/gtfs/de',
    country: 'DE',
    boundingBox: [47.2, 5.8, 55.1, 15.1],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'ch',
    name: 'Switzerland (opentransportdata.swiss)',
    url: 'https://data.public-transport.earth/gtfs/ch',
    country: 'CH',
    boundingBox: [45.8, 5.9, 47.9, 10.5],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'at',
    name: 'Austria',
    url: 'https://static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_OP_2025_obb.zip',
    country: 'AT',
    boundingBox: [46.3, 9.5, 49.0, 17.2],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'nl',
    name: 'Netherlands',
    url: 'https://data.public-transport.earth/gtfs/nl',
    country: 'NL',
    boundingBox: [50.7, 3.3, 53.6, 7.3],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'se',
    name: 'Sweden',
    url: 'https://data.public-transport.earth/gtfs/se',
    country: 'SE',
    boundingBox: [55.3, 10.9, 69.1, 24.2],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'no',
    name: 'Norway',
    url: 'https://data.public-transport.earth/gtfs/no',
    country: 'NO',
    boundingBox: [57.9, 4.5, 71.2, 31.2],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'fi',
    name: 'Finland',
    url: 'https://data.public-transport.earth/gtfs/fi',
    country: 'FI',
    boundingBox: [59.7, 19.1, 70.1, 31.6],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'be',
    name: 'Belgium',
    url: 'https://gtfs.irail.be/nmbs/gtfs/latest.zip',
    country: 'BE',
    boundingBox: [49.5, 2.5, 51.5, 6.4],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'in',
    name: 'India (Indian Railways, unofficial)',
    url: 'https://github.com/Neo2308/indianrailways-gtfs/raw/refs/heads/main/gtfs/gtfs.zip',
    country: 'IN',
    boundingBox: [6.7, 68.1, 35.7, 97.4],
    railRouteTypes: RAIL_TYPES,
  },
  {
    id: 'us',
    name: 'USA (Amtrak)',
    url: 'https://content.amtrak.com/content/gtfs/GTFS.zip',
    country: 'US',
    boundingBox: [24.5, -125.0, 49.0, -66.9],
    railRouteTypes: RAIL_TYPES,
  },
  {
    id: 'ca',
    name: 'Canada (VIA Rail)',
    url: 'https://www.viarail.ca/sites/all/files/gtfs/viarail.zip',
    country: 'CA',
    boundingBox: [41.7, -141.0, 60.0, -52.6],
    railRouteTypes: RAIL_TYPES,
  },
  {
    id: 'fr',
    name: 'France (SNCF TGV + IC + TER)',
    url: 'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip',
    country: 'FR',
    boundingBox: [41.3, -5.2, 51.1, 9.6],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'lu',
    name: 'Luxembourg (CFL + Luxtram + buses)',
    url: 'https://files.mobilitydatabase.org/mdb-1108/latest.zip',
    country: 'LU',
    boundingBox: [49.4, 5.7, 50.2, 6.6],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'gr',
    name: 'Greece (TrainOSE / Hellenic Train, archived 2019)',
    url: 'https://files.mobilitydatabase.org/mdb-1161/latest.zip',
    country: 'GR',
    boundingBox: [34.8, 19.3, 41.8, 29.8],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'lv-pv',
    name: 'Latvia (Pasažieru Vilciens / Vivi rail)',
    url: 'https://files.mobilitydatabase.org/mdb-2015/latest.zip',
    country: 'LV',
    boundingBox: [55.6, 20.9, 58.1, 28.2],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'ee',
    name: 'Estonia (Peatus.ee national)',
    url: 'https://files.mobilitydatabase.org/mdb-1095/latest.zip',
    country: 'EE',
    boundingBox: [57.5, 21.8, 59.7, 28.2],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'bg-sofia',
    name: 'Bulgaria Sofia (Sofia Traffic metro+tram)',
    url: 'https://gtfs.sofiatraffic.bg/api/v1/static',
    country: 'BG',
    boundingBox: [42.5, 23.1, 42.8, 23.6],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'hr',
    name: 'Croatia (HŽ Putnički)',
    url: 'https://www.hzpp.hr/GTFS_files.zip',
    country: 'HR',
    boundingBox: [42.3, 13.4, 46.6, 19.5],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'hu',
    name: 'Hungary (MÁV-START via MenetBrand)',
    url: 'https://gtfs.menetbrand.com/download/mav/',
    country: 'HU',
    boundingBox: [45.7, 16.1, 48.6, 22.9],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'sk',
    name: 'Slovakia (ZSR/ŽSR)',
    url: 'https://www.zsr.sk/files/pre-cestujucich/cestovny-poriadok/gtfs/gtfs.zip',
    country: 'SK',
    boundingBox: [47.7, 16.8, 49.6, 22.6],
    railRouteTypes: ALL_RAIL_AND_TRAM,
  },
  {
    id: 'fr-idf',
    name: 'France Île-de-France (Transilien)',
    url: 'https://eu.ftp.opendatasoft.com/sncf/gtfs/transilien-gtfs.zip',
    country: 'FR',
    boundingBox: [48.1, 1.4, 49.2, 3.6],
    railRouteTypes: RAIL_TYPES,
  },
  {
    id: 'au-vic',
    name: 'Australia Victoria (PTV Metro Trains)',
    url: 'https://data.ptv.vic.gov.au/downloads/gtfs.zip',
    country: 'AU',
    boundingBox: [-39.2, 140.9, -33.9, 150.0],
    railRouteTypes: RAIL_TYPES,
  },
  {
    id: 'au-qld',
    name: 'Australia Queensland (TransLink)',
    url: 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip',
    country: 'AU',
    boundingBox: [-29.2, 150.5, -26.0, 153.6],
    railRouteTypes: RAIL_TYPES,
  },
]

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
  family: 'rail' | 'tram'
  trains_passenger: number
  trains_freight: number   // GTFS rarely has freight, but keep for consistency
}

// ── GTFS parsing ──

/** Stream-parse a large CSV file line by line. Returns array of objects. */
async function parseCsvStream(filePath: string): Promise<Record<string, string>[]> {
  const results: Record<string, string>[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let headers: string[] | null = null
  for await (const rawLine of rl) {
    // Strip BOM from first line
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

/** Parse a single CSV line, handling quoted fields with commas. */
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
          i++ // skip escaped quote
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

/** Find a Wednesday within the GTFS calendar validity period. */
function findTargetWednesday(calendarRows: Record<string, string>[]): string {
  // Count how many services are active on each Wednesday in the calendar range.
  // Pick the Wednesday with the most active services (= busiest typical day).
  // This avoids stale dates when feeds span years but only recent services are active.

  // Build list of (start_date, end_date, wednesday_flag) per service
  const services: { start: string; end: string; wed: boolean }[] = []
  for (const row of calendarRows) {
    const start = row['start_date'] || ''
    const end = row['end_date'] || ''
    const wed = (row['wednesday'] || '0') === '1'
    if (start && end) services.push({ start, end, wed })
  }

  if (services.length === 0) {
    const now = new Date()
    now.setDate(now.getDate() + 7)
    while (now.getDay() !== 3) now.setDate(now.getDate() + 1)
    return now.toISOString().substring(0, 10).replace(/-/g, '')
  }

  // Find overall date range
  const allStarts = services.map(s => s.start).sort()
  const allEnds = services.map(s => s.end).sort()
  const minDate = allStarts[0]
  const maxDate = allEnds[allEnds.length - 1]

  // Sample Wednesdays across the range (weekly), count active services
  const startMs = parseGtfsDate(minDate)
  const endMs = parseGtfsDate(maxDate)
  const d = new Date(startMs)
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1)

  let bestDate = ''
  let bestCount = 0
  while (d.getTime() <= endMs) {
    const ds = d.toISOString().substring(0, 10).replace(/-/g, '')
    let count = 0
    for (const s of services) {
      if (s.wed && ds >= s.start && ds <= s.end) count++
    }
    if (count > bestCount) {
      bestCount = count
      bestDate = ds
    }
    d.setDate(d.getDate() + 7)
  }

  if (!bestDate) {
    // Fallback to midpoint
    const mid = new Date(startMs + (endMs - startMs) / 2)
    while (mid.getDay() !== 3) mid.setDate(mid.getDate() + 1)
    return mid.toISOString().substring(0, 10).replace(/-/g, '')
  }

  return bestDate
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

// ── Step 1: Download GTFS feed ──

async function downloadGtfs(feed: FeedConfig): Promise<string> {
  const feedDir = resolve(CACHE_DIR, feed.id)
  const zipPath = resolve(feedDir, 'gtfs.zip')
  const extractDir = resolve(feedDir, 'extracted')

  if (!forceDownload && existsSync(resolve(extractDir, 'stops.txt'))) {
    console.log(`  [${feed.id}] Using cached GTFS: ${extractDir}`)
    return extractDir
  }
  if (enrichOnly) {
    if (!existsSync(resolve(extractDir, 'stops.txt'))) {
      throw new Error(`--enrich-only but no cached GTFS for ${feed.id} at ${extractDir}`)
    }
    return extractDir
  }

  mkdirSync(feedDir, { recursive: true })

  console.log(`  [${feed.id}] Downloading GTFS from ${feed.url}...`)
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(600_000), // 10 min — large feeds
    headers: { 'Accept': 'application/zip, application/octet-stream, */*' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GTFS download failed for ${feed.id}: ${res.status} ${res.statusText}`)

  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(zipPath, buf)
  console.log(`  [${feed.id}] Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)

  mkdirSync(extractDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })

  // Verify essential files exist
  for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) {
    if (!existsSync(resolve(extractDir, f))) {
      throw new Error(`GTFS feed ${feed.id} missing required file: ${f}`)
    }
  }

  // Clean up ZIP to save space
  execSync(`rm -f "${zipPath}"`)

  return extractDir
}

// ── Step 2: Parse GTFS and compute stop frequencies ──

async function computeStopFrequencies(
  extractDir: string,
  feed: FeedConfig,
): Promise<StopTrainCount[]> {
  // Versioned filename: the family-aware schema added a mandatory `family` field, so a
  // pre-migration cache (family-less stops) must NOT be reused — a stale entry would lack
  // a family and break the rail↔tram grid routing. A new name forces a clean rebuild.
  const cacheFile = resolve(CACHE_DIR, feed.id, 'family-frequencies.json')
  if (!forceDownload && existsSync(cacheFile)) {
    console.log(`  [${feed.id}] Using cached stop frequencies: ${cacheFile}`)
    return JSON.parse(readFileSync(cacheFile, 'utf-8'))
  }

  console.log(`  [${feed.id}] Parsing GTFS files...`)
  const startTime = Date.now()

  // ── Parse routes.txt: route_id -> route_type ──
  console.log(`  [${feed.id}] Reading routes.txt...`)
  const routesRaw = await parseCsvStream(resolve(extractDir, 'routes.txt'))
  const routeTypeMap = new Map<string, number>()  // route_id -> route_type
  for (const r of routesRaw) {
    const routeType = parseInt(r['route_type'] || '3')
    routeTypeMap.set(r['route_id'], routeType)
  }
  console.log(`  [${feed.id}] ${routeTypeMap.size} routes, ${routesRaw.length} total`)

  // Map each route to its OSM rail family, respecting the per-feed route-type allow-list
  // (a rail-only feed yields only rail-family stops; an ALL_RAIL_AND_TRAM feed yields mixed).
  const routeFam = new Map<string, 'rail' | 'tram'>()
  for (const [routeId, routeType] of routeTypeMap) {
    if (!feed.railRouteTypes.has(routeType)) continue
    const fam = routeFamily(routeType)
    if (fam) routeFam.set(routeId, fam)
  }
  console.log(`  [${feed.id}] ${routeFam.size} rail/tram routes`)
  if (routeFam.size === 0) {
    console.log(`  [${feed.id}] WARNING: No rail routes found. Skipping.`)
    return []
  }

  // ── Parse calendar.txt: service_id -> days of week ──
  console.log(`  [${feed.id}] Reading calendar.txt...`)
  const calendarPath = resolve(extractDir, 'calendar.txt')
  const calendarDatesPath = resolve(extractDir, 'calendar_dates.txt')

  // Build set of active service IDs for a target Wednesday
  const activeServiceIds = new Set<string>()

  if (existsSync(calendarPath)) {
    const calendarRaw = await parseCsvStream(calendarPath)
    const targetDate = findTargetWednesday(calendarRaw)
    const targetDateNum = targetDate  // YYYYMMDD string
    console.log(`  [${feed.id}] Target date: ${formatDate(targetDate)} (Wednesday)`)

    for (const r of calendarRaw) {
      const start = r['start_date'] || ''
      const end = r['end_date'] || ''
      const wednesday = r['wednesday'] || '0'
      if (wednesday === '1' && targetDateNum >= start && targetDateNum <= end) {
        activeServiceIds.add(r['service_id'])
      }
    }

    // Apply calendar_dates.txt exceptions
    if (existsSync(calendarDatesPath)) {
      const calDates = await parseCsvStream(calendarDatesPath)
      for (const r of calDates) {
        if (r['date'] !== targetDateNum) continue
        if (r['exception_type'] === '1') activeServiceIds.add(r['service_id'])
        if (r['exception_type'] === '2') activeServiceIds.delete(r['service_id'])
      }
    }
  } else if (existsSync(calendarDatesPath)) {
    // Some feeds use only calendar_dates.txt (no calendar.txt)
    console.log(`  [${feed.id}] No calendar.txt, using calendar_dates.txt only`)
    const calDates = await parseCsvStream(calendarDatesPath)

    // Find a target date: pick the most common date in the file that is a Wednesday
    const dateCounts = new Map<string, number>()
    for (const r of calDates) {
      if (r['exception_type'] === '1') {
        const d = r['date'] || ''
        dateCounts.set(d, (dateCounts.get(d) || 0) + 1)
      }
    }
    // Find Wednesdays sorted by count
    const wednesdays = [...dateCounts.entries()]
      .filter(([d]) => {
        const ms = parseGtfsDate(d)
        return new Date(ms).getDay() === 3
      })
      .sort((a, b) => b[1] - a[1])

    if (wednesdays.length === 0) {
      // No Wednesdays, pick the date with most services
      const best = [...dateCounts.entries()].sort((a, b) => b[1] - a[1])
      if (best.length > 0) {
        console.log(`  [${feed.id}] No Wednesday found, using busiest date: ${formatDate(best[0][0])}`)
        for (const r of calDates) {
          if (r['date'] === best[0][0] && r['exception_type'] === '1') {
            activeServiceIds.add(r['service_id'])
          }
        }
      }
    } else {
      const targetDate = wednesdays[0][0]
      console.log(`  [${feed.id}] Target date (from calendar_dates): ${formatDate(targetDate)} (Wednesday, ${wednesdays[0][1]} services)`)
      for (const r of calDates) {
        if (r['date'] === targetDate && r['exception_type'] === '1') {
          activeServiceIds.add(r['service_id'])
        }
      }
    }
  } else {
    // No calendar at all — treat ALL trips as active
    console.log(`  [${feed.id}] WARNING: No calendar files found. Counting all trips.`)
  }

  console.log(`  [${feed.id}] ${activeServiceIds.size} active service IDs on target date`)

  // ── Parse trips.txt: trip_id -> (route_id, service_id) ──
  console.log(`  [${feed.id}] Reading trips.txt...`)
  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  // Filter to rail/tram trips running on target day, carrying their family forward
  const tripFam = new Map<string, 'rail' | 'tram'>()
  for (const r of tripsRaw) {
    const fam = routeFam.get(r['route_id'])
    if (!fam) continue
    // If we have calendar info, filter by service; otherwise count all
    if (activeServiceIds.size > 0 && !activeServiceIds.has(r['service_id'])) continue
    tripFam.set(r['trip_id'], fam)
  }
  console.log(`  [${feed.id}] ${tripFam.size} rail trips on target day (of ${tripsRaw.length} total)`)

  if (tripFam.size === 0) {
    console.log(`  [${feed.id}] WARNING: No active rail trips. Skipping.`)
    return []
  }

  // ── Parse stop_times.txt: count departures per stop for rail trips ──
  console.log(`  [${feed.id}] Reading stop_times.txt (this may take a while for large feeds)...`)
  const stopDepartures = new Map<string, { rail: number; tram: number }>() // stop_id -> per-family departure count

  // Stream stop_times.txt because it can be very large (hundreds of MB)
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
    // Fast path: extract only trip_id and stop_id without full CSV parse
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    const fam = tripFam.get(tripId)
    if (!fam) continue

    const stopId = fields[stopIdIdx]
    let counts = stopDepartures.get(stopId)
    if (!counts) { counts = { rail: 0, tram: 0 }; stopDepartures.set(stopId, counts) }
    counts[fam]++
    stMatched++

    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`  [${feed.id}]   ... ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stop-times`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  [${feed.id}] ${stLines} stop_times lines, ${stMatched} rail stop-times, ${stopDepartures.size} unique stops`)

  // ── Parse stops.txt: stop_id -> (lat, lon, name) ──
  console.log(`  [${feed.id}] Reading stops.txt...`)
  const stopsRaw = await parseCsvStream(resolve(extractDir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  let skippedNoCoords = 0
  let skippedOutOfBounds = 0

  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) { skippedNoCoords++; continue }

    // Bounding box sanity check
    const [minLat, minLon, maxLat, maxLon] = feed.boundingBox
    // Allow 1 degree margin for stops near borders
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
  console.log(`  [${feed.id}] ${stopsMap.size} stops with valid coords`)
  if (skippedOutOfBounds > 0) console.log(`  [${feed.id}] Skipped (out of bounds): ${skippedOutOfBounds}`)

  // ── Resolve parent stations ──
  // GTFS stops can reference parent_station. If a stop has departures but isn't
  // in our stops map (it's a platform), check its parent.
  // Build child -> parent mapping from stops.txt
  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const parentId = (r['parent_station'] || '').trim()
    if (parentId) {
      childToParent.set(r['stop_id'], parentId)
    }
  }

  // ── Build final stop frequency list ──
  const results: StopTrainCount[] = []
  let resolvedViaParent = 0

  for (const [stopId, counts] of stopDepartures) {
    let stop = stopsMap.get(stopId)
    if (!stop) {
      // Try parent station
      const parentId = childToParent.get(stopId)
      if (parentId) {
        stop = stopsMap.get(parentId)
        if (stop) resolvedViaParent++
      }
    }
    if (!stop) continue

    // All GTFS departures are passenger (freight isn't in GTFS). Emit one row per
    // non-zero family so rail and tram stops route to their own OSM rail_type grid.
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

  // Deduplicate: multiple stop_ids might resolve to same parent coords
  // Group by rounded lat/lon (to ~10m) + family and sum
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

  // Stats
  const paxCounts = deduped.map(s => s.trains_passenger).sort((a, b) => b - a)
  if (paxCounts.length > 0) {
    console.log(`  [${feed.id}] Train frequency: max=${paxCounts[0]}, median=${paxCounts[Math.floor(paxCounts.length / 2)]}, min=${paxCounts[paxCounts.length - 1]}`)
    // Top 5 busiest stops
    const top5 = deduped.sort((a, b) => b.trains_passenger - a.trains_passenger).slice(0, 5)
    console.log(`  [${feed.id}] Busiest stops:`)
    for (const s of top5) {
      console.log(`    ${s.trains_passenger} trains/day: ${s.name} (${s.lat.toFixed(4)}, ${s.lon.toFixed(4)})`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  [${feed.id}] GTFS parsing took ${elapsed}s`)

  // Cache results
  const cacheDir = resolve(CACHE_DIR, feed.id)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(deduped))
  console.log(`  [${feed.id}] Cached to ${cacheFile}`)

  return deduped
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

  // Multi-country continental feed has no single bbox — scan only hexes that carry
  // europe stops (class defaults reach every track within those hexes; a tram that no
  // longer inherits a heavy-rail count gets its own value). Hexes with zero europe
  // stops are left to the national/global passes.
  let totalRails = 0, totalStamped = 0, gtfsHits = 0, skippedService = 0, hexesUpdated = 0, hexesScanned = 0
  const startTime = Date.now()

  for (const hexId of stopsByHex.keys()) {
    const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
    if (!existsSync(railPath)) continue
    hexesScanned++

    // Build this hex's two family grids once (0.01° ≈ 1 km cells).
    const railGrid = new Map<string, StopTrainCount[]>()
    const tramGrid = new Map<string, StopTrainCount[]>()
    for (const sc of stopsByHex.get(hexId)!) {
      const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
      const grid = sc.family === 'rail' ? railGrid : tramGrid
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key)!.push(sc)
    }

    let matchWasGtfs = false
    const r = await writeRailTrains(
      railPath,
      (row) => {
        matchWasGtfs = false
        // Family gate: heavy rail (rail_type 0) → rail stops; tram/light_rail
        // (rail_type 1/2) → tram/metro stops. Cross-family matches can't happen.
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

    const elapsed = Date.now() - startTime
    if (elapsed > 0 && hexesScanned % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hexesScanned} hexes, ${hexesUpdated} updated, ${totalStamped.toLocaleString()} stamped (${gtfsHits.toLocaleString()} via GTFS)`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Railway segments scanned:  ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by GTFS:           ${gtfsHits.toLocaleString()}`)
  console.log(`  Stamped (incl. defaults):  ${totalStamped.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexesScanned}`)
}

// ── Main ──

async function main() {
  console.log(`=== Global Railway GTFS Enrichment ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}`)
  console.log(`  Year: ${YEAR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Select feeds to process
  const feeds = requestedFeeds
    ? FEEDS.filter(f => requestedFeeds.includes(f.id))
    : FEEDS

  if (feeds.length === 0) {
    console.error(`ERROR: No matching feeds. Available: ${FEEDS.map(f => f.id).join(', ')}`)
    process.exit(1)
  }

  console.log(`  Processing ${feeds.length} feed(s): ${feeds.map(f => `${f.id} (${f.name})`).join(', ')}\n`)

  // Collect all stop counts across feeds
  const allStopCounts: StopTrainCount[] = []
  const feedResults: { id: string; stops: number; failed?: string }[] = []

  for (const feed of feeds) {
    console.log(`\n--- Feed: ${feed.name} (${feed.id}) ---`)
    try {
      const extractDir = await downloadGtfs(feed)
      const stops = await computeStopFrequencies(extractDir, feed)
      allStopCounts.push(...stops)
      feedResults.push({ id: feed.id, stops: stops.length })
    } catch (err: any) {
      console.error(`  [${feed.id}] FAILED: ${err.message}`)
      feedResults.push({ id: feed.id, stops: 0, failed: err.message })
    }
  }

  console.log(`\n\n--- Feed Summary ---`)
  for (const r of feedResults) {
    if (r.failed) {
      console.log(`  ${r.id}: FAILED — ${r.failed}`)
    } else {
      console.log(`  ${r.id}: ${r.stops} stops with frequencies`)
    }
  }

  if (allStopCounts.length === 0) {
    console.log(`\nNo GTFS data to enrich. Exiting.`)
    return
  }

  console.log(`\n\n--- Enriching railways.arrow ---`)
  console.log(`  Total GTFS stops: ${allStopCounts.length}`)
  await enrichHexes(allStopCounts)

  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
