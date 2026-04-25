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
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-kr.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_KR_NATIONAL_RAILWAY } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_KR_NATIONAL_RAILWAY

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Korea bbox
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

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= KR_BBOX[0] && lat <= KR_BBOX[2] && lon >= KR_BBOX[1] && lon <= KR_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  KR hexes with railways.arrow: ${hexDirs.length}\n`)

  let totalRails = 0, matched = 0, hexesUpdated = 0, skippedService = 0, skippedExisting = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'railways.arrow')
    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows
    if (numRows === 0) continue

    const railTypeCol = table.getChild('rail_type')
    const usageCol = table.getChild('usage')
    const serviceCol = table.getChild('service')
    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')
    const existingSourceId = table.getChild('source_id')

    const trainsPax = new Int32Array(numRows)
    const trainsFrt = new Int32Array(numRows)
    const sourceId = new Uint16Array(numRows)
    for (let i = 0; i < numRows; i++) {
      trainsPax[i] = (existingPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingFrt?.get(i) as number) ?? 0

      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    let hexMatched = 0
    for (let i = 0; i < numRows; i++) {
      totalRails++
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) continue

      const rt = (railTypeCol?.get(i) as number) ?? 0
      const us = (usageCol?.get(i) as number) ?? 0
      const trains = defaultTrains(rt, us)

      trainsPax[i] = trains
      hexMatched++
      matched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (field.name === 'trains_passenger' || field.name === 'trains_freight') continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['trains_passenger'] = vectorFromArray(trainsPax, new Int32())
      columns['trains_freight'] = vectorFromArray(trainsFrt, new Int32())

      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      const enriched = makeTable(columns)
      writeFileSync(arrowPath, Buffer.from(tableToIPC(enriched, 'file')))
      hexesUpdated++
    }

    if (hi % 50 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched.toLocaleString()} matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total scanned: ${totalRails.toLocaleString()}`)
  console.log(`  Skipped (service tracks): ${skippedService.toLocaleString()}`)
  console.log(`  Skipped (already enriched): ${skippedExisting.toLocaleString()}`)
  console.log(`  Newly matched: ${matched.toLocaleString()} (${(100 * matched / Math.max(totalRails, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
