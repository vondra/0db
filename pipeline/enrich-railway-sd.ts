/**
 * Enrich SD railways.arrow with Sudanese Railway Corporation defaults.
 *
 * Sudan Railway Corporation (SRC) operates ~5,000 km of 1,067 mm (3 ft 6 in)
 * narrow gauge track — one of Africa's longest networks but severely deteriorated.
 * Most lines are barely operational or suspended. Civil war since April 2023
 * (RSF vs SAF) has further disrupted what remained.
 *
 * ## Railway network context
 *
 *   - **Main line: Khartoum ↔ Atbara ↔ Port Sudan** (~760 km) — most operational
 *     corridor; connects capital to Red Sea port; critical for freight; some
 *     passenger service survives. Originally built 1896 for Kitchener's campaign.
 *   - **South line: Khartoum ↔ Sennar ↔ Kosti** (~530 km) — Blue Nile/White Nile
 *     agricultural corridor; cotton/sorghum freight; very irregular passenger.
 *   - **Western extension: Kosti ↔ Nyala (El Obeid, Darfur)** (~1,200 km) —
 *     largely suspended; Darfur conflict severely damaged infrastructure.
 *   - **Atbara ↔ Wadi Halfa** (~460 km) — crosses Nubian Desert to Egypt border;
 *     very sporadic; Egyptian Nile Valley railway connects at Wadi Halfa.
 *   - **Other branch lines** — largely abandoned (Kassala branch, Hay el Arab branch).
 *
 * ## Trains/day defaults
 *
 * | bbox | description | pax/day | frt/day |
 * |---|---|---:|---:|
 * | [15.5,32.4,19.7,37.3] | Khartoum↔Port Sudan (main operational line) | 1 | 3 |
 * | [13.0,30.0,15.6,33.5] | Khartoum↔Sennar↔Kosti (south agricultural) | 0 | 2 |
 * | other main/branch | Deteriorated/sporadic | 0 | 0 |
 *
 * SD_BBOX: [minLat=8.7, minLon=21.8, maxLat=22.2, maxLon=38.6]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-sd.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('sd-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const SD_BBOX: [number, number, number, number] = [8.7, 21.8, 22.2, 38.6]

// Main operational corridor: Khartoum ↔ Atbara ↔ Port Sudan
const MAIN_LINE_BBOX: [number, number, number, number] = [15.5, 32.4, 19.7, 37.3]

// South agricultural corridor: Khartoum ↔ Sennar ↔ Kosti
const SOUTH_LINE_BBOX: [number, number, number, number] = [13.0, 30.0, 15.6, 33.5]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

function isExcluded(lat: number, lon: number): boolean {
  if (lat > 22.2) return true                          // Egypt N
  if (lat < 8.8) return true                           // South Sudan S
  if (lon < 22.0) return true                          // Chad / Libya W
  if (lon > 38.5) return true                          // Eritrea / Red Sea E
  if (lat > 20.0 && lon < 24.0) return true            // Libya NW corner
  return false
}

function defaultTrains(
  railType: number, usage: number,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  // light_rail / subway / tram — none in Sudan
  if (railType === 1 || railType === 2 || railType === 3 || railType === 4) return { pax: 0, frt: 0 }
  // Industrial siding
  if (usage === 2) return { pax: 0, frt: 2 }
  // Main corridor: Khartoum ↔ Port Sudan
  if (inBbox(midLat, midLon, MAIN_LINE_BBOX)) return { pax: 1, frt: 3 }
  // South corridor: Khartoum ↔ Kosti
  if (inBbox(midLat, midLon, SOUTH_LINE_BBOX)) return { pax: 0, frt: 2 }
  // All other lines: largely suspended / sporadic
  return { pax: 0, frt: 0 }
}

async function main() {
  console.log(`=== SD Railway Enrichment — Sudan Railway Corporation defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, SD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  SD-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, SD_BBOX)) continue
      if (isExcluded(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0

      const d = defaultTrains(rt, us, midLat, midLon)
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
