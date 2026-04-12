/**
 * Enrich EG railways.arrow with Egyptian defaults.
 *
 * Egyptian National Railways (ENR, enr.gov.eg) and Cairo Metro (NAT) publish
 * no open geometry. Use OSM rail + geographic bbox boosts.
 *
 * Egyptian rail context:
 *   - **Egyptian National Railways (ENR)** — **Africa's oldest railway**
 *     (first line 1854, Alexandria ↔ Cairo). ~5,500 km total. Passenger
 *     + freight, mostly in the Nile Valley/Delta.
 *     Main corridors: Cairo ↔ Alexandria (209 km, busiest), Cairo ↔ Aswan
 *     (via Luxor, Upper Egypt), Cairo ↔ Port Said, Cairo ↔ Suez,
 *     Cairo ↔ Ismailia, Alexandria ↔ Mersa Matrouh.
 *   - **Cairo Metro** — **Africa's first metro** (opened 1987):
 *     - Line 1 (Helwan ↔ New El Marg) — 44 km, 35 stations, red
 *     - Line 2 (Shubra El Kheima ↔ El Mounib) — 21 km, blue
 *     - Line 3 (Adly Mansour ↔ Kit Kat ↔ Rod El Farag/Cairo University)
 *       — ~41 km, green (still extending in phases)
 *     - Line 4 under construction, Line 5/6 planned
 *   - **Alexandria Tram (Ramleh + City)** — oldest operational tram in
 *     Africa (since **1863**, horse-drawn initially, electrified 1902).
 *     2 lines, ~32 km.
 *   - **HSR (High Speed Rail)** — new 2,000+ km network under construction
 *     by Siemens (contract 2022), 3 lines:
 *     - Line 1: Ain Sokhna ↔ Alexandria ↔ Marsa Matrouh (660 km)
 *     - Line 2: Cairo ↔ Luxor ↔ Aswan (1,100 km)
 *     - Line 3: Luxor ↔ Hurghada ↔ Safaga
 *   - Freight is moderate — Egypt ships some commodities by rail but the
 *     Nile Valley is so narrow that road dominates.
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **Cairo ↔ Alexandria (busiest ENR)** | 100 | 30 |
 * | 0 (rail) | 0 (main) | **Cairo ↔ Upper Egypt (Luxor/Aswan)** | 40 | 15 |
 * | 0 (rail) | 0 (main) | **Cairo ↔ Suez Canal (Port Said/Suez/Ismailia)** | 20 | 15 |
 * | 0 (rail) | 0 (main) | Other operational | 10 | 8 |
 * | 0 (rail) | 1 (branch) | - | 1 | 4 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 6 |
 * | 1 (tram) | - | **Alexandria Tram** | 250 | 0 |
 * | 2 (light_rail) | - | **Cairo Metro Lines 1-3** | 400 | 0 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-eg.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const EG_BBOX: [number, number, number, number] = [22.0, 24.7, 31.7, 36.9]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [22.0, 24.7, 31.7, 25.0] },  // Libya W
  { bbox: [22.0, 24.7, 22.1, 36.9] },  // Sudan S
  { bbox: [29.5, 34.25, 31.7, 34.9] }, // Israel+Gaza NE
  { bbox: [22.0, 34.95, 29.3, 36.9] }, // Saudi E
  { bbox: [29.5, 34.95, 30.3, 35.2] }, // Jordan
]

// Greater Cairo metropolitan area (Cairo Metro + ENR hub)
const GREATER_CAIRO_BBOX: [number, number, number, number] = [29.90, 31.05, 30.30, 31.70]

// Alexandria metropolitan (Alexandria Tram)
const ALEXANDRIA_BBOX: [number, number, number, number] = [31.05, 29.80, 31.30, 30.15]

// Cairo ↔ Alexandria mainline corridor (Nile Delta west, 209 km)
const CAIRO_ALEX_BBOX: [number, number, number, number] = [29.90, 29.80, 31.30, 31.40]

// Upper Egypt mainline (Cairo ↔ Asyut ↔ Luxor ↔ Aswan — Nile Valley south)
const UPPER_EGYPT_BBOX: [number, number, number, number] = [23.90, 30.60, 30.00, 33.20]

// Suez Canal corridor (Cairo ↔ Ismailia ↔ Port Said / Suez)
const SUEZ_BBOX: [number, number, number, number] = [29.70, 31.25, 31.40, 32.70]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inGreaterCairo(lat: number, lon: number): boolean { return inBbox(lat, lon, GREATER_CAIRO_BBOX) }
function inAlexandria(lat: number, lon: number): boolean { return inBbox(lat, lon, ALEXANDRIA_BBOX) }
function inCairoAlex(lat: number, lon: number): boolean { return inBbox(lat, lon, CAIRO_ALEX_BBOX) }
function inUpperEgypt(lat: number, lon: number): boolean { return inBbox(lat, lon, UPPER_EGYPT_BBOX) }
function inSuez(lat: number, lon: number): boolean { return inBbox(lat, lon, SUEZ_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) {
    // light_rail / subway — Cairo Metro
    if (inGreaterCairo(midLat, midLon)) return { pax: 400, frt: 0 }
    return { pax: 80, frt: 0 }
  }
  if (railType === 1) {
    // tram — Alexandria Tram
    if (inAlexandria(midLat, midLon)) return { pax: 250, frt: 0 }
    return { pax: 60, frt: 0 }
  }
  if (railType === 3) return { pax: 6, frt: 0 }
  if (railType === 4) return { pax: 4, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) return { pax: 30, frt: 0 }
  // Mainline corridor precedence
  if (inCairoAlex(midLat, midLon)) return { pax: 100, frt: 30 }
  if (inUpperEgypt(midLat, midLon)) return { pax: 40, frt: 15 }
  if (inSuez(midLat, midLon)) return { pax: 20, frt: 15 }
  if (usage === 1) return { pax: 1, frt: 4 }
  if (usage === 2) return { pax: 0, frt: 6 }
  return { pax: 10, frt: 8 }
}

async function main() {
  console.log(`=== EG Railway Enrichment — Egyptian defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, EG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  EG-bbox hexes with railways.arrow: ${hexDirs.length}`)

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

    const trainsPax = new Int32Array(n)
    const trainsFrt = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trainsPax[i] = (existingPax?.get(i) as number) ?? 0
      trainsFrt[i] = (existingFrt?.get(i) as number) ?? 0
    }
    totalRails += n

    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      const service = (serviceCol?.get(i) as number) ?? 0
      if (service > 0) { skippedService++; continue }
      if (trainsPax[i] > 0 || trainsFrt[i] > 0) { skippedExisting++; continue }

      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, EG_BBOX)) continue
      if (inExclusion(midLat, midLon)) { excluded++; continue }

      const rt = (railTypeCol.get(i) as number) ?? 0
      const us = (usageCol.get(i) as number) ?? 0
      const hs = highspeedCol ? Boolean(highspeedCol.get(i)) : false

      const d = defaultTrains(rt, us, hs, midLat, midLon)
      trainsPax[i] = d.pax
      trainsFrt[i] = d.frt
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
