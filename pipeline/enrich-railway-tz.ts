/**
 * Enrich TZ railways.arrow with Tanzanian defaults.
 *
 * Tanzania has three distinct rail networks:
 *   - **TAZARA** (Tanzania-Zambia Railway Authority) — **1,860 km**
 *     Chinese-built 1970-1975, Dar es Salaam ↔ Kapiri Mposhi (Zambia).
 *     Carries copper/cobalt from Zambian Copperbelt to Dar es Salaam port.
 *     Cape gauge (1,067 mm). Freight + passenger.
 *   - **TRL/TRC (Central Line)** — old metre-gauge legacy, Dar es Salaam
 *     ↔ Tabora ↔ Kigoma (Lake Tanganyika) and Tabora ↔ Mwanza (Lake
 *     Victoria). Partially defunct.
 *   - **SGR (Standard Gauge Railway)** — new standard gauge under
 *     construction in 5 phases:
 *       Phase 1: Dar es Salaam ↔ Morogoro (300 km, opened 2021)
 *       Phase 2: Morogoro ↔ Makutupora (Dodoma, 422 km, opened 2024)
 *       Phase 3: Makutupora ↔ Tabora (371 km, under construction)
 *       Phase 4: Tabora ↔ Isaka (165 km)
 *       Phase 5: Isaka ↔ Mwanza + branches to Kigoma/Rusumo
 *   - **Dar es Salaam commuter rail** — very limited TRL legacy service
 *   - **No urban metros**; Dar es Salaam has BRT (DART bus rapid transit)
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **SGR Phase 1+2 Dar↔Dodoma** | 10 | 20 |
 * | 0 (rail) | 0 (main) | **TAZARA (Dar↔Zambia)** | 3 | 12 |
 * | 0 (rail) | 0 (main) | **Central Line (old meter gauge)** | 2 | 6 |
 * | 0 (rail) | 0 (main) | Other operational | 1 | 4 |
 * | 0 (rail) | 1 (branch) | - | 0 | 2 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 4 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-tz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const TZ_BBOX: [number, number, number, number] = [-11.8, 29.3, -0.9, 40.5]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [-1.6, 33.9, -0.9, 41.9] },    // Kenya N
  { bbox: [-1.5, 29.5, -0.9, 35.0] },    // Uganda NW
  { bbox: [-2.9, 28.8, -1.0, 30.9] },    // Rwanda W
  { bbox: [-4.5, 29.0, -2.3, 30.9] },    // Burundi W
  { bbox: [-11.8, 29.0, -2.0, 29.4] },   // DRC W
  { bbox: [-11.8, 29.0, -8.2, 33.0] },   // Zambia SW
  { bbox: [-11.8, 32.7, -9.4, 34.6] },   // Malawi S
  { bbox: [-11.8, 34.6, -10.2, 40.5] },  // Mozambique S
]

// SGR Phase 1+2 corridor (Dar es Salaam ↔ Morogoro ↔ Dodoma/Makutupora)
const SGR_PHASE12_BBOX: [number, number, number, number] = [-6.90, 35.50, -6.50, 39.45]

// TAZARA corridor (Dar es Salaam ↔ Mbeya ↔ Zambia border)
const TAZARA_BBOX: [number, number, number, number] = [-11.00, 31.50, -6.80, 39.50]

// Central Line (old meter gauge Dar ↔ Tabora ↔ Kigoma + Tabora ↔ Mwanza)
const CENTRAL_LINE_BBOX: [number, number, number, number] = [-6.90, 29.50, -2.50, 39.50]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inSgrPhase12(lat: number, lon: number): boolean { return inBbox(lat, lon, SGR_PHASE12_BBOX) }
function inTazara(lat: number, lon: number): boolean { return inBbox(lat, lon, TAZARA_BBOX) }
function inCentralLine(lat: number, lon: number): boolean { return inBbox(lat, lon, CENTRAL_LINE_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) return { pax: 60, frt: 0 }
  if (railType === 1) return { pax: 30, frt: 0 }
  if (railType === 3) return { pax: 4, frt: 0 }
  if (railType === 4) return { pax: 2, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) return { pax: 15, frt: 0 }
  // SGR has priority (newest + busiest)
  if (inSgrPhase12(midLat, midLon)) return { pax: 10, frt: 20 }
  // TAZARA copper corridor
  if (inTazara(midLat, midLon)) return { pax: 3, frt: 12 }
  // Central Line (degraded)
  if (inCentralLine(midLat, midLon)) return { pax: 2, frt: 6 }
  if (usage === 1) return { pax: 0, frt: 2 }
  if (usage === 2) return { pax: 0, frt: 4 }
  return { pax: 1, frt: 4 }
}

async function main() {
  console.log(`=== TZ Railway Enrichment — Tanzanian defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  TZ-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, TZ_BBOX)) continue
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
