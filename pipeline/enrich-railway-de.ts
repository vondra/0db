/**
 * Enrich DE railways.arrow with train frequencies from the gtfs.de national GTFS
 * (task #30.2 — data half of the EBA trackside-hot finding).
 *
 * Source: download.gtfs.de/germany/free/latest.zip — the gtfs.de "de_full"
 *   aggregate: DELFI NAP NeTEx dataset flattened to plain GTFS (feed_info:
 *   "Daten bereitgestellt von DELFI e.V."), all German passenger transport in
 *   one file — DB Fernverkehr (ICE/IC) + DB Regio + all Verbünde (S-Bahn,
 *   U-Bahn, tram, bus). License CC-BY 4.0, no registration, refreshed daily,
 *   ~30-day validity window. Verified 2026-07-11: BASIC route_types only
 *   (2 rail ×1060, 0 tram ×513, 1 subway ×113, 3 bus ×21033, 4 ferry, 7
 *   funicular) — no TPEG 100-117 extended codes, so the shared
 *   gtfs-enrich-core family sets apply verbatim.
 *
 * FREIGHT — conscious interim model: DELFI is passenger-only and DB InfraGO
 *   publishes no freight paths (rail-timetable acquisition matrix 2026-07).
 *   We stamp frt=0, and the ENGINE defaults each zero column INDEPENDENTLY
 *   (normalize/rail.rs::normalize_rail: `q_frt = trains_freight > 0 ? .. :
 *   def_frt`, locked by test rail_defaults_keep_freight_when_only_passenger_
 *   enriched) — a pax-stamped main line still radiates the default 20
 *   freight/day (branch 5, industrial-usage 15). Do NOT fake a freight count
 *   here; calibrating DE freight vs EBA corridor shares is the
 *   experiments-lane follow-up.
 *
 * NO timetable-silent residual for DE (rail-timetable-silent id 9863 stays
 *   CZ-only): DE coverage is measured, not yet proven — see the
 *   timetableCoverage verdict this script prints after a full run.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts --enrich-only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { tableFromIPC } from 'apache-arrow'
import { SOURCE_ID_DE_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { makeCountryGate } from './lib/country-polygon.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import {
  computeStopFrequenciesForFeed, nearestGridStop, describeIncompleteFeeds,
  logRetractSkippedIncompleteInputs, readMergedStopCache, writeMergedStopCache,
  type StopTrainCount,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_DE_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/de`)
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
    id: 'de-full',
    name: 'gtfs.de de_full (DELFI national aggregate: DB Fernverkehr + Regio + all Verbünde)',
    urls: [
      'https://download.gtfs.de/germany/free/latest.zip',
    ],
  },
]

// Germany bounding box (task #30.2 reference bbox)
const DE_BBOX: [number, number, number, number] = [47.3, 5.9, 55.1, 15.0]

// ── Step 1: Download GTFS feed ──

/**
 * Download all configured GTFS feeds and return a list of extraction directories.
 * Single feed today; the loop shape is kept so a second feed (e.g. a WESTbahn-style
 * gap filler) slots in without restructuring.
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
    throw new Error('Failed to download the German GTFS feed')
  }

  console.log(`  ${results.length}/${FEEDS.length} DE feeds available`)
  return results
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

// NO OLD_FALLBACK retract signature here — deliberately. de-national-railway
// (9864) was allocated 2026-07-11, AFTER the class-default fallback purge, so
// this id has never stamped a fallback tuple anywhere (probed 841f007ffffffff /
// 841fa17ffffffff / 841f111ffffffff: every DE rail row is source_id=0 — the
// pre-purge DE stamps lived under global-gtfs-transit id 100, whose own
// enricher enrich-railway-europe.ts carries their retract). The only self-heal
// this dataset needs is the #26C country-bleed disown below.

async function enrichHexes(allStopCounts: StopTrainCount[], retractSafe: boolean): Promise<void> {
  // COUNTRY GATE (#26C): the DELFI aggregate carries international
  // through-services, so the raw stop list contains Basel SBB, Salzburg,
  // Praha, Amsterdam… — joining those would stamp a neighbour's track under
  // the DE id (mechanism: the PL feed stamped 11,856 km of CZ track,
  // 7fac2349). A national feed only speaks for its own country's network:
  // foreign stops are dropped BEFORE any grid is built.
  const inDe = makeCountryGate('DE')
  const rawCount = allStopCounts.length
  allStopCounts = allStopCounts.filter((sc) => inDe(sc.lat, sc.lon))
  if (rawCount !== allStopCounts.length) {
    console.log(`  country gate: ${rawCount - allStopCounts.length} foreign stops dropped (international through-services)`)
  }
  // Group stops by H3R4 hex
  const stopsByHex = new Map<string, StopTrainCount[]>()
  for (const sc of allStopCounts) {
    if (!stopsByHex.has(sc.h3r4)) stopsByHex.set(sc.h3r4, [])
    stopsByHex.get(sc.h3r4)!.push(sc)
  }
  console.log(`  Stops span ${stopsByHex.size} H3R4 hexes`)

  // Scan ALL German hexes (not just ones with stops) so re-runs behave
  // identically whether or not a hex still carries stops.
  const hexDirs = iterateCountryHexes(H3R4_DIR, DE_BBOX, 'railways.arrow')
  console.log(`  DE-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, totalStamped = 0, totalRetracted = 0, skippedService = 0, hexesUpdated = 0
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

    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexId, 'railways.arrow'),
      (row) => {
        // Family gate: heavy rail (rail_type 0) → rail stops (ICE/IC/RE/RB/
        // S-Bahn); tram/light_rail (rail_type 1/2) → tram/U-Bahn stops.
        // Cross-family matches can't happen.
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
      // with a failed/empty feed, "outside DE / no coverage" evidence could rest on
      // an input artifact and disown REAL stamps.
      retractSafe ? {
        sourceId: MY_SOURCE_ID,
        // Country-bleed disown (#26C): ANY owned row physically outside DE is
        // foreign track this feed must not speak for — even when its count was
        // a real DB through-train figure, ownership belongs to the local
        // country's own timetable. No tuple fingerprint clause: this id has no
        // pre-purge fallback history (see the block comment above enrichHexes).
        when: (row) => !inDe(row.midLat, row.midLon),
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
  console.log(`  Matched by GTFS:           ${totalStamped.toLocaleString()}`)
  console.log(`  Retracted (country-bleed): ${totalRetracted.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)

  await measureTimetableCoverage(inDe)
}

/**
 * timetableCoverage verdict (task #30.2): % of usage=main, non-service rows
 * carrying de-national-railway, read back from the arrows AFTER the write —
 * measured, never inferred from match counters. Reported for the raw DE bbox
 * AND for rows inside the DE polygon (the bbox clips AT/CH/CZ/NL/BE/DK/PL
 * margins whose rows this feed must never own). The registry does NOT declare
 * full coverage on this basis — Ondra decides from the printed number.
 */
