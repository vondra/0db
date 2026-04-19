/**
 * Enrich UA railways.arrow with Ukraine corridor defaults.
 *
 * NOTE: Ukraine has been under Russian invasion since February 2022.
 * This enrichment represents **pre-war baseline** data.
 * Actual conditions in occupied/frontline areas are drastically different.
 * Ukrzaliznytsia rail is CRITICAL WARTIME LOGISTICS infrastructure
 * (grain exports, refugee evacuation, military supply).
 *
 * **Ukrzaliznytsia** operates ~22,300 km broad gauge (1,520 mm) —
 * one of the world's largest rail networks, Soviet origin.
 * Main corridors:
 *   - Kyiv ↔ Lviv (west — primary refugee corridor to Poland, EU supply route)
 *   - Kyiv ↔ Kharkiv (NE — frontline city since 2022)
 *   - Kyiv ↔ Odesa (south — Black Sea port, grain exports)
 *   - Kyiv ↔ Dnipro ↔ Zaporizhzhia (SE — frontline city)
 *
 * **Kyiv Metro**: 1960 Soviet, 3 lines ~70 km, 52 stations.
 *   ~1.5M daily riders pre-war. Many stations serve as BOMB SHELTERS since 2022.
 *
 * **Kharkiv Metro**: 1975, 3 lines, 38 stations.
 *   ~800k daily pre-war. FRONTLINE CITY, heavily damaged since 2022.
 *   Metro stations used as air-raid shelters.
 *
 * **Dnipro Metro**: 1995, 1 line, 6 stations.
 *   ~300k daily pre-war.
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Kyiv Metro** (3-line urban metro) | 250 | 0 |
 *   | **Kharkiv Metro** (frontline, reduced) | 100 | 0 |
 *   | **Dnipro Metro** (1-line) | 40 | 0 |
 *   | **Main trunk** (Kyiv–Lviv/Kharkiv/Odesa/Dnipro) | 20 | 15 |
 *   | Other/branch | 5 | 8 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ua.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ua-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Ukraine bbox [minLat, minLon, maxLat, maxLon]
const UA_BBOX: [number, number, number, number] = [44.3, 22.1, 52.4, 40.3]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Russia N/E',    bbox: [52.0, 40.0, 52.4, 40.3] },
  { name: 'Belarus N',     bbox: [51.5, 22.1, 52.4, 34.0] },
  { name: 'Poland W',      bbox: [49.0, 22.1, 52.4, 23.5] },
  { name: 'Slovakia SW',   bbox: [44.3, 22.1, 49.0, 22.5] },
  { name: 'Hungary SW',    bbox: [44.3, 22.1, 48.5, 22.5] },
  { name: 'Romania SW',    bbox: [44.3, 22.1, 48.0, 23.5] },
  { name: 'Moldova SW',    bbox: [45.5, 22.1, 46.5, 27.5] },
]

// Kyiv Metro: 3 lines, tight bbox around Kyiv urban core
const KYIV_METRO: [number, number, number, number] = [50.33, 30.32, 50.53, 30.72]

// Kharkiv Metro: 3 lines, tight bbox around Kharkiv urban core
const KHARKIV_METRO: [number, number, number, number] = [49.91, 36.18, 50.05, 36.38]

// Dnipro Metro: 1 line
const DNIPRO_METRO: [number, number, number, number] = [48.41, 34.97, 48.50, 35.10]

// Main trunk corridors: Kyiv hub radiating to Lviv/Kharkiv/Odesa/Dnipro
// Broad band covering the main intercity axes
const MAIN_TRUNK: [number, number, number, number] = [44.5, 22.5, 52.3, 40.2]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, KYIV_METRO))    return { pax: 250, frt: 0, zone: 'Kyiv Metro' }
  if (inBbox(lat, lon, KHARKIV_METRO)) return { pax: 100, frt: 0, zone: 'Kharkiv Metro' }
  if (inBbox(lat, lon, DNIPRO_METRO))  return { pax: 40,  frt: 0, zone: 'Dnipro Metro' }
  if (inBbox(lat, lon, MAIN_TRUNK))    return { pax: 20,  frt: 15, zone: 'Main trunk' }
  return { pax: 5, frt: 8, zone: 'other' }
}

async function main() {
  console.log(`=== UA Railway Enrichment — Ukraine corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: Ukrzaliznytsia ~22,300 km broad gauge (1,520 mm).`)
  console.log(`  NOTE: Pre-war baseline. Occupied/frontline areas drastically different.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UA-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, UA_BBOX)) continue
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
