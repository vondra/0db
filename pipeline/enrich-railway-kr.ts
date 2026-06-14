/**
 * Enrich KR railways.arrow with KORAIL operator-class CNOSSOS defaults.
 *
 * Korea publishes no public GTFS for KORAIL, Seoul Metro, Busan Metro, etc.
 * (privacy concerns + government portal geofencing). All open data sources
 * (data.go.kr, KTDB, KRIC) require Korean i-PIN authentication or KR IP.
 *
 * Critical pipeline limitation: OSM extractor only accepts railway tags
 * `rail | tram | light_rail | narrow_gauge | funicular`. Korean SUBWAY lines
 * (Seoul Metro 1-9, Busan Metro, etc.) tagged as `railway=subway` in OSM are
 * MISSING from railways.arrow. This script only enriches the KORAIL conventional
 * rail + commuter (Sinbundang, Suin-Bundang, Gyeongui-Jungang, Airport Express).
 *
 * Strategy: apply CNOSSOS-EU class defaults based on rail_type + usage:
 *   rail_type=0 (rail) usage=0 (main)    → 200 trains/day (KORAIL trunk)
 *   rail_type=0 (rail) usage=1 (branch)  → 80 trains/day  (KORAIL branch)
 *   rail_type=2 (light_rail)              → 250 trains/day (urban light rail)
 *   rail_type=1 (tram)                    → 200 trains/day
 *   rail_type=3 (narrow_gauge)            → 30 trains/day
 *
 * Service tracks (service > 0) are skipped per pipeline convention.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-railway-kr.ts
 */

import { resolve } from 'node:path'
import { shouldOverwrite } from './lib/provenance.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { makeCountryGate } from './lib/country-polygon.js'
import { SOURCE_ID_KR_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_KR_NATIONAL_RAILWAY

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Coarse hex shortlist [minLat,minLon,maxLat,maxLon] — sweeps in North Korea +
// a China sliver; makeCountryGate('KR') is the real per-row filter (KORAIL is
// South-Korea-only — NK rail must NOT inherit these counts).
const KR_BBOX: [number, number, number, number] = [33, 124.5, 39, 132]

// rail_type: 0=rail, 1=tram, 2=light_rail, 3=narrow_gauge, 4=funicular
// usage: 0=main, 1=branch, 2=industrial
function defaultTrains(railType: number, usage: number): number {
  if (railType === 2) return 250  // light_rail (urban)
  if (railType === 1) return 200  // tram
  if (railType === 3) return 30   // narrow gauge
  if (railType === 4) return 30   // funicular
  // rail_type=0 (heavy rail)
  if (usage === 1) return 80      // branch
  if (usage === 2) return 20      // industrial
  return 200                      // main line — KORAIL trunk
}

async function main() {
  console.log(`=== KR Railway Enrichment — KORAIL operator-class CNOSSOS defaults ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}\n`)

  const inKR = makeCountryGate('KR')
  const hexDirs = iterateCountryHexes(H3R4_DIR, KR_BBOX, 'railways.arrow')
  console.log(`  KR-bbox hexes with railways.arrow: ${hexDirs.length}\n`)

  let totalRows = 0, matched = 0, hexesUpdated = 0, skippedService = 0, outsideKR = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const r = await writeRailTrains(
      resolve(H3R4_DIR, hexDirs[hi], 'railways.arrow'),
      (row) => {
        if (!shouldOverwrite(row.existingSourceId, MY_SOURCE_ID)) return null
        // Per-row point-in-KR gate: the bbox sweeps in North Korea, whose rail
        // must NOT inherit KORAIL counts (border bleed — d2f0a742 MX lesson).
        if (!inKR(row.midLat, row.midLon)) { outsideKR++; return null }
        return { pax: defaultTrains(row.railType, row.usage), frt: 0, sourceId: MY_SOURCE_ID }
      },
      () => { matched++ },
    )
    totalRows += r.rows
    skippedService += r.skippedService
    if (r.updated) hexesUpdated++

    if (hi % 50 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched.toLocaleString()} matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total scanned: ${totalRows.toLocaleString()}`)
  console.log(`  Skipped (service tracks): ${skippedService.toLocaleString()}`)
  console.log(`  Skipped (outside KR / North Korea): ${outsideKR.toLocaleString()}`)
  console.log(`  Newly matched: ${matched.toLocaleString()} (${(100 * matched / Math.max(totalRows, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
