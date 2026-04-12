/**
 * Enrich TZ roads.arrow with Tanzanian CNOSSOS class defaults.
 *
 * TANROADS and TARURA (Tanzania Rural and Urban Roads Agency) publish no
 * open GIS. Fall back to class defaults with Dar es Salaam Tier-1 boost.
 *
 * ## Tanzanian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (TANZAM/TanZam, Mbezi Beach Expressway) | 25,000 | 50,000 | 35,000 |
 *   | 1 trunk (T-route paved)             | 10,000 | 20,000 | 14,000 |
 *   | 2 primary                            |  5,000 | 10,000 |  7,000 |
 *   | 3 secondary                          |  2,500 |  5,000 |  3,500 |
 *   | 4 tertiary                           |  1,200 |  2,400 |  1,680 |
 *   | 5 residential                        |    600 |  1,200 |    840 |
 *
 * ## Tanzanian vehicle split
 *
 * High boda-boda (motorcycle taxi) share + daladala (minibus) share in
 * cities. Similar pattern to Kenya.
 *
 *   Tier-1 (Dar es Salaam): light 50% / medium 15% / heavy 10% / moto 25%
 *   Tier-2: light 52% / medium 13% / heavy 12% / moto 23%
 *   Rural: light 55% / medium 10% / heavy 20% / moto 15%
 *   **TAZAM/TANZAM corridor (copper freight)**: light 42% / medium 8% / heavy 40% / moto 10%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-tz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const TZ_BBOX: [number, number, number, number] = [-11.8, 29.3, -0.9, 40.5]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Kenya N', bbox: [-1.6, 33.9, -0.9, 41.9] },
  { name: 'Uganda NW', bbox: [-1.5, 29.5, -0.9, 35.0] },
  { name: 'Rwanda W', bbox: [-2.9, 28.8, -1.0, 30.9] },
  { name: 'Burundi W', bbox: [-4.5, 29.0, -2.3, 30.9] },
  { name: 'DRC W', bbox: [-11.8, 29.0, -2.0, 29.4] },
  { name: 'Zambia SW', bbox: [-11.8, 29.0, -8.2, 33.0] },
  { name: 'Malawi S', bbox: [-11.8, 32.7, -9.4, 34.6] },
  { name: 'Mozambique S', bbox: [-11.8, 34.6, -10.2, 40.5] },
]

// Tier-1 cities (×2.0) — Dar es Salaam only (Tanzania's largest city by far)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Dar es Salaam', bbox: [-7.00, 39.15, -6.70, 39.40] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Dodoma', bbox: [-6.20, 35.70, -6.13, 35.78] },
  { name: 'Mwanza', bbox: [-2.55, 32.87, -2.48, 32.95] },
  { name: 'Arusha', bbox: [-3.40, 36.65, -3.33, 36.72] },
  { name: 'Mbeya', bbox: [-8.93, 33.42, -8.87, 33.50] },
  { name: 'Morogoro', bbox: [-6.85, 37.65, -6.78, 37.72] },
  { name: 'Tanga', bbox: [-5.10, 39.07, -5.02, 39.13] },
  { name: 'Kahama', bbox: [-3.83, 32.57, -3.77, 32.63] },
  { name: 'Tabora', bbox: [-5.05, 32.78, -4.98, 32.85] },
  { name: 'Zanzibar City', bbox: [-6.18, 39.17, -6.12, 39.23] },
  { name: 'Kigoma', bbox: [-4.90, 29.60, -4.83, 29.68] },
  { name: 'Sumbawanga', bbox: [-7.98, 31.58, -7.92, 31.65] },
  { name: 'Kasulu', bbox: [-4.60, 30.08, -4.53, 30.13] },
  { name: 'Songea', bbox: [-10.70, 35.60, -10.63, 35.68] },
  { name: 'Musoma', bbox: [-1.52, 33.77, -1.47, 33.83] },
  { name: 'Iringa', bbox: [-7.78, 35.67, -7.72, 35.73] },
  { name: 'Singida', bbox: [-4.83, 34.72, -4.77, 34.78] },
  { name: 'Shinyanga', bbox: [-3.68, 33.40, -3.62, 33.47] },
  { name: 'Moshi', bbox: [-3.37, 37.32, -3.32, 37.38] },
  { name: 'Bukoba', bbox: [-1.35, 31.80, -1.30, 31.85] },
]

// TANZAM corridor — Dar es Salaam ↔ Mbeya ↔ Zambia border (copper freight
// route parallel to TAZARA railway)
const TANZAM_BBOX: [number, number, number, number] = [-11.00, 31.50, -6.80, 39.50]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function cityTier(lat: number, lon: number): 0 | 1 | 2 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}
function inTanzam(lat: number, lon: number): boolean {
  return inBbox(lat, lon, TANZAM_BBOX)
}

const CLASS_AADT: Record<number, number> = {
  0: 25000, 1: 10000, 2: 5000, 3: 2500, 4: 1200, 5: 600, 6: 250,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, tanzam: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.50),
      medium: Math.round(aadt * 0.15),  // daladalas
      heavy: Math.round(aadt * 0.10),
      moto: Math.round(aadt * 0.25),    // boda bodas
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.52),
      medium: Math.round(aadt * 0.13),
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.23),
    }
  }
  if (tanzam) {
    return {
      light: Math.round(aadt * 0.42),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.40),
      moto: Math.round(aadt * 0.10),
    }
  }
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.20),
    moto: Math.round(aadt * 0.15),
  }
}

async function main() {
  console.log(`=== TZ Roads Enrichment — Tanzanian CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: TANROADS/TARURA publish no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TZ-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let matched = 0, hexesUpdated = 0

  for (const hex of hexDirs) {
    const roadPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(roadPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const roadClass = table.getChild('road_class')!

    const existingSource = table.getChild('traffic_source')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    const trafficSource = new Uint8Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trafficSource[i] = (existingSource?.get(i) as number) ?? 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (trafficSource[i] > 0) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, TZ_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const tanzam = tier === 0 && inTanzam(midLat, midLon)

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, tanzam)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      trafficSource[i] = 1
      hexMatched++
      matched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
      const newTable = makeTable(columns)
      writeFileSync(roadPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:        ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip):    ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matched.toLocaleString()}`)
  console.log(`  Total enriched:             ${matched.toLocaleString()} (${(100 * matched / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
