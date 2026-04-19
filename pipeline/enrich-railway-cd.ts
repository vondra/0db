/**
 * Enrich CD railways.arrow with DR Congo rail corridor defaults.
 *
 * DR Congo has one of Africa's largest railway networks by km (~5,000 km total)
 * but one of its most decrepit — three separate gauge systems, poorly interconnected,
 * operated by **SNCC** (Société Nationale des Chemins de fer du Congo).
 *
 * 1. **CFMK Matadi↔Kinshasa** (366 km, built 1890-1898 under Leopold II — one of Africa's
 *    first railways, infamous for construction deaths during forced labour):
 *    - Most active DRC railway — connects Atlantic port (Matadi) to the capital (Kinshasa)
 *    - Route: Matadi (5.82°S, 13.45°E) → Songololo → Kinshasa (4.32°S, 15.32°E)
 *
 * 2. **SNCC Voie Nationale — Lubumbashi↔Kamina** (Katanga copper/cobalt corridor, ~600 km):
 *    - Critical mining freight corridor in the Copperbelt
 *    - Route: Lubumbashi (11.66°S, 27.47°E) → Kamina (8.74°S, 25.00°E)
 *
 * 3. **SNCC Kamina↔Ilebo** (interior, ~1,000 km — largely abandoned, connects to Kasai
 *    River navigation at Ilebo):
 *    - Route: Kamina (8.74°S, 25.00°E) → Mwene-Ditu → Kananga → Ilebo (4.33°S, 20.59°E)
 *
 * 4. **SNCC Eastern branches** (Kalemie↔Lake Tanganyika area, Mwadingusha area):
 *    - Minimal operations
 *
 * **No metro, no trams**.
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **CFMK Matadi↔Kinshasa**                     | 2 | 4 |
 *   | **Lubumbashi↔Kamina** (Copperbelt)            | 1 | 3 |
 *   | **Kamina↔Ilebo** (interior, largely abandoned)| 0 | 1 |
 *   | **Eastern branches**                          | 0 | 1 |
 *   | Other                                         | 0 | 0 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-cd.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('cd-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const CD_BBOX: [number, number, number, number] = [-13.5, 12.0, 5.5, 31.5]

// CFMK: Matadi ↔ Kinshasa (most active DRC railway)
const CFMK_CORRIDOR: [number, number, number, number] = [-5.85, 13.40, -4.25, 15.50]

// SNCC Voie Nationale: Lubumbashi ↔ Kamina (Copperbelt mining freight)
const LUBUMBASHI_KAMINA_CORRIDOR: [number, number, number, number] = [-11.7, 25.0, -8.5, 27.6]

// SNCC: Kamina ↔ Ilebo (interior, largely abandoned)
const KAMINA_ILEBO_CORRIDOR: [number, number, number, number] = [-8.5, 20.5, -3.3, 25.5]

// SNCC Eastern branches (Kalemie/Lake Tanganyika area)
const EASTERN_BRANCHES: [number, number, number, number] = [-11.0, 27.0, -5.0, 29.5]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, CFMK_CORRIDOR)) return { pax: 2, frt: 4, zone: 'CFMK Matadi-Kinshasa' }
  if (inBbox(lat, lon, LUBUMBASHI_KAMINA_CORRIDOR)) return { pax: 1, frt: 3, zone: 'SNCC Lubumbashi-Kamina (Copperbelt)' }
  if (inBbox(lat, lon, KAMINA_ILEBO_CORRIDOR)) return { pax: 0, frt: 1, zone: 'SNCC Kamina-Ilebo (largely abandoned)' }
  if (inBbox(lat, lon, EASTERN_BRANCHES)) return { pax: 0, frt: 1, zone: 'SNCC Eastern branches' }
  return { pax: 0, frt: 0, zone: 'other' }
}

async function main() {
  console.log(`=== CD Railway Enrichment — SNCC/CFMK corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: Three separate gauge systems (600 mm, 1067 mm, 1000 mm). SNCC state operator. CFMK is most active line.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, CD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CD-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalSeg = 0, matched = 0, hexesUpdated = 0
  const zoneCounts: Record<string, number> = {}

  for (const hex of hexDirs) {
    const rp = resolve(H3R4_DIR, hex, 'railways.arrow')
    const buf = readFileSync(rp)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')
    const existingDatasetId = table.getChild('railways_dataset_id')
    const pax = new Int32Array(n)
    const frt = new Int32Array(n)
    const datasetId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      pax[i] = (existingPax?.get(i) as number) ?? 0
      frt[i] = (existingFrt?.get(i) as number) ?? 0

      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    }
    totalSeg += n
    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) continue
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, CD_BBOX)) continue
      const c = classifyRail(midLat, midLon)
      pax[i] = c.pax; frt[i] = c.frt; datasetId[i] = MY_DATASET_ID
      zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1
      hexMatched++; matched++
    }
    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['trains_passenger', 'trains_freight', 'railways_dataset_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['trains_passenger'] = vectorFromArray(pax, new Int32())
      columns['trains_freight'] = vectorFromArray(frt, new Int32())

      columns['railways_dataset_id'] = vectorFromArray(datasetId, new Uint16())
      const newTable = makeTable(columns)
      writeFileSync(rp, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total segments scanned:   ${totalSeg.toLocaleString()}`)
  console.log(`  Matched by corridor:      ${matched.toLocaleString()}`)
  console.log(`  Hexes updated:            ${hexesUpdated}/${hexDirs.length}`)
  console.log(`\n  Zone distribution:`)
  for (const [z, c] of Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${z.padEnd(38)} ${c.toLocaleString()}`)
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
