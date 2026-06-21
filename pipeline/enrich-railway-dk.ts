/**
 * Enrich DK railways.arrow with Rejseplanen unified Danish GTFS.
 *
 * Source: rejseplanen.info/labs/GTFS.zip — single ~55 MB feed covering all
 * Danish public transport (DSB national rail, S-tog Copenhagen suburban,
 * Metro København, Aarhus Letbane, Odense Letbane, Lokaltog, Arriva,
 * Movia bus, Midttrafik, Sydtrafik, Fynbus, Nordjyllands Trafikselskab,
 * BAT Bornholm). 21 operators in one file.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-dk.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-dk.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-dk.ts --enrich-only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { SOURCE_ID_DK_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'
import { pointToSegmentDist } from './lib/spatial.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import { computeStopFrequenciesForFeed, type StopTrainCount } from './lib/gtfs-enrich-core.js'

const MY_SOURCE_ID = SOURCE_ID_DK_NATIONAL_RAILWAY

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/dk`)
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
    id: 'rejseplanen',
    name: 'Rejseplanen unified DK (DSB + S-tog + Metro + Letbane + Lokaltog + buses)',
    urls: [
      'https://www.rejseplanen.info/labs/GTFS.zip',
    ],
  },
]

// Denmark mainland bounding box (incl. islands; excl. Greenland/Faroe)
const DK_BBOX: [number, number, number, number] = [54.5, 8.0, 57.8, 13.0]

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
    throw new Error('Failed to download any Danish GTFS feed')
  }

  console.log(`  ${results.length}/${FEEDS.length} DK feeds available`)
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

  // Scan ALL Danish hexes (not just ones with stops) so class defaults reach
  // every track — a tram that no longer inherits DSB's count gets its own value.
  const hexDirs = iterateCountryHexes(H3R4_DIR, DK_BBOX, 'railways.arrow')
  console.log(`  DK hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, totalStamped = 0, gtfsHits = 0, skippedService = 0, hexesUpdated = 0
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
        // Family gate: heavy rail (rail_type 0) → DSB/S-tog/Lokaltog rail stops;
        // tram/light_rail (rail_type 1/2) → Letbane/Metro stops. Cross-family matches can't happen.
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
  console.log(`  Skipped service tracks:    ${skippedService.toLocaleString()}`)
  console.log(`  Matched by GTFS:           ${gtfsHits.toLocaleString()}`)
  console.log(`  Stamped (incl. defaults):  ${totalStamped.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)
}

// ── Main ──

async function main() {
  console.log(`=== DK Railway Enrichment — Rejseplanen unified GTFS (${YEAR}) ===\n`)
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
      const counts = await computeStopFrequenciesForFeed(feed, dir, DK_BBOX)
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
