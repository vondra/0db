/**
 * Enrich UZ railways.arrow with Uzbekistan corridor defaults.
 *
 * **Uzbekistan Railways (O'zbekiston Temir Yo'llari / UTY)** operates
 * ~6,950 km of broad gauge (1,520 mm) — Soviet-era network, modernising.
 *
 * 1. **Tashkent Metro** — opened 1977, **CENTRAL ASIA'S OLDEST METRO**.
 *    Soviet-era ornate stations (marble, mosaics, chandeliers), 4 lines,
 *    ~29 stations, ~40 km. Among the most beautiful metros in the world.
 *
 * 2. **Afrosiyob HSR** — Tashkent ↔ Samarkand ↔ Bukhara (2011/2016).
 *    **CENTRAL ASIA'S FIRST AND ONLY HIGH-SPEED RAIL**. Talgo 250 trains,
 *    250 km/h top speed. 2h Tashkent↔Samarkand (vs 6h by regular train).
 *    Named after Afrosiab, ancient Sogdian city beneath Samarkand.
 *
 * 3. **UTY conventional: Silk Road west** — Tashkent ↔ Samarkand ↔
 *    Bukhara ↔ Navoi (parallel to HSR, serves freight + local pax)
 *
 * 4. **UTY: Kamchik Pass line** — Tashkent ↔ Ferghana Valley via the
 *    Kamchik tunnel (19.2 km, opened 2016, built by China Railway),
 *    bypassing Tajikistan. Transformative for Ferghana Valley connectivity.
 *
 * 5. **UTY: NW line** — Tashkent ↔ Nukus ↔ Kungrad (Karakalpakstan,
 *    through Kyzylkum desert and Aral Sea region)
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Tashkent Metro** (urban metro, 4 lines) | 250 | 0 |
 *   | **Afrosiyob HSR** (Tashkent–Samarkand–Bukhara) | 8 | 0 |
 *   | **UTY conventional main** (Silk Road corridor) | 6 | 12 |
 *   | **Other / branch** | 2 | 5 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-uz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('uz-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Uzbekistan bbox [minLat, minLon, maxLat, maxLon]
const UZ_BBOX: [number, number, number, number] = [37.2, 55.9, 45.6, 73.2]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Kazakhstan N (W of 68)',  bbox: [43.5, 55.9, 45.6, 68.0] },
  { name: 'Kazakhstan N (E of 68)',  bbox: [42.0, 68.0, 45.6, 73.2] },
  { name: 'Kyrgyzstan E',            bbox: [37.2, 71.5, 42.0, 73.2] },
  { name: 'Tajikistan SE',           bbox: [37.2, 69.0, 39.5, 73.2] },
  { name: 'Afghanistan S',           bbox: [37.2, 55.9, 37.5, 73.2] },
  { name: 'Turkmenistan W',          bbox: [37.2, 55.9, 43.0, 57.0] },
]

// Tashkent Metro: tight bbox around Tashkent city (4 lines within city)
const TASHKENT_METRO: [number, number, number, number] = [41.25, 69.15, 41.40, 69.40]

// Afrosiyob HSR corridor: Tashkent ↔ Samarkand ↔ Bukhara
// Wide band covering the high-speed alignment
const AFROSIYOB_HSR: [number, number, number, number] = [39.6, 63.8, 41.4, 69.4]

// UTY conventional main: Silk Road west corridor (broad band, overlaps HSR)
const UTY_MAIN: [number, number, number, number] = [39.5, 63.5, 41.5, 69.5]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, TASHKENT_METRO)) return { pax: 250, frt: 0, zone: 'Tashkent Metro' }
  if (inBbox(lat, lon, AFROSIYOB_HSR)) return { pax: 8, frt: 0, zone: 'Afrosiyob HSR' }
  if (inBbox(lat, lon, UTY_MAIN)) return { pax: 6, frt: 12, zone: 'UTY conventional main' }
  return { pax: 2, frt: 5, zone: 'other' }
}

async function main() {
  console.log(`=== UZ Railway Enrichment — Uzbekistan corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: UTY ~6,950 km broad gauge (1,520 mm). Tashkent Metro 1977 (Central Asia's oldest). Afrosiyob HSR (Central Asia's only).\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UZ-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, UZ_BBOX)) continue
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
