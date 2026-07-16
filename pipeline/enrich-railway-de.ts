/**
 * Enrich DE railways.arrow with train frequencies from the gtfs.de national GTFS
 * (task #30.2 — data half of the EBA trackside-hot finding) — migrated onto
 * the shared graph-walk driver (2026-07-16 Phase 4 point 2 rewrite, plan
 * `pro-e-sd-zaj-m-wobbly-liskov`, following `enrich-railway-dk.ts`'s pattern).
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
 * HEAVY RAIL (rail_type 0) now runs on `lib/rail-walk-enrich.ts`:
 * `computeStopPairFrequenciesForFeed` (lib/gtfs-stop-pairs.ts) turns
 * stop_times.txt into station-PAIR frequencies, walked along the shortest path
 * by `enrichRailwaysByGraphWalk`. TRAM/light-rail (rail_type 1/2 — S-Bahn/
 * U-Bahn/tram) keeps the pre-Phase-4 `nearestGridStop` 500 m stop-join
 * (`buildTramExtraMatch`, shared with every other national enricher), wired
 * in as the walk driver's `extraMatch` fallback arm.
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
 * NO timetable-silent residual for DE (cz-timetable-silent id 9863 stays
 *   CZ-only): DE coverage is measured, not yet proven — see the
 *   `measureTimetableCoverage` verdict this script prints after every run.
 *
 * DE's source id is NATIONALLY OWNED (SOURCE_ID_DE_NATIONAL_RAILWAY, 9864,
 *   allocated 2026-07-11 AFTER the class-default fallback purge): this id has
 *   never stamped a fallback tuple anywhere (probed 841f007ffffffff /
 *   841fa17ffffffff / 841f111ffffffff pre-migration: every DE rail row was
 *   source_id=0 — the pre-purge DE stamps lived under global-gtfs-transit id
 *   100, whose own enricher enrich-railway-europe.ts carries their retract) —
 *   no OLD_FALLBACK table to delete, no predecessor id to preserve.
 *   `bleedGate` is set to the SAME country gate as `countryGate` — a row
 *   wholly outside Germany is disownable on geometry alone.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts --enrich-only
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-de.ts --stamp-only
 *
 * --stamp-only: Phase-3/4 Step A rollout control (same semantics as
 * enrich-railway-europe.ts) — enableDestructive=false: the run still
 * walk-stamps heavy-rail counts AND divisors and still runs the tram
 * stop-join, but NO retract and NO country-bleed heal fire.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { tableFromIPC } from 'apache-arrow'
import { SOURCE_ID_DE_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { makeCountryGate } from './lib/country-polygon.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import { enrichRailwaysByGraphWalk } from './lib/rail-walk-enrich.js'
import type { RailStationPairCount } from './lib/rail-graph.js'
import { computeStopPairFrequenciesForFeed } from './lib/gtfs-stop-pairs.js'
import {
  computeStopFrequenciesForFeed, dedupeStopsByLocation, buildTramExtraMatch, routeFamily,
  declaredRouteFamiliesForFeed, describeIncompleteFamilies,
  describeIncompleteFeeds, logRetractSkippedIncompleteInputs, readMergedStopCache, writeMergedStopCache,
  GTFS_BORDER_MARGIN_DEG, type StopTrainCount,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_DE_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/de`)
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-family-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')
const stampOnly = process.argv.includes('--stamp-only')

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

// Same 0.5° margin as `loadStopsWithCoords`'s GTFS geometry envelope (item 6,
// gtfs-enrich-core.ts) — the graph-walk scope must reach every hex a
// cross-border stop's pair could land in, or a DE-CH/AT/PL through-train's
// foreign endpoint never snaps and the whole pair quarantines for no real
// reason. Stop/pair PARSING itself gets the UNPADDED `DE_BBOX` — the margin
// is applied internally by `loadStopsWithCoords`.
const GRAPH_BBOX: [number, number, number, number] = [
  DE_BBOX[0] - GTFS_BORDER_MARGIN_DEG, DE_BBOX[1] - GTFS_BORDER_MARGIN_DEG,
  DE_BBOX[2] + GTFS_BORDER_MARGIN_DEG, DE_BBOX[3] + GTFS_BORDER_MARGIN_DEG,
]

// ── Step 1: Download GTFS feed (UNCHANGED — per-country cache/download quirks) ──

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

// ── Main ──

async function main() {
  console.log(`=== DE Railway Enrichment — gtfs.de de_full / DELFI (${YEAR}, Phase 4: graph-walk) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // downloadAllGtfs is always needed — even a merged-stop-cache hit below still
  // needs a real extractDir per feed for the pair parser's own per-extractDir cache.
  const feeds = await downloadAllGtfs()
  const stopCacheHit = !forceDownload && existsSync(CACHE_FREQUENCIES)

  // ── Per-feed parse: declared families + heavy-rail STATION PAIRS (+ stops on
  //    cache miss). BIDIRECTIONAL completeness (2026-07-16 review item 4):
  //    every family a feed's own routes.txt declares must have parsed non-empty
  //    (declares rail → pairs>0, declares tram → tramStops>0; declares neither
  //    → exempt), evaluated by the shared `describeIncompleteFamilies`. A
  //    malformed routes.txt THROWS (item 3, `declaredRouteFamiliesForFeed`) and
  //    is recorded as a PARSE FAILURE — never as "legitimately rail-less".
  //    Pairs are re-validated every run (their own per-extractDir cache in
  //    computeStopPairFrequenciesForFeed is fingerprinted against the GTFS
  //    inputs, item 2 — NOT recomputed from stop_times each run, the old
  //    comment here claiming "always computed fresh" was wrong); the tram
  //    direction is checked live on stop-cache miss and vouched by the v2
  //    cache's recorded provenance on a hit (recording rule below is itself
  //    bidirectional, so a recorded feed means BOTH directions held at write).
  const perFeedPairs: RailStationPairCount[][] = []
  const perFeedCounts: StopTrainCount[][] = []
  const completeFeedIds: string[] = []
  const feedIssues: string[] = []
  for (const { feed, dir } of feeds) {
    try {
      const declared = await declaredRouteFamiliesForFeed(dir, routeFamily)
      const { pairs } = await computeStopPairFrequenciesForFeed(dir, { bbox: DE_BBOX, optionsKey: 'de-default' })
      perFeedPairs.push(pairs)
      let tramN: number | null = null
      if (!stopCacheHit) {
        const counts = await computeStopFrequenciesForFeed(feed, dir, DE_BBOX)
        perFeedCounts.push(counts)
        tramN = counts.filter(s => s.family === 'tram').length
      }
      const issue = describeIncompleteFamilies(feed.id, declared, pairs.length, tramN)
      if (issue) feedIssues.push(issue)
      else completeFeedIds.push(feed.id)
      console.log(`  [${feed.id}] ${pairs.length} heavy-rail station pairs; declares [${[...declared].sort().join('+') || 'no rail family'}]`)
    } catch (err: any) {
      console.error(`  [${feed.id}] PARSE FAILED: ${err.message}`)
      feedIssues.push(`${feed.id}: parse failure — ${err.message}`)
    }
  }
  const pairs = perFeedPairs.flat()
  // Feeds not present at all this run (--enrich-only with no cached extract).
  const missingDetail = describeIncompleteFeeds(FEEDS.map(f => f.id), feeds.map(({ feed }) => feed.id))

  // ── Tram stops: the merged v2 cache (the pre-existing download marker;
  //    unchanged path) or this run's own per-feed parses. ──
  let mergedStops: StopTrainCount[]
  let stopsUnsafeDetail: string
  if (stopCacheHit) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_FREQUENCIES}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_FREQUENCIES)
    mergedStops = cached.stops
    // Legacy bare-array cache: with a SINGLE configured feed, non-empty stops are
    // themselves the completeness proof (the one feed parsed non-empty when the
    // cache was written). The FEEDS.length===1 term is the tripwire that voids
    // this shortcut the day a second feed is added.
    stopsUnsafeDetail = cached.feedsLoadedNonEmpty === null
      ? (FEEDS.length === 1 && mergedStops.length > 0 ? '' : `legacy merged cache without feed provenance — delete ${CACHE_FREQUENCIES} to rebuild from the cached feed extract`)
      : describeIncompleteFeeds(FEEDS.map(f => f.id), cached.feedsLoadedNonEmpty)
    console.log(`  ${mergedStops.length} stops in cache`)
  } else {
    mergedStops = dedupeStopsByLocation(perFeedCounts.flat())
    stopsUnsafeDetail = '' // live per-feed evaluation already sits in feedIssues
    if (feedIssues.length === 0 && missingDetail === '') {
      // Recording rule (item 4): a feed lands in the cache's provenance only
      // when it passed the FULL bidirectional check this run — a later
      // cache-served run inherits completeness both ways, not any-family.
      writeMergedStopCache(CACHE_FREQUENCIES, completeFeedIds, mergedStops)
      console.log(`  Cached merged frequencies to ${CACHE_FREQUENCIES}`)
    } else {
      // Never persist a partial snapshot: a poisoned cache would silently starve
      // every later cache-served run (both enrichment and the retract evidence).
      console.log(`  NOT caching partial merged snapshot (${[...feedIssues, missingDetail].filter(Boolean).join('; ')})`)
    }
  }

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE
  // snapshot for BOTH families this single feed carries — a working tram part
  // must never mask an empty heavy-rail pairs part (or vice versa), since ONE
  // retract object below covers every row regardless of family.
  const retractUnsafeDetail = [missingDetail, ...feedIssues, stopsUnsafeDetail].filter(Boolean).join('; ')
  const retractSafe = retractUnsafeDetail === ''
  if (!retractSafe) logRetractSkippedIncompleteInputs(retractUnsafeDetail)

  const tramStops = mergedStops.filter(s => s.family === 'tram')

  if (pairs.length === 0 && tramStops.length === 0) {
    console.log(`\nNo GTFS data to enrich. Exiting.`)
    return
  }

  console.log(`\n  ${pairs.length} heavy-rail station pairs, ${tramStops.length} tram/light-rail stops`)

  // COUNTRY GATE (#26C): the DELFI aggregate carries international
  // through-services, so the raw stop list contains Basel SBB, Salzburg,
  // Praha, Amsterdam… — joining those would stamp a neighbour's track under
  // the DE id (mechanism: the PL feed stamped 11,856 km of CZ track,
  // 7fac2349). A national feed only speaks for its own country's network.
  // #31.7 central country gate — see writeRailTrains / rail-walk-enrich.ts.
  const inDe = makeCountryGate('DE')

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir: H3R4_DIR,
    bbox: GRAPH_BBOX,
    pairs,
    sourceId: MY_SOURCE_ID,
    countryGate: inDe,
    // Nationally-owned id (unlike europe's shared SOURCE_ID_GLOBAL_GTFS_TRANSIT):
    // the SAME gate doubles as the bleed arm — a row wholly outside Germany is
    // disownable on geometry alone, since this id never legitimately stamps there.
    bleedGate: inDe,
    extraMatch: buildTramExtraMatch(tramStops, MY_SOURCE_ID),
    // Single id — DE has no retired predecessor id to absorb (see module doc:
    // pre-purge DE stamps lived under global-gtfs-transit id 100, a different
    // enricher's business). The driver's own generic retract — disown a
    // previously-owned row the walk/tram-join no longer covers, given
    // retractSafe — is the only retract this id has ever needed.
    retract: { sourceIds: [MY_SOURCE_ID] },
    retractSafe,
    enableDestructive: !stampOnly,
    // DE is NOT silent-capable (silentResidual omitted) — a quarantine-free
    // row the walk never reaches simply stays at source_id=0 for the
    // engine's own class default; only CZ's timetable evidence (owner
    // decision option b) justifies a residual. See the module doc's
    // `measureTimetableCoverage` note: DE coverage is measured, not proven.
    sidecar: {
      scope: 'de',
      extractFingerprint: `de-gtfs:${feeds.map(({ feed }) => feed.id).join('+')}`,
      feeds: feeds.map(({ feed }) => feed.id),
    },
  })
  console.log(`\n  walk stats: ${JSON.stringify(stats)}`)

  await measureTimetableCoverage(inDe)

  console.log(`\n=== Done (${stampOnly ? 'stamp-only — Step A proof mode' : 'destructive ops enabled'}) ===`)
}

/**
 * timetableCoverage verdict (task #30.2): % of usage=main, non-service rows
 * carrying de-national-railway, read back from the arrows AFTER the write —
 * measured, never inferred from the walk's own match counters. Reported for
 * the raw DE bbox AND for rows inside the DE polygon (the bbox clips
 * AT/CH/CZ/NL/BE/DK/PL margins whose rows this feed must never own). The
 * registry does NOT declare full coverage on this basis — Ondra decides from
 * the printed number.
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

// Import-safe: run only when invoked directly — importing this file must never
// trigger a download/enrichment pass (pattern from enrich-roads-cz.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error('Error:', err); process.exit(1) })
}
