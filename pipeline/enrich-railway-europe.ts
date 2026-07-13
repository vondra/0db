/**
 * Enrich railways.arrow with real train frequencies from GTFS feeds.
 *
 * Downloads GTFS feeds (starting with Germany / GTFS.DE), parses
 * stop_times + trips + routes + calendar to count trains per day per
 * stop, then matches GTFS stops to OSM railway segments by proximity
 * and writes trains_passenger / trains_freight columns.
 *
 * WHY: Most railways.arrow segments have trains_passenger=0 and
 * trains_freight=0, so the engine falls back to default_traffic(rail_type,
 * usage). GTFS feeds provide actual train frequencies for passenger services;
 * segments the feeds don't reach STAY at source_id=0 on purpose (engine
 * defaults own unknowns — no class-default stamping under this source id).
 *
 * #26C country-bleed gate: deliberately NOT wired here. This aggregate is
 * multi-country by design — many national feeds share one source id
 * (SOURCE_ID_GLOBAL_GTFS_TRANSIT), so a single makeCountryGate cannot say which
 * country a stop or an owned row belongs to; a blanket gate would either drop
 * nothing or disown every row outside one arbitrary country. Wiring it needs a
 * per-feed ownership design first (gate each feed's stops by its own `country`
 * field, and define who may retract shared-id rows). Single-country template:
 * enrich-railway-pl.ts (7fac2349).
 *
 * Usage:
 *   npx tsx enrich-railway-europe.ts
 *   npx tsx enrich-railway-europe.ts --force-download
 *   npx tsx enrich-railway-europe.ts --enrich-only
 *   npx tsx enrich-railway-europe.ts --feed=de          # Germany only
 *   npx tsx enrich-railway-europe.ts --feed=de,ch,at    # Multiple feeds
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { SOURCE_ID_GLOBAL_GTFS_TRANSIT } from './lib/source-ids.generated.js'
import { writeRailTrains, type RailRow } from './lib/railways-arrow.js'
import {
  RAIL_TYPES, TRAM_TYPES, METRO_TYPES, routeFamily, nearestGridStop,
  parseGtfsDate, formatDate, logRetractSkippedIncompleteInputs, type GtfsStop,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_GLOBAL_GTFS_TRANSIT

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
  // Map this feed's METRO_TYPES routes to the 'rail' family (heavy rail) instead
  // of the default 'tram'/light_rail. Set where the operator tags heavy suburban
  // rail as GTFS "metro" (400-405) but OSM carries it as railway=rail — Melbourne
  // Metro Trains (au-vic feed 2, 35 route_type-400 routes) are the reference case.
  metroAsRail?: boolean
}

// RAIL_TYPES/TRAM_TYPES/METRO_TYPES + routeFamily are hoisted to lib/gtfs-enrich-core.ts.
// Per-feed allow-list value: feeds with surface trams/light-rail/metro use this, rail-only feeds use
// RAIL_TYPES. METRO_TYPES is included so metro routes survive the per-feed filter and routeFamily can
// map them to the 'tram' family (they enrich OSM light_rail, rail_type 2) — without it, metro-bearing
// feeds (e.g. Sofia) would fall back to class defaults instead of real frequencies.
const ALL_RAIL_AND_TRAM = new Set([...RAIL_TYPES, ...TRAM_TYPES, ...METRO_TYPES])

/** The OSM rail family a route of this type maps to FOR THIS FEED, or null if the
 *  feed doesn't count that type. Gates on the feed's allow-list first, then
 *  overrides metro→'rail' for feeds that carry heavy suburban rail under GTFS
 *  metro types (metroAsRail), else defers to the global routeFamily. */
export function railFamilyFor(routeType: number, feed: FeedConfig): 'rail' | 'tram' | null {
  if (!feed.railRouteTypes.has(routeType)) return null
  if (feed.metroAsRail && METRO_TYPES.has(routeType)) return 'rail'
  return routeFamily(routeType)
}

