/**
 * Enrich CZ railways.arrow with real train counts from CZPTT timetable.
 *
 * Downloads JR2026.zip (national timetable, 13k+ train XMLs), parses train
 * paths, counts trains per station-pair segment per day, matches to OSM
 * railway segments via station coordinates, writes trains_passenger +
 * trains_freight columns to railways.arrow.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-cz.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-cz.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-cz.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_CZ_SZCD_GTFS, SOURCE_ID_RAIL_TIMETABLE_SILENT } from './lib/source-ids.generated.js'
import { flatDist, pointToSegmentDist } from './lib/spatial.js'
import { logRetractSkippedIncompleteInputs } from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_CZ_SZCD_GTFS

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cz`)
const CACHE_TRAINS = resolve(CACHE_DIR, 'czptt-segment-counts.json')
const CACHE_STATIONS = resolve(CACHE_DIR, 'osm-stations.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const CZPTT_URL = 'https://portal.cisjr.cz/pub/draha/celostatni/szdc/2026/JR2026.zip'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// Target date for counting trains (Wednesday = typical weekday)
// JR2026 validity: varies per train (some Dec 2025, some Mar 2026).
// Pick a Wednesday well inside validity: April 2026.
const TARGET_DATE = '2026-04-08'

// ── Types ──

interface SegmentCount {
  from_code: string
  from_name: string
  to_code: string
  to_name: string
  passenger: number  // Os, Sp, R, IC, EC, rj, RJ, LE, SC, EN etc
  freight: number    // Nex, Pn, Mn etc
}

interface StationGPS {
  name: string
  lat: number
  lon: number
}

// ── Step 1: Download + parse CZPTT ──

async function getTrainCounts(): Promise<Map<string, SegmentCount>> {
  if (!forceDownload && existsSync(CACHE_TRAINS)) {
    console.log(`  Using cached train counts: ${CACHE_TRAINS}`)
    const data = JSON.parse(readFileSync(CACHE_TRAINS, 'utf-8'))
    return new Map(Object.entries(data))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_TRAINS)) { console.error('ERROR: --enrich-only but no cache'); process.exit(1) }
    const data = JSON.parse(readFileSync(CACHE_TRAINS, 'utf-8'))
    return new Map(Object.entries(data))
  }

  console.log('  Downloading CZPTT timetable...')
  const zipPath = resolve(CACHE_DIR, 'JR2026.zip')
  const xmlDir = resolve(CACHE_DIR, 'czptt-xml')
  mkdirSync(CACHE_DIR, { recursive: true })

  if (!existsSync(zipPath) || forceDownload) {
    const res = await fetch(CZPTT_URL, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) throw new Error(`CZPTT download error: ${res.status}`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    console.log(`  Downloaded ${(readFileSync(zipPath).length / 1e6).toFixed(1)} MB`)
  }

  console.log('  Extracting XMLs...')
  mkdirSync(xmlDir, { recursive: true })
  execSync(`unzip -o -q "${zipPath}" -d "${xmlDir}"`, { timeout: 120000 })
  const xmlFiles = readdirSync(xmlDir).filter(f => f.endsWith('.xml'))
  console.log(`  ${xmlFiles.length} train definitions`)

  // Parse target date
  const targetMs = new Date(TARGET_DATE).getTime()
  const segments = new Map<string, SegmentCount>()
  let trainsRunning = 0

  // NOTE: CIS JR JR2026.zip contains ONLY passenger trains (all files are PA_ prefix).
  // Freight trains are NOT published in this dataset. Verified 2026-04-10:
  //   - All 13,252 XML files have ObjectType=PA (passenger)
  //   - OperationalTrainNumber is always digits-only (no Nex/Pn/Mn letter prefixes)
  //   - TrafficType values are only "11", "C1"-"C4" (all passenger codes per UIC)
  // Freight timetables are managed by SŽ but not publicly published as machine-readable.
  // All trains from this source are counted as passenger; trains_freight remains 0.
  let passengerTrains = 0
  let freightTrains = 0
  let unknownTrains = 0

  for (const file of xmlFiles) {
    const xml = readFileSync(resolve(xmlDir, file), 'utf-8')

    // Check if train runs on target date via PlannedCalendar
    const bitmapMatch = xml.match(/<BitmapDays>([^<]+)</)
    const startMatch = xml.match(/<PlannedCalendar>[\s\S]*?<StartDateTime>([^<]+)</)
    const endMatch = xml.match(/<PlannedCalendar>[\s\S]*?<EndDateTime>([^<]+)</)
    if (!bitmapMatch || !startMatch || !endMatch) continue

    const startDate = new Date(startMatch[1].substring(0, 10))
    const endDate = new Date(endMatch[1].substring(0, 10))
    const bitmap = bitmapMatch[1]

    if (targetMs < startDate.getTime() || targetMs > endDate.getTime()) continue
    const dayOffset = Math.floor((targetMs - startDate.getTime()) / 86400000)
    if (dayOffset >= bitmap.length || bitmap[dayOffset] !== '1') continue

    trainsRunning++

    // Detect train type. JR2026 is passenger-only in practice, but check ObjectType
    // for forward-compatibility if SŽ ever publishes freight data.
    const objTypeMatch = xml.match(/<ObjectType>([^<]+)</)
    const objType = objTypeMatch?.[1] || ''
    // PA = Passenger, NA = Freight (if ever published), TR = Train Run reference
    const isFreight = objType === 'NA'
    if (isFreight) freightTrains++
    else if (objType === 'PA') passengerTrains++
    else unknownTrains++

    // Extract station sequence
    const locRegex = /<LocationPrimaryCode>(\d+)<\/LocationPrimaryCode>\s*<PrimaryLocationName>([^<]+)</g
    const stations: { code: string; name: string }[] = []
    let m
    while ((m = locRegex.exec(xml)) !== null) {
      // Deduplicate consecutive same station (multiple platform entries)
      const code = m[1]
      if (stations.length === 0 || stations[stations.length - 1].code !== code) {
        stations.push({ code, name: m[2] })
      }
    }

    // Count trains per adjacent station pair
    for (let i = 0; i < stations.length - 1; i++) {
      const key = `${stations[i].code}-${stations[i + 1].code}`
      if (!segments.has(key)) {
        segments.set(key, {
          from_code: stations[i].code,
          from_name: stations[i].name,
          to_code: stations[i + 1].code,
          to_name: stations[i + 1].name,
          passenger: 0,
          freight: 0,
        })
      }
      const seg = segments.get(key)!
      if (isFreight) seg.freight++
      else seg.passenger++
    }
  }

  console.log(`  ${trainsRunning} trains running on ${TARGET_DATE}`)
  console.log(`    passenger (PA): ${passengerTrains}, freight (NA): ${freightTrains}, other: ${unknownTrains}`)
  console.log(`  ${segments.size} station-pair segments`)
  if (freightTrains === 0) {
    console.log(`  NOTE: JR2026.zip is passenger-only. Freight data not available from this source.`)
  }

  // Cache — never persist an empty parse: a poisoned cache would feed every later
  // --enrich-only run an empty snapshot (the .broken fossils in CACHE_DIR are
  // exactly that failure), silently starving matching AND the retract evidence.
  if (segments.size > 0) {
    const obj: Record<string, SegmentCount> = {}
    for (const [k, v] of segments) obj[k] = v
    writeFileSync(CACHE_TRAINS, JSON.stringify(obj))
  } else {
    console.log(`  NOT caching empty CZPTT parse (${xmlFiles.length} XMLs yielded 0 segments)`)
  }

  // Cleanup XMLs to save space
  execSync(`rm -rf "${xmlDir}"`)

  return segments
}

// ── Step 2: Get station GPS from OSM ──

async function getStationGPS(): Promise<Map<string, StationGPS>> {
  if (!forceDownload && existsSync(CACHE_STATIONS)) {
    const data = JSON.parse(readFileSync(CACHE_STATIONS, 'utf-8'))
    return new Map(Object.entries(data))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_STATIONS)) { console.error('ERROR: --enrich-only but no station cache'); process.exit(1) }
    const data = JSON.parse(readFileSync(CACHE_STATIONS, 'utf-8'))
    return new Map(Object.entries(data))
  }

  console.log('  Downloading station coordinates from OSM...')
  const query = `[out:json];area["ISO3166-1"="CZ"]->.cz;(node["railway"="station"](area.cz);node["railway"="halt"](area.cz););out;`
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  let lines: { lat: number; lon: number; tags?: { name?: string } }[]
  try {
    const json = JSON.parse(text)
    lines = json.elements.filter((e: any) => e.tags?.name)
  } catch {
    // Overpass may be overloaded, try CSV fallback via bbox
    console.log('  Overpass JSON failed, trying bbox query...')
    const res2 = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent('[out:json];(node["railway"="station"](48.5,12.0,51.1,18.9);node["railway"="halt"](48.5,12.0,51.1,18.9););out;'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(120000),
    })
    const json2 = await res2.json() as any
    lines = json2.elements.filter((e: any) => e.tags?.name)
  }

  const stations = new Map<string, StationGPS>()
  for (const el of lines) {
    const name = el.tags!.name!
    stations.set(name, { name, lat: el.lat, lon: el.lon })
  }
  console.log(`  ${stations.size} OSM stations with GPS`)

  // Never persist an empty station set — an Overpass overload can return a valid
  // 200 with zero elements, and a poisoned cache starves every later run.
  if (stations.size > 0) {
    const obj: Record<string, StationGPS> = {}
    for (const [k, v] of stations) obj[k] = v
    writeFileSync(CACHE_STATIONS, JSON.stringify(obj))
  } else {
    console.log('  NOT caching empty OSM station response')
  }

  return stations
}

// ── Step 3: Match CZPTT station-pairs to OSM railway segments ──

/** Distance from point P to line segment A→B in meters (flat-earth). */
/** Normalize station name for fuzzy matching */
function normName(s: string): string {
  return s.toLowerCase()
    .replace(/[- ]/g, '')
    .replace(/pha\s*hl\.?n\.?/i, 'prahahlavn')
    .replace(/hl\.?n\.?/i, 'hlavní nádraží')
    .replace(/[áà]/g, 'a').replace(/[éè]/g, 'e').replace(/[íì]/g, 'i')
    .replace(/[óò]/g, 'o').replace(/[úùů]/g, 'u').replace(/ý/g, 'y')
    .replace(/č/g, 'c').replace(/ď/g, 'd').replace(/ň/g, 'n')
    .replace(/ř/g, 'r').replace(/š/g, 's').replace(/ť/g, 't').replace(/ž/g, 'z')
    .replace(/ě/g, 'e')
}

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: the deleted
// class-default table, verbatim. Trať 162 was the proof case — 4,244 CZ branch ways
// (59% of src=110 branch ways) carried the literal 80/0 stamped as Správa železnic
// timetable data (/tmp/quietmap-v4/gtfs-rail-misjoin.md). A row still owned by
// MY_SOURCE_ID whose counts exactly equal its class tuple was filled by that fallback,
// not measured — exact-tuple + usage ambiguity is negligible (CZPTT real matches are
// passenger-only and non-round: 65/66/71/72, never exactly 80), and for heavy rail the
// retract re-runs today's CZPTT join, so a live-covered row is re-stamped with the real
// count, never disowned. No-match rows now stay source_id=0: the ENGINE default table
// (engine/noise-compute/src/emission/railway.rs::default_traffic) owns the "we don't
// know" case. DELETE this retract (and OLD_FALLBACK) after the world rail repaint
// confirms 0 retractions.
// rail_type: 0=rail 1=tram 2=light_rail 3=narrow_gauge 4=funicular; usage: 0=main 1=branch 2=industrial
const OLD_FALLBACK = (railType: number, usage: number): [pax: number, frt: number] => {
  if (railType === 2) return [250, 0] // light_rail (urban)
  if (railType === 1) return [200, 0] // tram
  if (railType === 3) return [30, 0]  // narrow gauge
  if (railType === 4) return [30, 0]  // funicular
  if (usage === 1) return [80, 0]     // heavy-rail branch (the Trať 162 constant)
  if (usage === 2) return [0, 8]      // industrial spur
  return [50, 10]                     // heavy-rail main
}
const wasOldFallbackStamp = (railType: number, usage: number, pax: number, frt: number): boolean => {
  const [fpax, ffrt] = OLD_FALLBACK(railType, usage)
  return pax === fpax && frt === ffrt
}