async function measureTimetableCoverage(inDe: (lat: number, lon: number) => boolean): Promise<void> {
  console.log(`\n=== timetableCoverage (read-back) ===`)
  const hexDirs = iterateCountryHexes(H3R4_DIR, DE_BBOX, 'railways.arrow')
  let bboxMain = 0, bboxStamped = 0, deMain = 0, deStamped = 0
  for (const hexId of hexDirs) {
    const table = tableFromIPC(readFileSync(resolve(H3R4_DIR, hexId, 'railways.arrow')))
    const n = table.numRows
    if (n === 0) continue
    const usage = table.getChild('usage')
    const service = table.getChild('service')
    const src = table.getChild('source_id')
    const sLat = table.getChild('start_lat')
    const sLon = table.getChild('start_lon')
    const eLat = table.getChild('end_lat')
    const eLon = table.getChild('end_lon')
    if (!sLat || !sLon) continue
    for (let i = 0; i < n; i++) {
      if (((usage?.get(i) as number) ?? 0) !== 0) continue
      if (((service?.get(i) as number) ?? 0) > 0) continue
      const stamped = ((src?.get(i) as number) ?? 0) === MY_SOURCE_ID
      bboxMain++
      if (stamped) bboxStamped++
      const midLat = ((sLat.get(i) as number) + ((eLat?.get(i) as number) ?? (sLat.get(i) as number))) / 2
      const midLon = ((sLon.get(i) as number) + ((eLon?.get(i) as number) ?? (sLon.get(i) as number))) / 2
      if (inDe(midLat, midLon)) {
        deMain++
        if (stamped) deStamped++
      }
    }
  }
  const pct = (a: number, b: number) => (b === 0 ? '0.0' : ((100 * a) / b).toFixed(1))
  console.log(`  usage=main non-service rows in DE bbox:    ${bboxMain.toLocaleString()}, stamped ${bboxStamped.toLocaleString()} (${pct(bboxStamped, bboxMain)}%)`)
  console.log(`  usage=main non-service rows in DE polygon: ${deMain.toLocaleString()}, stamped ${deStamped.toLocaleString()} (${pct(deStamped, deMain)}%)`)
  console.log(`  timetableCoverage verdict: ${pct(deStamped, deMain)}% of DE mainline rows carry de-national-railway`)
}

// ── Main ──

async function main() {
  console.log(`=== DE Railway Enrichment — gtfs.de de_full / DELFI (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE
  // input snapshot — the feed loaded non-empty THIS run, or a v2 cache that
  // recorded exactly that. Only the retract is gated — never the stamping.
  let merged: StopTrainCount[]
  let retractUnsafeDetail: string
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_FREQUENCIES}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_FREQUENCIES)
    merged = cached.stops
    retractUnsafeDetail = cached.feedsLoadedNonEmpty === null
      ? `legacy merged cache without feed provenance — delete ${CACHE_FREQUENCIES} to rebuild from the cached feed extract`
      : describeIncompleteFeeds(FEEDS.map(f => f.id), cached.feedsLoadedNonEmpty)
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const feeds = await downloadAllGtfs()

    const perFeedCounts: StopTrainCount[][] = []
    for (const { feed, dir } of feeds) {
      const counts = await computeStopFrequenciesForFeed(feed, dir, DE_BBOX)
      perFeedCounts.push(counts)
    }

    merged = mergeStopCounts(perFeedCounts)

    const feedsLoadedNonEmpty = feeds.filter((_, i) => perFeedCounts[i].length > 0).map(({ feed }) => feed.id)
    retractUnsafeDetail = describeIncompleteFeeds(FEEDS.map(f => f.id), feedsLoadedNonEmpty)
    if (retractUnsafeDetail === '') {
      writeMergedStopCache(CACHE_FREQUENCIES, feedsLoadedNonEmpty, merged)
      console.log(`  Cached merged frequencies to ${CACHE_FREQUENCIES}`)
    } else {
      // Never persist a partial snapshot: a poisoned cache would silently starve
      // every later cache-served run (both enrichment and the retract evidence).
      console.log(`  NOT caching partial merged snapshot (${retractUnsafeDetail})`)
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
