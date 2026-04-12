/**
 * Enrich MA railways.arrow with Moroccan defaults.
 *
 * Morocco has the most advanced rail network in Africa — **Al Boraq HSR**
 * (Africa's first and only HSR), ONCF conventional (2,295 km), two operating
 * tramway systems, and OCP phosphate heavy freight railway. But ONCF publishes
 * no GTFS/geometry; Casa Tramway has no open data.
 *
 * Use OSM rail geometry + geographic corridor bboxes.
 *
 * Moroccan rail context:
 *   - **ONCF (Office National des Chemins de Fer)** — state rail operator,
 *     2,295 km total, ~150 passenger trains/day system-wide, freight + passenger.
 *   - **Al Boraq** — **Africa's FIRST and ONLY high-speed rail** (phase 1
 *     Tangier ↔ Kenitra 186 km at 320 km/h), continuing at 160 km/h to
 *     Rabat ↔ Casablanca. Opened November 2018 by King Mohammed VI.
 *     Phase 2 extension Kenitra ↔ Marrakech planned.
 *   - **ONCF conventional**:
 *     - Casablanca ↔ Rabat ↔ Kenitra ↔ Sidi Kacem ↔ Meknes ↔ Fez ↔ Taza ↔ Oujda
 *       (eastern mainline, ~860 km)
 *     - Casablanca ↔ Settat ↔ Marrakech
 *     - Casablanca ↔ El Jadida
 *     - Casablanca ↔ Safi
 *     - Khouribga ↔ Fez/Taourirt (OCP phosphate)
 *     - Kenitra/Safi ↔ Tangier Med port (freight)
 *   - **OCP phosphate railway** — world's largest mineral railway for a
 *     single commodity (~40 Mtpa phosphate rock moved on the Khouribga ↔
 *     Jorf Lasfar ↔ Safi corridors). Owned and operated privately by OCP.
 *   - **Casa Tramway** — 2 lines operating (L1 Sidi Moumen ↔ Facultés,
 *     L2 Ain Diab ↔ Mly Rchid). Opened 2012, extended 2019. RATP Dev.
 *   - **Rabat-Salé Tramway** — 2 lines (L1 Hay Karima↔Hôpital Cheikh Zaid,
 *     L2 Harhoura↔Madinat El Irfane). Opened 2011.
 *   - **Marrakesh Metro** — planned, not built yet
 *
 * ## trains/day defaults
 *
 * | rail_type | usage | context | pax/day | frt/day |
 * |---|---|---|---:|---:|
 * | 0 (rail) | 0 (main) | **Al Boraq HSR corridor (Tangier↔Casablanca)** | 60 (HSR) + 40 (conv) | 8 |
 * | 0 (rail) | 0 (main) | Casablanca ↔ Fez ↔ Oujda | 40 | 15 |
 * | 0 (rail) | 0 (main) | Casablanca ↔ Marrakech | 30 | 10 |
 * | 0 (rail) | 0 (main) | **OCP phosphate corridor (Khouribga↔Jorf/Safi)** | 0 | 60 |
 * | 0 (rail) | 0 (main) | Other ONCF rural | 10 | 8 |
 * | 0 (rail) | 1 (branch) | - | 2 | 4 |
 * | 0 (rail) | 2 (industrial) | - | 0 | 6 |
 * | 1 (tram) | - | **Casa Tramway L1/L2** | 300 | 0 |
 * | 1 (tram) | - | **Rabat-Salé Tramway L1/L2** | 250 | 0 |
 * | 2 (light_rail) | - | - | 100 | 0 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-ma.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const MA_BBOX: [number, number, number, number] = [20.7, -17.3, 36.0, -1.0]

const EXCLUDE_ZONES: Array<{ bbox: [number, number, number, number] }> = [
  { bbox: [20.7, -1.5, 36.0, -1.0] },   // Algeria E
  { bbox: [20.7, -17.3, 21.5, -4.8] },  // Mauritania S
]

// Al Boraq HSR / Tangier-Casablanca mainline corridor
const ATLANTIC_MAIN_BBOX: [number, number, number, number] = [33.40, -8.10, 35.90, -5.70]

// Casablanca ↔ Fez ↔ Oujda eastern mainline
const EASTERN_MAIN_BBOX: [number, number, number, number] = [33.40, -8.10, 35.00, -1.80]

// Casablanca ↔ Marrakech
const SOUTH_MAIN_BBOX: [number, number, number, number] = [31.55, -8.10, 33.80, -7.50]

// OCP phosphate railway corridor (Khouribga ↔ Jorf Lasfar / Safi)
const OCP_BBOX: [number, number, number, number] = [31.90, -9.50, 33.30, -7.00]

// Casablanca tram
const CASA_TRAM_BBOX: [number, number, number, number] = [33.50, -7.70, 33.65, -7.50]

// Rabat-Salé tram
const RABAT_TRAM_BBOX: [number, number, number, number] = [33.95, -6.95, 34.05, -6.75]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExclusion(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function inAtlanticMain(lat: number, lon: number): boolean { return inBbox(lat, lon, ATLANTIC_MAIN_BBOX) }
function inEasternMain(lat: number, lon: number): boolean { return inBbox(lat, lon, EASTERN_MAIN_BBOX) }
function inSouthMain(lat: number, lon: number): boolean { return inBbox(lat, lon, SOUTH_MAIN_BBOX) }
function inOCP(lat: number, lon: number): boolean { return inBbox(lat, lon, OCP_BBOX) }
function inCasaTram(lat: number, lon: number): boolean { return inBbox(lat, lon, CASA_TRAM_BBOX) }
function inRabatTram(lat: number, lon: number): boolean { return inBbox(lat, lon, RABAT_TRAM_BBOX) }

function defaultTrains(
  railType: number, usage: number, highspeed: boolean,
  midLat: number, midLon: number,
): { pax: number; frt: number } {
  if (railType === 2) return { pax: 100, frt: 0 }
  if (railType === 1) {
    // tram — Casa Tramway / Rabat-Salé Tramway
    if (inCasaTram(midLat, midLon)) return { pax: 300, frt: 0 }
    if (inRabatTram(midLat, midLon)) return { pax: 250, frt: 0 }
    return { pax: 80, frt: 0 }
  }
  if (railType === 3) return { pax: 6, frt: 0 }
  if (railType === 4) return { pax: 4, frt: 0 }
  // rail_type=0 heavy rail
  if (highspeed) {
    // Al Boraq — Africa's first HSR
    return { pax: 60, frt: 0 }
  }
  // OCP phosphate corridor (heavy freight)
  if (inOCP(midLat, midLon)) return { pax: 0, frt: 60 }
  // Atlantic mainline (Al Boraq conventional parallel + freight)
  if (inAtlanticMain(midLat, midLon)) return { pax: 40, frt: 8 }
  // Eastern mainline (Casa ↔ Fez ↔ Oujda)
  if (inEasternMain(midLat, midLon)) return { pax: 40, frt: 15 }
  // South mainline (Casa ↔ Marrakech)
  if (inSouthMain(midLat, midLon)) return { pax: 30, frt: 10 }
  if (usage === 1) return { pax: 2, frt: 4 }
  if (usage === 2) return { pax: 0, frt: 6 }
  return { pax: 10, frt: 8 }
}

async function main() {
  console.log(`=== MA Railway Enrichment — Moroccan defaults (${YEAR}) ===\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, MA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) {
        hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  MA-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, MA_BBOX)) continue
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