function enrichHexes(
  segments: Map<string, SegmentCount>,
  stationGPS: Map<string, StationGPS>,
): void {
  // Build GPS lookup for CZPTT station codes
  // Match CZPTT station names to OSM station names
  const codeToGPS = new Map<string, { lat: number; lon: number }>()
  const normOSM = new Map<string, StationGPS>()
  for (const [name, gps] of stationGPS) normOSM.set(normName(name), gps)

  const allCodes = new Set<string>()
  for (const seg of segments.values()) {
    allCodes.add(seg.from_code)
    allCodes.add(seg.to_code)
  }

  let matched = 0, unmatched = 0
  for (const seg of segments.values()) {
    for (const { code, name } of [
      { code: seg.from_code, name: seg.from_name },
      { code: seg.to_code, name: seg.to_name },
    ]) {
      if (codeToGPS.has(code)) continue
      // Try exact name match first
      const osm = stationGPS.get(name) || normOSM.get(normName(name))
      if (osm) {
        codeToGPS.set(code, { lat: osm.lat, lon: osm.lon })
        matched++
      } else {
        unmatched++
      }
    }
  }
  console.log(`  Station name matching: ${matched} found, ${unmatched} not found in OSM`)

  // For each railway segment in Arrow, find the CZPTT segment whose from/to
  // stations are closest to the segment's start/end points
  // Pre-filter hexes to Czech Republic bbox using H3 center (no file I/O needed)
  const allHexes = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      // CZ bbox: ~48.5-51.1 N, ~12.0-18.9 E (expanded margin for border hexes)
      if (lat > 48.0 && lat < 51.5 && lon > 11.5 && lon < 19.5) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  Czech hexes (H3 bbox pre-filter): ${hexDirs.length} of ${allHexes.length} total`)

  // Pre-build list of CZPTT segments with GPS
  const gpsSegments: { key: string; seg: SegmentCount; fromLat: number; fromLon: number; toLat: number; toLon: number }[] = []
  for (const [key, seg] of segments) {
    const fromGPS = codeToGPS.get(seg.from_code)
    const toGPS = codeToGPS.get(seg.to_code)
    if (fromGPS && toGPS) {
      gpsSegments.push({ key, seg, fromLat: fromGPS.lat, fromLon: fromGPS.lon, toLat: toGPS.lat, toLon: toGPS.lon })
    }
  }
  console.log(`  ${gpsSegments.length} CZPTT segments with GPS (of ${segments.size} total)`)

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot — CZPTT segments AND OSM station GPS both loaded non-empty AND the
  // name join actually resolved (either cache can silently persist an empty result:
  // an empty JR2026 unzip, or an Overpass 200 with zero elements). With any of them
  // hollow, nearestCzpttSegment() returns null everywhere, `stillClaimed` is always
  // false, and every OLD_FALLBACK-tuple row in CZ would be disowned with nothing to
  // re-stamp it. Only the retract is gated — matching simply stamps less.
  const incompleteInputs: string[] = []
  if (segments.size === 0) incompleteInputs.push('CZPTT segment counts empty (czptt-segment-counts.json)')
  if (stationGPS.size === 0) incompleteInputs.push('OSM station GPS empty (osm-stations.json)')
  if (incompleteInputs.length === 0 && gpsSegments.length === 0) incompleteInputs.push('station-name join resolved zero CZPTT segments to GPS')
  const retractSafe = incompleteInputs.length === 0
  if (!retractSafe) logRetractSkippedIncompleteInputs(incompleteInputs.join('; '))

  /** Nearest CZPTT station-pair segment within 500 m of a row midpoint — the ONE
   *  spatial join for BOTH the live matcher and the OLD_FALLBACK retract
   *  corroboration (same radius, same distance function), so a row can never be
   *  disowned that the matcher would still claim, or vice versa. */
  function nearestCzpttSegment(midLat: number, midLon: number): { seg: SegmentCount; key: string } | null {
    let bestDist = 500 // was 5000 — a station-pair midpoint 5 km away is not "this track"
    let best: { seg: SegmentCount; key: string } | null = null
    for (const gs of gpsSegments) {
      const d = pointToSegmentDist(midLat, midLon, gs.fromLat, gs.fromLon, gs.toLat, gs.toLon)
      if (d < bestDist) {
        bestDist = d
        // Canonicalize key: sort station codes so from→to = to→from
        const codes = [gs.seg.from_code, gs.seg.to_code].sort()
        best = { seg: gs.seg, key: codes[0] + '-' + codes[1] }
      }
    }
    return best
  }

  let totalRails = 0, totalMatched = 0, totalRetracted = 0, totalSilent = 0, hexesUpdated = 0, skippedService = 0

  for (const hexId of hexDirs) {
    const railPath = resolve(H3R4_DIR, hexId, 'railways.arrow')
    if (!existsSync(railPath)) continue

    const buf = readFileSync(railPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalRails += n

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const osmIdCol = table.getChild('osm_id')
    const railTypeCol = table.getChild('rail_type')
    const usageCol = table.getChild('usage')
    const serviceCol = table.getChild('service')

    // Seed output columns from existing Arrow state; priority rule decides per row.
    const existingTrainsPax = table.getChild('trains_passenger')
    const existingTrainsFrt = table.getChild('trains_freight')
    const existingSourceId = table.getChild('source_id')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    const sourceId = new Uint16Array(n)
    const matchedKeys: string[] = new Array(n).fill('')
    const mids: { lat: number; lon: number }[] = new Array(n)
    let hexMatched = 0
    let hexRetracted = 0
    let hexSilent = 0
    const retractedIdx: number[] = []

    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingTrainsPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingTrainsFrt?.get(i) as number) ?? 0
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    for (let i = 0; i < n; i++) {
      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2
      mids[i] = { lat: midLat, lon: midLon }

      const rt = railTypeCol ? (railTypeCol.get(i) as number) : 0
      const us = usageCol ? (usageCol.get(i) as number) : 0

      // OLD_FALLBACK retract (self-heal, mirrors the writeRailTrains ordering: BEFORE
      // the priority gate and the service skip — disowning must reach rows matching
      // would never see). A row this dataset owns whose counts exactly equal the
      // deleted class-default tuple is disowned, UNLESS today's CZPTT join still
      // reaches it (heavy rail only) — then the matcher below re-stamps it with the
      // real count in this same pass. retractSafe (CRITICAL-1b): only over a provably
      // complete snapshot — otherwise "no CZPTT segment near this row" is an input
      // artifact, not evidence, and would disown REAL stamps.
      if (retractSafe && sourceId[i] === MY_SOURCE_ID && wasOldFallbackStamp(rt, us, trainsPax[i], trainsFrt[i])) {
        const stillClaimed = rt === 0 && nearestCzpttSegment(midLat, midLon) !== null
        if (!stillClaimed) {
          trainsPax[i] = 0
          trainsFrt[i] = 0
          sourceId[i] = 0
          retractedIdx.push(i) // divisor reset below — a stale ×N must not halve the engine default
          hexRetracted++
          // NO continue — fall through (mirrors writeRailTrains): the row now
          // reaches the matcher, and a CZPTT-unknown line picks up its
          // timetable-silent residual in this SAME pass instead of the next.
        }
      }

      // Priority gate: if a higher-priority dataset already owns this row, leave it.
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) continue

      // Service tracks (yards, sidings, spurs) carry ~no through traffic — never
      // stamp them with a mainline's count. Leave at existing value (the 94,928-siding bug).
      const service = serviceCol ? (serviceCol.get(i) as number) : 0
      if (service > 0) { skippedService++; continue }

      // Family gate: CZPTT is the national HEAVY-RAIL timetable, so only rail_type=0
      // may inherit a CZPTT segment's count. tram(1)/light_rail(2)/narrow(3)/funicular(4)
      // have no CZPTT data and stay source_id=0 — the ENGINE default table
      // (emission/railway.rs::default_traffic) owns them. (A Prague tram was inheriting
      // a 217-train/day mainline up to 5 km away — the 14,799-tram bug.)
      if (rt !== 0) continue

      const m = nearestCzpttSegment(midLat, midLon)
      if (!m) {
        // No CZPTT match. CZPTT is the infrastructure manager's timetable —
        // every operator's train on the SŽ network is in it BY CONSTRUCTION,
        // so with a complete snapshot a heavy-rail line it does not know has
        // NO scheduled service. Owner decision 2026-07-11 (option b,
        // gtfs-silent-decision.md): stamp a small explicit residual — 2 pax +
        // 1 frt/day (occasional special/inspection/unscheduled runs) under
        // the BASELINE-rank timetable-silent id: ~−9 dB vs the engine branch
        // default on dead lines (Trať 162: 75→66 dB). frt=1 is deliberate —
        // explicit non-zero stops the engine's per-column zero-defaulting
        // from re-adding 5 freight. Gated on retractSafe: an unloaded
        // timetable must never testify to silence.
        if (retractSafe && shouldOverwrite(sourceId[i], SOURCE_ID_RAIL_TIMETABLE_SILENT)) {
          trainsPax[i] = 2
          trainsFrt[i] = 1
          sourceId[i] = SOURCE_ID_RAIL_TIMETABLE_SILENT
          hexSilent++
        }
        continue
      }

      // Whole-row atomic write — payload + dataset_id together.
      trainsPax[i] = m.seg.passenger
      trainsFrt[i] = m.seg.freight
      sourceId[i] = MY_SOURCE_ID
      matchedKeys[i] = m.key
      hexMatched++
    }

    if (hexMatched === 0 && hexRetracted === 0 && hexSilent === 0) continue

    // ── Parallel-way detection ──
    // For each matched segment, count distinct osm_ids with:
    // same czpttKey + within 50m + different osm_id + same rail_type + same usage + service=0
    // Retract-only hexes (hexMatched === 0) must PRESERVE the existing column:
    // rebuilding it from ones would silently reset divisors that belong to
    // rows this pass never touched (/gg Codex W2).
    const exDiv = table.getChild('parallel_divisor')
    const parallelDiv = new Uint8Array(n).fill(1)
    if (exDiv) for (let i = 0; i < n; i++) parallelDiv[i] = (exDiv.get(i) as number) || 1
    for (const i of retractedIdx) parallelDiv[i] = 1 // disowned row: divisor is void with the stamp

    for (let i = 0; i < n; i++) {
      if (!matchedKeys[i]) continue
      const service_i = serviceCol ? (serviceCol.get(i) as number) : 0
      if (service_i > 0) continue // skip sidings/yards
      const oid_i = osmIdCol ? String(osmIdCol.get(i)) : '0'
      const rt_i = railTypeCol ? (railTypeCol.get(i) as number) : 0
      const usage_i = usageCol ? (usageCol.get(i) as number) : 0

      const neighborOsm = new Set<string>()
      neighborOsm.add(oid_i) // include self

      for (let j = 0; j < n; j++) {
        if (j === i) continue
        if (matchedKeys[j] !== matchedKeys[i]) continue // different timetable section
        const oid_j = osmIdCol ? String(osmIdCol.get(j)) : '0'
        if (oid_j === oid_i) continue // same way (different segments of it)
        if (neighborOsm.has(oid_j)) continue // already counted this way
        const rt_j = railTypeCol ? (railTypeCol.get(j) as number) : 0
        const usage_j = usageCol ? (usageCol.get(j) as number) : 0
        const service_j = serviceCol ? (serviceCol.get(j) as number) : 0
        if (rt_j !== rt_i || usage_j !== usage_i || service_j > 0) continue
        const d = flatDist(mids[i].lat, mids[i].lon, mids[j].lat, mids[j].lon)
        if (d < 50) neighborOsm.add(oid_j)
      }

      parallelDiv[i] = Math.min(neighborOsm.size, 3) as number
    }

    // Stats
    let parCount = 0
    for (let i = 0; i < n; i++) if (parallelDiv[i] > 1) parCount++
    if (parCount > 0) {
      console.log(`    ${hexId}: ${parCount}/${hexMatched} segments have parallel_divisor > 1`)
    }

    // Copy all existing columns + add train counts + parallel_divisor + dataset_id
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (['trains_passenger', 'trains_freight', 'parallel_divisor', 'source_id'].includes(field.name)) continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
    columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())
    columns['parallel_divisor'] = vectorFromArray(parallelDiv, new Uint8())
    columns['source_id'] = vectorFromArray(sourceId, new Uint16())

    const newTable = makeTable(columns)
    writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    totalRetracted += hexRetracted
    totalSilent += hexSilent
    hexesUpdated++

    if (hexesUpdated % 20 === 0) {
      console.log(`  [${hexesUpdated}/${hexDirs.length}] ${totalMatched} segments matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRails} railway segments enriched (${(totalMatched / totalRails * 100).toFixed(1)}%)`)
  console.log(`  ${totalRetracted.toLocaleString()} legacy fallback stamps retracted`)
  console.log(`  ${totalSilent.toLocaleString()} timetable-silent residuals stamped (2 pax + 1 frt; id ${SOURCE_ID_RAIL_TIMETABLE_SILENT})`)
  console.log(`  ${skippedService.toLocaleString()} service tracks skipped (not stamped)`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
}

// ── Main ──

async function main() {
  console.log(`=== CZ Railway Enrichment (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const segments = await getTrainCounts()
  const stationGPS = await getStationGPS()
  console.log(`\n  Enriching railways.arrow files...`)
  enrichHexes(segments, stationGPS)
  console.log(`\n=== Done ===`)
}

// Import-safe: run only when invoked directly — importing this file must never
// trigger a download/enrichment pass (pattern from enrich-roads-cz.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error('Error:', err); process.exit(1) })
}
