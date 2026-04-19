/**
 * Enrich IR railways.arrow with Iran corridor defaults.
 *
 * **RAI (Islamic Republic of Iran Railways)** operates ~13,000 km of
 * standard gauge (1,435 mm) — largest network in Middle East/Central Asia.
 *
 * ## Urban metros
 *
 * 1. **Tehran Metro** — 7 lines, ~200 km, ~3M daily riders
 *    (one of world's busiest metro systems)
 * 2. **Isfahan Metro** — 1 line, 20 km
 * 3. **Mashhad Metro** — 2 lines
 * 4. **Tabriz Metro** — 1 line
 * 5. **Shiraz Metro** — 1 line
 *
 * ## RAI intercity corridors
 *
 * 1. **Tehran ↔ Mashhad** (~900 km, east) — busiest intercity route;
 *    Mashhad is world's 2nd holiest Shia city (Imam Reza shrine, 30M+ pilgrims/yr)
 * 2. **Tehran ↔ Isfahan ↔ Shiraz** (south) — cultural + industrial corridor
 * 3. **Tehran ↔ Tabriz** (NW) — Northwest corridor toward Turkey border
 * 4. **Tehran ↔ Bandar Abbas** (SE port) — container/freight port link
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Tehran Metro** (urban metro, ~3M daily riders) | 350 | 0 |
 *   | **Other metros** (Isfahan/Mashhad/Tabriz/Shiraz) | 80 | 0 |
 *   | **Tehran–Mashhad** (busiest intercity) | 15 | 8 |
 *   | **Tehran–Isfahan–Shiraz** | 8 | 10 |
 *   | **Tehran–Tabriz** (NW) | 5 | 8 |
 *   | Other/branch | 3 | 5 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ir.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ir-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Iran bbox [minLat, minLon, maxLat, maxLon]
const IR_BBOX: [number, number, number, number] = [25.0, 44.0, 39.8, 63.5]

const EXCLUDE_ZONES: Array<{ name: string; test: (lat: number, lon: number) => boolean }> = [
  { name: 'Turkey W',            test: (lat, lon) => lon < 44.8 && lat > 37 },
  { name: 'Armenia/Azerbaijan NW', test: (lat, lon) => lon < 45 && lat > 38.8 },
  { name: 'Azerbaijan E',        test: (lat, lon) => lon > 48 && lat > 39 },
  { name: 'Turkmenistan NE',     test: (lat, lon) => lon > 61 && lat > 35.5 },
  { name: 'Afghanistan E',       test: (lat, lon) => lon > 61 && lat <= 35.5 },
  { name: 'Pakistan SE',         test: (lat, lon) => lon > 60 && lat < 27 },
  { name: 'Iraq W',              test: (lat, lon) => lon < 46 && lat < 37 },
  { name: 'Persian Gulf/Oman S', test: (lat, lon) => lat < 25.5 && lon > 56 },
]

// Tehran Metro (7 lines, tight bbox around Tehran urban core)
const TEHRAN_METRO: [number, number, number, number] = [35.55, 51.20, 35.85, 51.65]

// Isfahan Metro (1 line)
const ISFAHAN_METRO: [number, number, number, number] = [32.55, 51.55, 32.75, 51.80]

// Mashhad Metro (2 lines)
const MASHHAD_METRO: [number, number, number, number] = [36.22, 59.45, 36.38, 59.70]

// Tabriz Metro (1 line)
const TABRIZ_METRO: [number, number, number, number] = [37.98, 46.20, 38.12, 46.40]

// Shiraz Metro (1 line)
const SHIRAZ_METRO: [number, number, number, number] = [29.54, 52.42, 29.66, 52.60]

// Tehran–Mashhad intercity corridor (east, ~900 km)
const TEHRAN_MASHHAD: [number, number, number, number] = [35.5, 51.2, 36.4, 59.7]

// Tehran–Isfahan–Shiraz south corridor
const TEHRAN_ISFAHAN_SHIRAZ: [number, number, number, number] = [29.5, 51.2, 35.8, 52.0]

// Tehran–Tabriz NW corridor
const TEHRAN_TABRIZ: [number, number, number, number] = [35.5, 46.2, 38.2, 51.5]

// Tehran–Bandar Abbas SE freight corridor
const TEHRAN_BANDAR_ABBAS: [number, number, number, number] = [27.1, 56.2, 35.8, 57.5]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (z.test(lat, lon)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, TEHRAN_METRO))          return { pax: 350, frt: 0,  zone: 'Tehran Metro' }
  if (inBbox(lat, lon, ISFAHAN_METRO))         return { pax: 80,  frt: 0,  zone: 'Isfahan Metro' }
  if (inBbox(lat, lon, MASHHAD_METRO))         return { pax: 80,  frt: 0,  zone: 'Mashhad Metro' }
  if (inBbox(lat, lon, TABRIZ_METRO))          return { pax: 80,  frt: 0,  zone: 'Tabriz Metro' }
  if (inBbox(lat, lon, SHIRAZ_METRO))          return { pax: 80,  frt: 0,  zone: 'Shiraz Metro' }
  if (inBbox(lat, lon, TEHRAN_MASHHAD))        return { pax: 15,  frt: 8,  zone: 'Tehran–Mashhad' }
  if (inBbox(lat, lon, TEHRAN_ISFAHAN_SHIRAZ)) return { pax: 8,   frt: 10, zone: 'Tehran–Isfahan–Shiraz' }
  if (inBbox(lat, lon, TEHRAN_TABRIZ))         return { pax: 5,   frt: 8,  zone: 'Tehran–Tabriz' }
  if (inBbox(lat, lon, TEHRAN_BANDAR_ABBAS))   return { pax: 3,   frt: 5,  zone: 'Tehran–Bandar Abbas' }
  return { pax: 3, frt: 5, zone: 'other' }
}

async function main() {
  console.log(`=== IR Railway Enrichment — Iran corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: RAI ~13,000 km standard gauge (1,435 mm). Tehran Metro ~3M daily riders.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, IR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  IR-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalSeg = 0, excluded = 0, alreadyEnriched = 0, matched = 0, hexesUpdated = 0
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
      if (!inBbox(midLat, midLon, IR_BBOX)) continue
      if (inAnyExclude(midLat, midLon)) { excluded++; continue }
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
  console.log(`  Already enriched (skip):  ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):    ${excluded.toLocaleString()}`)
  console.log(`  Matched by corridor:      ${matched.toLocaleString()}`)
  console.log(`  Hexes updated:            ${hexesUpdated}/${hexDirs.length}`)
  console.log(`\n  Zone distribution:`)
  for (const [z, c] of Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${z.padEnd(30)} ${c.toLocaleString()}`)
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
