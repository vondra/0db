/**
 * Enrich DZ railways.arrow with Algerian rail corridor defaults.
 *
 * Algeria has North Africa's 2nd-largest rail network (~4,200 km SNTF)
 * plus 6 operating tramways and Algiers Metro.
 *
 * 1. **Algiers Metro** — Line 1 opened **November 2011**, first metro in
 *    North Africa after Cairo (1987) and Tunis Métro léger (1985). 18.5 km,
 *    19 stations (extensions to airport planned). Standard gauge, electrified
 *    750V DC third rail. Operated by EMA (Entreprise du Métro d'Alger) /
 *    RATP El Djazaïr.
 *
 * 2. **Urban tramways** — 6 operating systems, all opened 2011-2023:
 *    - **Algiers Tramway** (2011, 23 km, 3 lines, ~110k daily riders)
 *    - **Oran Tramway** (2013, 18 km)
 *    - **Constantine Tramway** (2013, 8 km, plus Constantine cable car Télépherique)
 *    - **Sidi Bel Abbès Tramway** (2017, 14 km)
 *    - **Ouargla Tramway** (2018, 10 km — southernmost tramway in Africa)
 *    - **Mostaganem Tramway** (2023, 14 km)
 *    - **Sétif Tramway** (2018, 15 km)
 *    Plus **Annaba Tramway** planned/opened (2023, Bejaia planned)
 *
 * 3. **SNTF (Société Nationale des Transports Ferroviaires)** — national rail:
 *    - **Northern main line**: Oran ↔ Relizane ↔ Chlef ↔ Algiers ↔ Béjaïa ↔
 *      Annaba ↔ Tunisian border (electrified 25 kV AC on parts — Africa's
 *      longest electrified rail section)
 *    - **Algiers ↔ Constantine ↔ Annaba** — main east branch
 *    - **Algiers ↔ Blida ↔ Chlef ↔ Oran** — main west branch
 *    - **Commuter rail Algiers**: Banlieue trains to El Affroun, Zéralda,
 *      Thenia, Dar El Beïda (airport)
 *    - **Oran ↔ Tlemcen ↔ Moroccan border** (via Maghnia — border closed
 *      since 1994)
 *    - **Hauts Plateaux** north-south links: Constantine ↔ Biskra ↔
 *      Touggourt, Tébessa/El Aouinet
 *    - **Phosphate line**: Tébessa ↔ Annaba port (Djebel Onk)
 *
 * 4. **Mining corridors**:
 *    - **Tébessa (Djebel Onk) ↔ Annaba** — phosphate freight
 *    - **Iron ore Ouenza ↔ Annaba** (El Hadjar steel)
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Algiers Metro (2011)** | 150 | 0 |
 *   | **Algiers Tramway (2011)** | 80 | 0 |
 *   | **Oran Tramway (2013)** | 60 | 0 |
 *   | **Other tramways** (Constantine/SBA/Ouargla/Mostaganem/Sétif) | 40 | 0 |
 *   | **Northern main line** (Oran-Algiers-Annaba) | 15 | 12 |
 *   | **Tébessa-Annaba phosphate + iron** | 1 | 18 |
 *   | Other/branch | 1 | 3 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-dz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('dz-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const DZ_BBOX: [number, number, number, number] = [18.9, -8.7, 37.1, 12.0]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Morocco W',     bbox: [27.0, -8.7, 37.1, -2.0] },
  { name: 'W Sahara',      bbox: [22.0, -8.7, 27.0, -3.0] },
  { name: 'Mauritania SW', bbox: [18.9, -8.7, 22.0, -4.5] },
  { name: 'Mali S',        bbox: [18.9, -4.5, 25.0, 4.2] },
  { name: 'Niger SE',      bbox: [18.9, 4.2, 23.5, 12.0] },
  { name: 'Libya E',       bbox: [18.9, 10.0, 33.0, 12.0] },
  { name: 'Tunisia NE',    bbox: [33.0, 8.3, 37.1, 12.0] },
]

// Algiers Metro Line 1 — Haï El-Badr to Place des Martyrs (core Algiers)
const ALGIERS_METRO: [number, number, number, number] = [36.72, 3.03, 36.80, 3.13]
// Algiers Tramway — eastern Algiers, Ruisseau to Dergana
const ALGIERS_TRAM: [number, number, number, number] = [36.71, 3.08, 36.80, 3.28]

// Oran Tramway — central Oran
const ORAN_TRAM: [number, number, number, number] = [35.67, -0.68, 35.75, -0.55]

// Constantine Tramway — downtown
const CONSTANTINE_TRAM: [number, number, number, number] = [36.34, 6.60, 36.40, 6.70]

// Sidi Bel Abbès Tramway
const SBA_TRAM: [number, number, number, number] = [35.18, -0.66, 35.21, -0.60]

// Ouargla Tramway
const OUARGLA_TRAM: [number, number, number, number] = [31.93, 5.30, 31.97, 5.35]

// Mostaganem Tramway
const MOSTAGANEM_TRAM: [number, number, number, number] = [35.92, 0.06, 35.95, 0.12]

// Sétif Tramway
const SETIF_TRAM: [number, number, number, number] = [36.17, 5.39, 36.20, 5.43]

// Northern SNTF main line — Oran ↔ Algiers ↔ Constantine ↔ Annaba ↔ Tunisian border
// Approximated by coastal strip
const NORTH_MAIN: [number, number, number, number] = [35.0, -1.5, 36.95, 8.5]

// Tébessa/Ouenza ↔ Annaba phosphate+iron freight corridor (eastern interior)
const PHOSPHATE_CORRIDOR: [number, number, number, number] = [35.3, 7.3, 36.95, 8.3]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, ALGIERS_METRO)) return { pax: 150, frt: 0, zone: 'Algiers Metro' }
  if (inBbox(lat, lon, ALGIERS_TRAM)) return { pax: 80, frt: 0, zone: 'Algiers Tram' }
  if (inBbox(lat, lon, ORAN_TRAM)) return { pax: 60, frt: 0, zone: 'Oran Tram' }
  if (inBbox(lat, lon, CONSTANTINE_TRAM)) return { pax: 40, frt: 0, zone: 'Constantine Tram' }
  if (inBbox(lat, lon, SBA_TRAM)) return { pax: 40, frt: 0, zone: 'SBA Tram' }
  if (inBbox(lat, lon, OUARGLA_TRAM)) return { pax: 40, frt: 0, zone: 'Ouargla Tram' }
  if (inBbox(lat, lon, MOSTAGANEM_TRAM)) return { pax: 40, frt: 0, zone: 'Mostaganem Tram' }
  if (inBbox(lat, lon, SETIF_TRAM)) return { pax: 40, frt: 0, zone: 'Sétif Tram' }
  if (inBbox(lat, lon, PHOSPHATE_CORRIDOR)) return { pax: 1, frt: 18, zone: 'Tébessa phosphate' }
  if (inBbox(lat, lon, NORTH_MAIN)) return { pax: 15, frt: 12, zone: 'Northern main' }
  return { pax: 1, frt: 3, zone: 'other' }
}

async function main() {
  console.log(`=== DZ Railway Enrichment — Algerian corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: SNTF publishes no GTFS. Algiers Metro + 7 tramways + SNTF mainlines.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, DZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  DZ-bbox hexes with railways.arrow: ${hexDirs.length}`)

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

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, DZ_BBOX)) continue
      if (inAnyExclude(midLat, midLon)) { excluded++; continue }

      const c = classifyRail(midLat, midLon)
      pax[i] = c.pax
      frt[i] = c.frt
      datasetId[i] = MY_DATASET_ID
      zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1
      hexMatched++
      matched++
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
    console.log(`    ${z.padEnd(22)} ${c.toLocaleString()}`)
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
