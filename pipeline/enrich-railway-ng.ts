/**
 * Enrich NG railways.arrow with Nigerian defaults.
 *
 * Nigerian rail context:
 *   - **NRC (Nigerian Railway Corporation)** — state operator, ~3,500 km
 *     colonial-era narrow gauge (mostly defunct) + new SGR corridors
 *   - **Lagos-Ibadan SGR** (standard gauge, 157 km, opened 2021) —
 *     passenger + freight corridor
 *   - **Abuja-Kaduna SGR** (187 km, opened 2014) — passenger, suspended
 *     and restarted multiple times due to security concerns (kidnappings)
 *   - **Itakpe-Warri iron ore line** (327 km, opened 2020) — iron ore
 *     freight from Itakpe iron ore mine to Warri port (Ajaokuta Steel)
 *   - **Lagos Blue Line** (LRMT phase 1 Mile 2 ↔ Marina, opened 2023) —
 *     Lagos metro system's first line
 *   - **Lagos Red Line** (Oyingbo ↔ Agbado, opened 2024) — Lagos second line
 *   - **Abuja Metro** (light rail, opened 2018, Abuja↔Airport corridor)
 *
 * No open GTFS/geometry from NRC, Lagos Metro Rail Mass Transit, or Abuja
 * Light Rail. Use OSM rail + bbox boosts.
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **Lagos-Ibadan SGR (2021)** | 16 | 20 |
 * | 0 (rail) | 0 (main) | **Abuja-Kaduna SGR (2014)** | 8 | 6 |
 * | 0 (rail) | 0 (main) | **Itakpe-Warri iron ore (2020)** | 2 | 20 |
 * | 0 (rail) | 0 (main) | NRC colonial narrow gauge (mostly defunct) | 1 | 4 |
 * | 0 (rail) | 1 (branch) | - | 0 | 2 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 4 |
 * | 2 (light_rail) | - | **Lagos Blue Line + Red Line** | 250 | 0 |
 * | 2 (light_rail) | - | **Abuja Metro** | 60 | 0 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ng.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ng-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const NG_BBOX: [number, number, number, number] = [4.0, 2.7, 13.9, 14.7]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [6.0, 2.7, 12.5, 3.5] },      // Benin W
  { bbox: [13.0, 2.7, 13.9, 14.0] },    // Niger N
  { bbox: [11.5, 13.5, 13.9, 14.7] },   // Chad NE
  { bbox: [4.0, 13.0, 11.0, 14.7] },    // Cameroon E
]

// Greater Lagos (Lagos Blue + Red Line)
const LAGOS_BBOX: [number, number, number, number] = [6.35, 3.20, 6.75, 3.75]

// Greater Abuja (Abuja Metro light rail + FCT)
const ABUJA_BBOX: [number, number, number, number] = [8.95, 7.20, 9.20, 7.60]

// Lagos-Ibadan SGR corridor (157 km)
const LAGOS_IBADAN_SGR_BBOX: [number, number, number, number] = [6.40, 3.30, 7.45, 4.10]

// Abuja-Kaduna SGR corridor (187 km)
const ABUJA_KADUNA_SGR_BBOX: [number, number, number, number] = [8.95, 7.20, 10.55, 7.80]

// Itakpe-Warri iron ore line (327 km)
const ITAKPE_WARRI_BBOX: [number, number, number, number] = [5.50, 5.60, 8.30, 7.00]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inLagos(lat: number, lon: number): boolean { return inBbox(lat, lon, LAGOS_BBOX) }
function inAbuja(lat: number, lon: number): boolean { return inBbox(lat, lon, ABUJA_BBOX) }
function inLagosIbadanSgr(lat: number, lon: number): boolean { return inBbox(lat, lon, LAGOS_IBADAN_SGR_BBOX) }
function inAbujaKadunaSgr(lat: number, lon: number): boolean { return inBbox(lat, lon, ABUJA_KADUNA_SGR_BBOX) }
function inItakpeWarri(lat: number, lon: number): boolean { return inBbox(lat, lon, ITAKPE_WARRI_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) {
    // light_rail — Lagos Blue/Red Line or Abuja Metro
    if (inLagos(midLat, midLon)) return { pax: 250, frt: 0 }
    if (inAbuja(midLat, midLon)) return { pax: 60, frt: 0 }
    return { pax: 80, frt: 0 }
  }
  if (railType === 1) return { pax: 60, frt: 0 }
  if (railType === 3) return { pax: 4, frt: 0 }
  if (railType === 4) return { pax: 2, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) return { pax: 20, frt: 0 }
  // SGR corridors
  if (inLagosIbadanSgr(midLat, midLon)) return { pax: 16, frt: 20 }
  if (inAbujaKadunaSgr(midLat, midLon)) return { pax: 8, frt: 6 }
  if (inItakpeWarri(midLat, midLon)) return { pax: 2, frt: 20 }
  if (usage === 1) return { pax: 0, frt: 2 }
  if (usage === 2) return { pax: 0, frt: 4 }
  return { pax: 1, frt: 4 }  // NRC colonial narrow gauge (mostly defunct)
}

async function main() {
  console.log(`=== NG Railway Enrichment — Nigerian defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, NG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  NG-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, NG_BBOX)) continue
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
