/**
 * Enrich KE railways.arrow with Kenyan defaults.
 *
 * Kenyan rail context:
 *   - **SGR (Madaraka Express / Standard Gauge Railway)**:
 *     - Phase 1: Mombasa ↔ Nairobi, **472 km**, opened June 2017,
 *       Chinese-built (CCCC/CRBC), ~2.7M passengers/year + heavy freight
 *     - Phase 2A: Nairobi ↔ Suswa/Naivasha, 120 km, opened October 2019
 *     - Phase 2B/3: Suswa ↔ Kisumu (planned, delayed)
 *   - **Old metre gauge network** (colonial 1895-1970s):
 *     - Mombasa ↔ Nairobi (parallel to SGR, mostly defunct)
 *     - Nairobi ↔ Kisumu (mostly defunct)
 *     - Nairobi ↔ Nanyuki (branch)
 *     - Mostly disused except Nairobi commuter services
 *   - **Nairobi Commuter Rail** — 4 lines (Syokimau, Embakasi, Ruiru, Kikuyu),
 *     limited service 2-4 trains/day each
 *   - **No urban metros or light rail** anywhere in Kenya
 *
 * Use OSM rail + bbox boosts.
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **SGR Mombasa↔Nairobi Phase 1** | 8 | 20 |
 * | 0 (rail) | 0 (main) | **SGR Nairobi↔Naivasha Phase 2A** | 4 | 8 |
 * | 0 (rail) | 0 (main) | **Nairobi commuter rail (4 lines)** | 20 | 4 |
 * | 0 (rail) | 0 (main) | Old metre gauge rural (mostly defunct) | 1 | 4 |
 * | 0 (rail) | 1 (branch) | - | 0 | 2 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 4 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ke.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ke-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const KE_BBOX: [number, number, number, number] = [-4.7, 33.9, 5.5, 41.9]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [3.5, 33.9, 5.5, 41.9] },    // Ethiopia N
  { bbox: [4.0, 33.9, 5.5, 36.0] },    // South Sudan NW
  { bbox: [-1.5, 33.9, 4.5, 35.0] },   // Uganda W
  { bbox: [-4.7, 33.9, -0.9, 37.0] },  // Tanzania S
  { bbox: [-1.6, 41.0, 4.5, 41.9] },   // Somalia NE
]

// Greater Nairobi (commuter rail)
const NAIROBI_BBOX: [number, number, number, number] = [-1.50, 36.60, -1.10, 37.05]

// SGR Phase 1 corridor (Mombasa ↔ Nairobi)
const SGR_PHASE1_BBOX: [number, number, number, number] = [-4.10, 36.60, -1.20, 39.70]

// SGR Phase 2A corridor (Nairobi ↔ Naivasha/Suswa)
const SGR_PHASE2_BBOX: [number, number, number, number] = [-1.50, 36.00, -0.60, 37.00]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inNairobi(lat: number, lon: number): boolean { return inBbox(lat, lon, NAIROBI_BBOX) }
function inSgrPhase1(lat: number, lon: number): boolean { return inBbox(lat, lon, SGR_PHASE1_BBOX) }
function inSgrPhase2(lat: number, lon: number): boolean { return inBbox(lat, lon, SGR_PHASE2_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) return { pax: 60, frt: 0 }
  if (railType === 1) return { pax: 40, frt: 0 }
  if (railType === 3) return { pax: 4, frt: 0 }
  if (railType === 4) return { pax: 2, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) return { pax: 15, frt: 0 }
  // Nairobi commuter (takes priority over SGR as urban sections)
  if (inNairobi(midLat, midLon)) return { pax: 20, frt: 4 }
  // SGR corridors
  if (inSgrPhase2(midLat, midLon)) return { pax: 4, frt: 8 }
  if (inSgrPhase1(midLat, midLon)) return { pax: 8, frt: 20 }
  if (usage === 1) return { pax: 0, frt: 2 }
  if (usage === 2) return { pax: 0, frt: 4 }
  return { pax: 1, frt: 4 }
}

async function main() {
  console.log(`=== KE Railway Enrichment — Kenyan defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, KE_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  KE-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalRails = 0, skippedService = 0, skippedExisting = 0, excluded = 0
  let matched = 0, hexesUpdated = 0

  for (const hex of hexDirs) {
    const railPath = resolve(H3R4_DIR, hex, 'railways.arrow')
    const buf = readFileSync(railPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const railTypeCol = table.getChild('rail_type')!
    const usageCol = table.getChild('usage')!
    const highspeedCol = table.getChild('highspeed')
    const serviceCol = table.getChild('service')
    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')
    const existingDatasetId = table.getChild('railways_dataset_id')

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    const datasetId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingFrt?.get(i) as number) ?? 0

      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    }
    totalRails += n

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) continue

      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, KE_BBOX)) continue
      if (inExclusion(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0
      const hs = highspeedCol ? Boolean(highspeedCol.get(i)) : false

      const d = defaultTrains(rt, us, hs, midLat, midLon)
      trainsPax[i] = d.pax
      trainsFrt[i] = d.frt
      datasetId[i] = MY_DATASET_ID
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

      columns['railways_dataset_id'] = vectorFromArray(datasetId, new Uint16())
      const newTable = makeTable(columns)
      writeFileSync(railPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total rails scanned:       ${totalRails.toLocaleString()}`)
  console.log(`  Skipped service:           ${skippedService.toLocaleString()}`)
  console.log(`  Skipped already enriched:  ${skippedExisting.toLocaleString()}`)
  console.log(`  Excluded (neighbours):     ${excluded.toLocaleString()}`)
  console.log(`  Matched:                   ${matched.toLocaleString()}`)
  console.log(`  Hexes updated:             ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