export const FEEDS: FeedConfig[] = [
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
    // Fintraffic/Digitraffic; requires Accept-Encoding: gzip (handled in downloadFeed).
    // Old public-transport.earth/gtfs/fi went dead 2026-06.
    url: 'https://rata.digitraffic.fi/api/v1/trains/gtfs-all.zip',
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
    // NKOD national open-data portal (distribution of dataset ebeeedf1-…).
    // Old zsr.sk direct .zip went dead 2026-06 (returns an HTML page).
    url: 'https://data.slovensko.sk/download?id=f63ef0f2-c4e7-496b-bdd1-44ba0e9438e9',
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
    // PTV publishes ONE gtfs.zip that unzips into mode-split subfeeds
    // (1=V/Line regional rail, 2=Metro Trains, 3=Yarra Trams, 4-6/10-11=bus,
    // 10=interstate rail) each as its own <N>/google_transit.zip. downloadGtfs
    // extracts + processes the rail-bearing subfeeds; RAIL∪METRO keeps V/Line
    // (type 2) AND Metro Trains (type 400) — with metroAsRail the metro maps to
    // heavy rail (OSM railway=rail), not light_rail. Trams (type 0) stay out.
    name: 'Australia Victoria (PTV V/Line + Metro Trains)',
    url: 'https://data.ptv.vic.gov.au/downloads/gtfs.zip',
    country: 'AU',
    boundingBox: [-39.2, 140.9, -33.9, 150.0],
    railRouteTypes: new Set([...RAIL_TYPES, ...METRO_TYPES]),
    metroAsRail: true,
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

// ── Types (GtfsStop hoisted to lib/gtfs-enrich-core.ts) ──

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

/** Sum departures of stops at the same rounded location (~11m) + family into one
 *  row. Merges platforms of one station AND the same physical stop appearing in
 *  several subfeeds of a nested feed (au-vic Southern Cross carries V/Line + the
 *  interstate service under one stop_id in feeds 1 and 10 — /gg Codex confirmed
 *  they would otherwise not sum, since the downstream picks the single nearest
 *  stop per segment, not their total). Distinct platforms keep distinct coords,
 *  so cross-track counts are NOT over-summed. */
export function dedupeStopsByLocation(stops: StopTrainCount[]): StopTrainCount[] {
  const byLoc = new Map<string, StopTrainCount>()
  for (const sc of stops) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
    const existing = byLoc.get(key)
    if (existing) existing.trains_passenger += sc.trains_passenger
    else byLoc.set(key, { ...sc })
  }
  return [...byLoc.values()]
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

// ── Step 1: Download GTFS feed ──

const REQUIRED_GTFS_FILES = ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt'] as const

/** A PTV-style feed ships ONE outer gtfs.zip that unzips into numbered subfeeds,
 *  each its own <N>/google_transit.zip (mode-split: rail / tram / bus). Return
 *  the subfeed zips present directly under dir (empty for the normal flat
 *  layout). */
export function findInnerGtfsZips(dir: string): { label: string; zip: string }[] {
  if (!existsSync(dir)) return []
  const out: { label: string; zip: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const zip = resolve(dir, entry.name, 'google_transit.zip')
    if (existsSync(zip)) out.push({ label: entry.name, zip })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** Cheap peek: does this subfeed carry ≥1 route of a type this feed counts as
 *  rail? Reads only routes.txt (unzip -p, no full unpack) so a pure-bus subfeed
 *  is skipped before its large stop_times is ever extracted. Uses the SAME
 *  feed.railRouteTypes set as the parse filter — never a divergent copy. */
export function innerFeedHasRail(zipPath: string, feed: FeedConfig): boolean {
  let txt: string
  try {
    txt = execSync(`unzip -p "${zipPath}" routes.txt`, { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 }).toString('utf-8')
  } catch {
    return false
  }
  const lines = txt.split('\n')
  if (lines.length < 2) return false
  const ti = parseCsvLine(lines[0].replace(/^\uFEFF/, '')).indexOf('route_type')
  if (ti < 0) return false
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const rt = parseInt(parseCsvLine(lines[i])[ti] || '', 10)
    if (Number.isFinite(rt) && feed.railRouteTypes.has(rt)) return true
  }
  return false
}

/** Extract the rail-bearing subfeeds of a nested PTV-style feed into
 *  <parent>/<N>/extracted/ (reused if present) and return those dirs.
 *  computeStopFrequencies then runs once per subfeed and the caller concatenates
 *  — NO cross-feed GTFS merge (each subfeed keeps its own id space; stops at a
 *  shared location sum downstream by coordinate). */
function extractNestedRailFeeds(feed: FeedConfig, inner: { label: string; zip: string }[]): string[] {
  const dirs: string[] = []
  for (const { label, zip } of inner) {
    const dest = resolve(zip, '..', 'extracted')
    if (existsSync(resolve(dest, 'stops.txt'))) { dirs.push(dest); continue }
    if (!innerFeedHasRail(zip, feed)) {
      console.log(`  [${feed.id}] subfeed ${label}: no rail routes — skipping`)
      continue
    }
    mkdirSync(dest, { recursive: true })
    execSync(`unzip -o -q "${zip}" -d "${dest}"`, { timeout: 120_000 })
    for (const f of REQUIRED_GTFS_FILES) {
      if (!existsSync(resolve(dest, f))) throw new Error(`GTFS feed ${feed.id} subfeed ${label} missing required file: ${f}`)
    }
    console.log(`  [${feed.id}] subfeed ${label}: extracted rail GTFS → ${dest}`)
    dirs.push(dest)
  }
  return dirs
}

/** Resolve a feed to one or more flat GTFS extract dirs. A normal feed yields
 *  [dir]; a nested PTV-style feed yields one dir per rail-bearing subfeed. */
export async function downloadGtfs(feed: FeedConfig): Promise<string[]> {
  const feedDir = resolve(CACHE_DIR, feed.id)
  const zipPath = resolve(feedDir, 'gtfs.zip')
  const extractDir = resolve(feedDir, 'extracted')

  // Nested PTV-style layout (au-vic): the outer gtfs.zip has unzipped into
  // <N>/google_transit.zip subfeeds — process the rail-bearing ones. Checked
  // FIRST because such a feed has no flat stops.txt of its own. The staged
  // cache unzips in place (feedDir/<N>/), a fresh download into extractDir/<N>/
  // — look in both so a re-run after a fresh download still finds the subfeeds
  // (/gg Gemini).
  const inner = findInnerGtfsZips(feedDir)
  const nested = inner.length > 0 ? inner : findInnerGtfsZips(extractDir)
  if (nested.length > 0) return extractNestedRailFeeds(feed, nested)

  // #31.6: the staged cache uses a FLAT layout (stops.txt beside gtfs.zip,
  // extracted in place) — accept it, or --enrich-only silently no-ops on all
  // 23 staged feeds while hunting <id>/extracted/ (every throw below is
  // caught per-feed and a 0-feed run exits 0).
  if (!forceDownload && existsSync(resolve(feedDir, 'stops.txt'))) {
    console.log(`  [${feed.id}] Using cached GTFS (flat layout): ${feedDir}`)
    return [feedDir]
  }

  if (!forceDownload && existsSync(resolve(extractDir, 'stops.txt'))) {
    console.log(`  [${feed.id}] Using cached GTFS: ${extractDir}`)
    return [extractDir]
  }
  if (enrichOnly) {
    if (!existsSync(resolve(extractDir, 'stops.txt'))) {
      throw new Error(`--enrich-only but no cached GTFS for ${feed.id} at ${extractDir}`)
    }
    return [extractDir]
  }

  mkdirSync(feedDir, { recursive: true })

  console.log(`  [${feed.id}] Downloading GTFS from ${feed.url}...`)
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(600_000), // 10 min — large feeds
    // Digitraffic (fi) returns HTTP 406 without Accept-Encoding: gzip; harmless elsewhere.
    headers: { 'Accept': 'application/zip, application/octet-stream, */*', 'Accept-Encoding': 'gzip' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GTFS download failed for ${feed.id}: ${res.status} ${res.statusText}`)

  let buf = Buffer.from(await res.arrayBuffer())
  // GTFS zips start with 'PK'. If a server handed back a gzip stream (magic 1f 8b)
  // that undici didn't auto-inflate (Digitraffic fi), inflate to recover the .zip.
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf)
  writeFileSync(zipPath, buf)
  console.log(`  [${feed.id}] Downloaded: ${(buf.length / 1e6).toFixed(1)} MB`)

  mkdirSync(extractDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { timeout: 120_000 })
  execSync(`rm -f "${zipPath}"`) // reclaim space before returning either way

  // Flat GTFS (the common case)?
  if (existsSync(resolve(extractDir, 'stops.txt'))) {
    for (const f of REQUIRED_GTFS_FILES) {
      if (!existsSync(resolve(extractDir, f))) throw new Error(`GTFS feed ${feed.id} missing required file: ${f}`)
    }
    return [extractDir]
  }
  // A nested outer zip unzips to <N>/google_transit.zip subfeeds instead.
  const freshInner = findInnerGtfsZips(extractDir)
  if (freshInner.length > 0) return extractNestedRailFeeds(feed, freshInner)
  throw new Error(`GTFS feed ${feed.id}: unzip produced neither flat stops.txt nor <N>/google_transit.zip subfeeds`)
}

// ── Step 2: Parse GTFS and compute stop frequencies ──

export async function computeStopFrequencies(
  extractDir: string,
  feed: FeedConfig,
): Promise<StopTrainCount[]> {
  // Versioned filename: the family-aware schema added a mandatory `family` field, so a
  // pre-migration cache (family-less stops) must NOT be reused — a stale entry would lack
  // a family and break the rail↔tram grid routing. A new name forces a clean rebuild.
  // Keyed by extractDir (NOT feed.id): a nested feed processes several subfeeds through
  // this function under one feed.id, so a feed.id key would make the subfeeds overwrite
  // each other's cache and double-count on the next run. A STAGED flat feed returns
  // [feedDir] (extractDir==feedDir) so its cache path is unchanged; a freshly downloaded
  // flat feed (extractDir==feedDir/extracted) just gets a harmless one-time rebuild.
  const cacheFile = resolve(extractDir, 'family-frequencies.json')
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
    const fam = railFamilyFor(routeType, feed)
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

  // Multiple stop_ids (platforms) can resolve to the same parent coords — sum them.
  const deduped = dedupeStopsByLocation(results)

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

  // Cache results (cacheFile is under extractDir, which already exists)
  writeFileSync(cacheFile, JSON.stringify(deduped))
  console.log(`  [${feed.id}] Cached to ${cacheFile}`)

  return deduped
}

// ── Step 3: Match stops to railway segments and write Arrow ──

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: the deleted
// class-default table, verbatim. A row still owned by MY_SOURCE_ID whose counts exactly
// equal its class tuple was filled by that fallback, not measured — exact-tuple + family
// ambiguity is negligible (/tmp/quietmap-v4/gtfs-rail-misjoin.md §3), and the retract's
// `when` additionally re-runs today's stop join, so a live-covered row is re-stamped by
// `match`, never disowned. No-match rows now return null: source_id stays 0 and the
// ENGINE default table (engine/noise-compute/src/emission/railway.rs::default_traffic)
// owns the "we don't know" case. DELETE this retract (and OLD_FALLBACK) after the world
// rail repaint confirms 0 retractions.
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
  // Group stops by H3R4 hex
  const stopsByHex = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    if (!stopsByHex.has(sc.h3r4)) stopsByHex.set(sc.h3r4, [])
    stopsByHex.get(sc.h3r4)!.push(sc)
  }
  console.log(`  Stops span ${stopsByHex.size} H3R4 hexes`)

  // Multi-country continental feed has no single bbox — the ENRICH pass scans only
  // hexes that carry europe stops; hexes with zero europe stops are left to the
  // national/global passes. The OLD_FALLBACK heal is NOT bounded by that: the
  // retract-only sweep below (CRITICAL-2) visits every remaining railways.arrow hex,
  // so a hex whose stop coverage vanished since the legacy stamp is healed too.
  let totalRails = 0, totalStamped = 0, totalRetracted = 0, skippedService = 0, hexesUpdated = 0, hexesScanned = 0
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

    const r = await writeRailTrains(
      railPath,
      (row) => {
        // Family gate: heavy rail (rail_type 0) → rail stops; tram/light_rail
        // (rail_type 1/2) → tram/metro stops. Cross-family matches can't happen.
        const grid = row.railType === 0 ? railGrid : (row.railType === 1 || row.railType === 2) ? tramGrid : null
        const bestStop = grid ? nearestGridStop(grid, row) : null
        if (bestStop) {
          return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
        }
        // No GTFS match (or unhandled rail_type): return null — the row stays/goes
        // source_id=0 and the ENGINE default table (emission/railway.rs::default_traffic)
        // owns the unknown. Never stamp a guess under MY_SOURCE_ID.
        return null
      },
      undefined,
      // CRITICAL-1b: retract only over a provably complete snapshot (retractSafe) —
      // with a --feed subset or a failed/empty feed, "no stop covers this row" is
      // an input artifact, not evidence, and would disown REAL stamps.
      retractSafe ? {
        sourceId: MY_SOURCE_ID,
        // Disown a legacy pre-2026-07-10 class-default stamp ONLY when today's join no
        // longer reaches the row (same family routing + 500 m grid join as `match`) —
        // a row a live stop still covers is re-stamped with the real count instead.
        when: (row) => {
          if (!wasOldFallbackStamp(row)) return false
          const grid = row.railType === 0 ? railGrid : (row.railType === 1 || row.railType === 2) ? tramGrid : null
          return !grid || nearestGridStop(grid, row) === null
        },
      } : undefined,
    )
    totalRails += r.rows
    totalStamped += r.matched
    totalRetracted += r.retracted
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    const elapsed = Date.now() - startTime
    if (elapsed > 0 && hexesScanned % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hexesScanned} hexes, ${hexesUpdated} updated, ${totalStamped.toLocaleString()} GTFS-stamped, ${totalRetracted.toLocaleString()} retracted`)
    }
  }

  // CRITICAL-2 (/gg Codex): stale OLD_FALLBACK stamps hide precisely in hexes with
  // ZERO stops today (their stop coverage vanished since the legacy stamp), which the
  // enrich pass above never visits. Sweep every OTHER railways.arrow hex with a
  // retract-only pass — match is `() => null` (the sweep never stamps), and with a
  // provably complete snapshot (retractSafe gate) "zero stops in this hex" is a true
  // negative, so the join corroboration is vacuous and the exact tuple fingerprint
  // alone identifies a legacy stamp. Full readdir enumeration of H3R4_DIR (~9 s);
  // hexes already visited above are skipped — their retract ran WITH the stop join.
  let sweepScanned = 0, sweepUpdated = 0, sweepRetracted = 0
  if (retractSafe) {
    const sweepStart = Date.now()
    const allHexDirs = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
    console.log(`\n  Retract-only sweep: ${allHexDirs.length} hex dirs enumerated, ${stopsByHex.size} stop-bearing already visited`)
    for (const hexId of allHexDirs) {
      if (stopsByHex.has(hexId)) continue
      const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
      if (!existsSync(railPath)) continue
      sweepScanned++
      const r = await writeRailTrains(railPath, () => null, undefined, {
        sourceId: MY_SOURCE_ID,
        when: wasOldFallbackStamp,
      })
      sweepRetracted += r.retracted
      if (r.updated) sweepUpdated++
      if (sweepScanned % 2000 === 0) {
        console.log(`  [sweep ${((Date.now() - sweepStart) / 1000).toFixed(0)}s] ${sweepScanned} stopless hexes, ${sweepUpdated} updated, ${sweepRetracted.toLocaleString()} retracted`)
      }
    }
    console.log(`  Retract-only sweep done in ${((Date.now() - sweepStart) / 1000).toFixed(0)}s`)
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Railway segments scanned:  ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by GTFS:           ${totalStamped.toLocaleString()}`)
  console.log(`  Retracted legacy defaults: ${totalRetracted.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexesScanned}`)
  if (retractSafe) {
    console.log(`  Retract sweep (stopless hexes): ${sweepRetracted.toLocaleString()} retracted, ${sweepUpdated}/${sweepScanned} hexes updated`)
  }
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
      // A feed resolves to ≥1 flat GTFS dir (one for a normal feed, one per
      // rail-bearing subfeed for a nested PTV feed) — concat their stop counts,
      // then re-dedupe by location so a station shared across subfeeds (au-vic
      // Southern Cross: V/Line feed 1 + interstate feed 10) sums instead of the
      // downstream nearest-stop pick keeping only one. No-op for a single dir.
      const extractDirs = await downloadGtfs(feed)
      let stops: StopTrainCount[] = []
      for (const dir of extractDirs) stops = stops.concat(await computeStopFrequencies(dir, feed))
      if (extractDirs.length > 1) stops = dedupeStopsByLocation(stops)
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

  const failedFeedIds = feedResults.filter(r => r.failed).map(r => r.id)
  const emptyFeedIds = feedResults.filter(r => !r.failed && r.stops === 0).map(r => r.id)

  // #31.6 completeness marker → chain status.json + the completeness floor.
  // `actual` = feeds that loaded non-empty; a subset --feed run reports against
  // its own count (never claims the full 23). A full run short of FEEDS.length
  // is `partial`. au-vic (nested PTV zip-of-zips) is now handled per-subfeed by
  // downloadGtfs (V/Line + Metro Trains → rail), so a full staged run reaches
  // 23/23; a subfeed that fails to extract still drops au-vic to non-empty-only
  // honestly rather than stamping a partial as done.
  {
    const loaded = feedResults.filter((r) => !r.failed && r.stops > 0).length
    const denom = requestedFeeds ? feeds.length : FEEDS.length
    const state = loaded >= denom ? 'complete' : loaded === 0 ? 'missing' : 'partial'
    const detail = `${loaded}/${denom} feeds loaded${failedFeedIds.length ? `; failed: ${failedFeedIds.join(',')}` : ''}${emptyFeedIds.length ? `; empty: ${emptyFeedIds.join(',')}` : ''}`
    console.log(`QM_COMPLETENESS ${JSON.stringify({ actual: loaded, state, detail })}`)
  }

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot — every configured feed loaded non-empty, no --feed subset. Otherwise
  // the retract's join corroboration reads "no coverage" where the input simply was
  // not loaded and disowns REAL stamps. Enrichment (stamping) stays allowed on a
  // partial snapshot — only the retract is gated.
  const retractSafe = requestedFeeds === null && failedFeedIds.length === 0 && emptyFeedIds.length === 0
  if (!retractSafe) {
    const detail = [
      requestedFeeds !== null ? `--feed subset run: ${requestedFeeds.join(',')}` : '',
      failedFeedIds.length > 0 ? `failed feeds: ${failedFeedIds.join(',')}` : '',
      emptyFeedIds.length > 0 ? `feeds parsed empty: ${emptyFeedIds.join(',')}` : '',
    ].filter(Boolean).join('; ')
    logRetractSkippedIncompleteInputs(detail)
  }

  if (allStopCounts.length === 0) {
    console.log(`\nNo GTFS data to enrich. Exiting.`)
    return
  }

  console.log(`\n\n--- Enriching railways.arrow ---`)
  console.log(`  Total GTFS stops: ${allStopCounts.length}`)
  await enrichHexes(allStopCounts, retractSafe)

  console.log(`\n=== Done ===`)
}

// Import-safe: run only when invoked directly — importing this file must never
// trigger a download/enrichment pass (pattern from enrich-roads-cz.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error('Error:', err); process.exit(1) })
}
