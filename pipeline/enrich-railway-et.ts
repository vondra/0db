/**
 * Enrich ET railways.arrow with Ethiopian defaults.
 *
 * Ethiopian rail context:
 *   - **Addis Ababa-Djibouti Railway (EDR)** — 752 km electrified standard
 *     gauge (25 kV AC), opened January 2018. Built by CCCC + CREC + China
 *     Railway Group for US$4 billion. Connects landlocked Ethiopia's Addis
 *     Ababa to Djibouti port (Doraleh) via Dire Dawa. Primary freight + some
 *     passenger (Addis ↔ Dire Dawa ↔ Djibouti). Replaced the colonial
 *     1,000 mm metre-gauge Ethio-Djibouti Railway which was abandoned.
 *     **Africa's first fully electrified international cross-border railway.**
 *   - **Awash-Kombolcha-Weldiya Railway (AKR)** — 390 km standard gauge
 *     (under construction, partially open 2022+) — Awash junction (on
 *     Addis-Djibouti line) to Weldiya via Kombolcha, eventually extending
 *     to Tadjoura (Djibouti) as second outlet.
 *   - **Addis Ababa Light Rail Transit (AALRT)** — **Africa's first light
 *     rail metro**, opened September 2015. 2 lines:
 *       East-West Line (Ayat ↔ Tor Hailoch)
 *       North-South Line (Menelik II Square ↔ Kality)
 *     ~32 km total. Built by China Railway Engineering Corp, operated by
 *     SOE with Shenzhen Metro initially.
 *   - **No other operational rail** — colonial Ethio-Djibouti metre gauge
 *     was fully dismantled by 2017.
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **Addis-Djibouti EDR (2018)** | 4 | 16 |
 * | 0 (rail) | 0 (main) | **Awash-Weldiya AKR** | 2 | 8 |
 * | 0 (rail) | 0 (main) | Other (legacy defunct) | 0 | 2 |
 * | 0 (rail) | 1 (branch) | - | 0 | 2 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 4 |
 * | 2 (light_rail) | - | **Addis Ababa LRT (Africa's first, 2015)** | 200 | 0 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-et.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const ET_BBOX: [number, number, number, number] = [3.4, 33.0, 14.9, 48.0]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [3.4, 33.0, 14.9, 35.0] },    // Sudan W
  { bbox: [3.4, 33.0, 5.5, 36.0] },     // South Sudan SW
  { bbox: [3.4, 36.0, 5.0, 42.0] },     // Kenya S
  { bbox: [3.4, 42.0, 12.0, 48.0] },    // Somalia E
  { bbox: [10.9, 41.7, 12.7, 43.3] },   // Djibouti NE
  { bbox: [14.3, 36.0, 14.9, 43.3] },   // Eritrea N
]

// Greater Addis Ababa (AALRT operates here)
const ADDIS_BBOX: [number, number, number, number] = [8.90, 38.60, 9.10, 38.90]

// Addis Ababa ↔ Djibouti EDR corridor
const EDR_BBOX: [number, number, number, number] = [8.80, 38.60, 11.70, 43.20]

// Awash-Weldiya AKR corridor
const AKR_BBOX: [number, number, number, number] = [8.80, 39.70, 11.90, 40.30]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inAddis(lat: number, lon: number): boolean { return inBbox(lat, lon, ADDIS_BBOX) }
function inEdr(lat: number, lon: number): boolean { return inBbox(lat, lon, EDR_BBOX) }
function inAkr(lat: number, lon: number): boolean { return inBbox(lat, lon, AKR_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) {
    // light_rail — AALRT (Africa's first, 2015)
    if (inAddis(midLat, midLon)) return { pax: 200, frt: 0 }
    return { pax: 60, frt: 0 }
  }
  if (railType === 1) return { pax: 30, frt: 0 }
  if (railType === 3) return { pax: 4, frt: 0 }
  if (railType === 4) return { pax: 2, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) return { pax: 15, frt: 0 }
  if (inEdr(midLat, midLon)) return { pax: 4, frt: 16 }
  if (inAkr(midLat, midLon)) return { pax: 2, frt: 8 }
  if (usage === 1) return { pax: 0, frt: 2 }
  if (usage === 2) return { pax: 0, frt: 4 }
  return { pax: 0, frt: 2 }
}

async function main() {
  console.log(`=== ET Railway Enrichment — Ethiopian defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, ET_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  ET-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, ET_BBOX)) continue
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
