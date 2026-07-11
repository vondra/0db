/**
 * Enrich BE railways.arrow with urban metro/tram GTFS feeds.
 *
 * Continental SNCB national rail is already applied via enrich-railway-europe.ts.
 * This script ADDS Brussels (STIB), Flanders (De Lijn tram), and Wallonia (TEC
 * tram/light rail) urban rail/tram coverage to existing SNCB enrichment.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-be.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-be.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-be.ts --enrich-only
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { SOURCE_ID_BE_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { writeRailTrains, type RailRow } from './lib/railways-arrow.js'
import { makeCountryGate, segmentWhollyOutside } from './lib/country-polygon.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import {
  computeStopFrequenciesForFeed, nearestGridStop, describeIncompleteFeeds,
  logRetractSkippedIncompleteInputs, readMergedStopCache, writeMergedStopCache,
  type StopTrainCount,
} from './lib/gtfs-enrich-core.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const MY_SOURCE_ID = SOURCE_ID_BE_NATIONAL_RAILWAY

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/be`)
// Versioned filename: the family-aware schema added a mandatory `family` field, so a
// pre-migration cache must NOT be reused (a family-less stop would fall into tramGrid →
// heavy rail loses its count, trams re-inherit it). A new name forces a clean rebuild.
const CACHE_FREQUENCIES = resolve(CACHE_DIR, 'gtfs-family-frequencies.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// Belgium urban rail multi-feed: STIB (Brussels metro+tram), De Lijn (Flanders
// tram), TEC (Wallonia tram/pre-metro). National SNCB is already in continental.
interface FeedConfig {
  id: string
  name: string
  urls: string[]
}

const FEEDS: FeedConfig[] = [
  {
    id: 'stib-brussels',
    name: 'STIB/MIVB Brussels (metro 4 lines + tram 18 lines + bus)',
    urls: [
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/be-bruxelles-capitale-societe-des-transports-intercommunaux-de-bruxellesmaatschappij-voor-het-intercommunaal-vervoer-te-brussel-stibmivb-gtfs-1088.zip?alt=media',
      'https://stibmivb.opendatasoft.com/api/datasets/1.0/gtfs-files-production/alternative_exports/gtfszip/',
    ],
  },
  {
    id: 'delijn-flanders',
    name: 'De Lijn (Flanders tram: Antwerpen, Gent, Coast Tram)',
    urls: [
      'http://gtfs.irail.be/de-lijn/de_lijn-gtfs.zip',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/be-vlaams-gewest-de-lijn-gtfs-684.zip?alt=media',
    ],
  },
  {
    id: 'tec-wallonia',
    name: 'TEC Wallonia (Charleroi pre-metro light rail + bus)',
    urls: [
      'http://opendata.tec-wl.be/Current%20GTFS/TEC-GTFS.zip',
      'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/be-unknown-societe-regionale-wallonne-du-transport-gtfs-1212.zip?alt=media',
    ],
  },
]

// Belgium bounding box
const BE_BBOX: [number, number, number, number] = [49.4, 2.4, 51.6, 6.5]

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
    throw new Error('Failed to download any Belgian GTFS feed')
  }

  console.log(`  ${results.length}/${FEEDS.length} BE feeds available`)
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

// Retract signature for stamps the pre-2026-07-10 fallback design wrote: the deleted
// class-default table, verbatim. In be only tram/light_rail rows ever reached the
// fallback (the match closure returns null for every other rail_type before it), but
// the full table is kept so any older-generation stamp under this id heals too. A row
// still owned by MY_SOURCE_ID whose counts exactly equal its class tuple was filled by
// that fallback, not measured — exact-tuple + family ambiguity is negligible
// (/tmp/quietmap-v4/gtfs-rail-misjoin.md §3), and the retract's `when` re-runs today's
// stop join, so a live-covered row is re-stamped by `match`, never disowned. No-match
// rows now return null: source_id stays 0 and the ENGINE default table
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
  // COUNTRY GATE (#26C): a national feed can carry international through-services,
  // so the raw stop list may contain foreign stations (BE_BBOX blankets Lille,
  // Maastricht, Aachen) — joining those would stamp a neighbour's track under this
  // feed's id, and the same-rank higher-id tiebreak can beat the neighbour's own
  // national source (mechanism: the PL feed stamped 11,856 km of CZ track,
  // 7fac2349). A national feed only speaks for its own country's network: foreign
  // stops are dropped BEFORE any grid is built.
  const inBe = makeCountryGate('BE')
  const rawCount = allStopCounts.length
  allStopCounts = allStopCounts.filter((sc) => inBe(sc.lat, sc.lon))
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

  // Scan ALL Belgian hexes (not just ones with stops) so tram/light_rail without a
  // nearby GTFS stop still gets its CNOSSOS class default — never SNCB's heavy-rail count.
  const hexDirs = iterateCountryHexes(H3R4_DIR, BE_BBOX, 'railways.arrow')
  console.log(`  BE hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, totalStamped = 0, totalRetracted = 0, skippedService = 0, hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    // be is supplemental urban tram/metro — only a tramGrid is needed (no rail-family
    // stops exist: STIB/De Lijn/TEC GTFS is route_type 0/1, all → 'tram').
    const tramGrid = new Map<string, StopTrainCount[]>()
    for (const sc of stopsByHex.get(hexId) || []) {
      if (sc.family !== 'tram') continue
      const key = `${Math.floor(sc.lat * 100)}_${Math.floor(sc.lon * 100)}`
      if (!tramGrid.has(key)) tramGrid.set(key, [])
      tramGrid.get(key)!.push(sc)
    }

    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexId, 'railways.arrow'),
      (row) => {
        // be is supplemental urban tram/metro — national heavy rail is enriched by
        // europe, so be NEVER touches rail_type 0 (or narrow_gauge/funicular):
        // return null leaves those rows untouched. Only tram(1)/light_rail(2).
        if (row.railType !== 1 && row.railType !== 2) return null
        const bestStop = nearestGridStop(tramGrid, row)
        if (bestStop) {
          return { pax: bestStop.trains_passenger, frt: bestStop.trains_freight, sourceId: MY_SOURCE_ID }
        }
        // No GTFS match: return null — the row stays/goes source_id=0 and the ENGINE
        // default table (emission/railway.rs::default_traffic) owns the unknown.
        // Never stamp a guess under MY_SOURCE_ID.
        return null
      },
      undefined,
      // CRITICAL-1b: retract only over a provably complete snapshot (retractSafe) —
      // with a silently skipped feed, "no stop covers this row" is an input artifact,
      // not evidence, and would disown REAL stamps.
      retractSafe ? {
        sourceId: MY_SOURCE_ID,
        // Disown a legacy pre-2026-07-10 class-default stamp ONLY when today's join no
        // longer reaches the row (same tram-family 500 m grid join as `match`) — a row
        // a live stop still covers is re-stamped with the real count instead. Rail
        // types the closure never matched have no join to corroborate: tuple alone.
        when: (row) => {
          // Country-bleed disown (#26C): ANY owned row physically wholly outside BE (start+mid+end — genuine border-straddlers stay ours; shared R9 predicate) is
          // foreign track this feed must not speak for — even when its count was
          // a real through-train figure, ownership belongs to the local country's
          // own timetable (its national enricher re-stamps on its next run).
          if (segmentWhollyOutside(inBe, row.midLat, row.midLon, row.startLat, row.startLon, row.endLat, row.endLon)) return true
          if (!wasOldFallbackStamp(row)) return false
          if (row.railType !== 1 && row.railType !== 2) return true
          return nearestGridStop(tramGrid, row) === null
        },
      } : undefined,
      inBe, // #31.7 central country gate — see writeRailTrains
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
  console.log(`  Retracted legacy defaults: ${totalRetracted.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)
}

// ── Main ──

async function main() {
  console.log(`=== BE Railway Enrichment — Multi-feed urban GTFS (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // CRITICAL-1b (/gg Codex): a retract may only run over a PROVABLY COMPLETE input
  // snapshot — all three urban feeds loaded non-empty THIS run (or a v2 cache that
  // recorded exactly that). downloadAllGtfs tolerates per-feed failure so enrichment
  // can still stamp from the rest, but a missing feed makes the retract's tram-join
  // corroboration read "no coverage" over that feed's region and disown REAL stamps
  // (the 5 genuine 200/0 tram rows only survive via same-pass re-match, which a
  // partial grid can't provide). Only the retract is gated — never the stamping.
  let merged: StopTrainCount[]
  let retractUnsafeDetail: string
  if (!forceDownload && existsSync(CACHE_FREQUENCIES)) {
    console.log(`  Using cached merged stop frequencies: ${CACHE_FREQUENCIES}`)
    const cached = readMergedStopCache<StopTrainCount>(CACHE_FREQUENCIES)
    merged = cached.stops
    retractUnsafeDetail = cached.feedsLoadedNonEmpty === null
      ? `legacy merged cache without feed provenance — delete ${CACHE_FREQUENCIES} to rebuild from the cached feed extracts`
      : describeIncompleteFeeds(FEEDS.map(f => f.id), cached.feedsLoadedNonEmpty)
    console.log(`  ${merged.length} stops in cache`)
  } else {
    const feeds = await downloadAllGtfs()

    const perFeedCounts: StopTrainCount[][] = []
    for (const { feed, dir } of feeds) {
      const counts = await computeStopFrequenciesForFeed(feed, dir, BE_BBOX)
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
