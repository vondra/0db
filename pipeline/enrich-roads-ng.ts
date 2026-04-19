/**
 * Enrich NG roads.arrow with Nigerian CNOSSOS class defaults.
 *
 * FERMA, FMW, FRSC publish no open GIS. Fall back to class defaults with
 * aggressive Lagos Tier-1 boost (Lagos is Africa's largest city, ~22M) +
 * Lagos-Ibadan container freight corridor + high motorcycle share.
 *
 * ## Nigerian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (A1/A2 expressway) | 35,000 | 87,500 | 49,000 |
 *   | 1 trunk (Federal A-route)     | 12,000 | 30,000 | 16,800 |
 *   | 2 primary                      |  6,000 | 15,000 |  8,400 |
 *   | 3 secondary                    |  3,000 |  7,500 |  4,200 |
 *   | 4 tertiary                     |  1,500 |  3,750 |  2,100 |
 *   | 5 residential                  |    700 |  1,750 |    980 |
 *
 * **Lagos uses ×2.5 multiplier** (same as Cairo) to reflect its exceptional
 * density. Lagos is Africa's largest city with 22M+ people, extreme traffic
 * gridlock on Lagos-Ibadan Expressway, Third Mainland Bridge, Apapa-Oshodi.
 *
 * ## Nigerian vehicle split
 *
 * **Very high motorcycle share** (~30-40% — "okada" motorcycle taxis and
 * tricycle "keke napep" dominate urban transport, especially in Kano and
 * northern cities). Heavy share extreme on Lagos-Ibadan Expressway
 * (container freight from Apapa port).
 *
 *   Tier-1 (Lagos): light 45% / medium 5% / heavy 15% / moto 35%
 *   Tier-2:         light 45% / medium 6% / heavy 14% / moto 35%
 *   Rural:          light 50% / medium 8% / heavy 22% / moto 20%
 *   **Lagos-Ibadan / Apapa container corridor**: light 35% / medium 5% / heavy 45% / moto 15%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ng.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ng-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const NG_BBOX: [number, number, number, number] = [4.0, 2.7, 13.9, 14.7]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Benin W', bbox: [6.0, 2.7, 12.5, 3.5] },
  { name: 'Niger N', bbox: [13.0, 2.7, 13.9, 14.0] },
  { name: 'Chad NE', bbox: [11.5, 13.5, 13.9, 14.7] },
  { name: 'Cameroon E', bbox: [4.0, 13.0, 11.0, 14.7] },
]

// Tier-1 cities (×2.5 for Lagos like Cairo; 2.0 for others)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number]; mult: number }> = [
  { name: 'Greater Lagos', bbox: [6.35, 3.20, 6.75, 3.75], mult: 2.5 },
  { name: 'Kano', bbox: [11.90, 8.40, 12.10, 8.70], mult: 2.0 },
  { name: 'Abuja (FCT)', bbox: [8.95, 7.20, 9.20, 7.60], mult: 2.0 },
  { name: 'Ibadan', bbox: [7.30, 3.80, 7.45, 3.98], mult: 2.0 },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Port Harcourt', bbox: [4.75, 6.95, 4.90, 7.08] },
  { name: 'Benin City', bbox: [6.30, 5.57, 6.40, 5.67] },
  { name: 'Kaduna', bbox: [10.48, 7.35, 10.58, 7.48] },
  { name: 'Jos', bbox: [9.87, 8.85, 9.97, 8.95] },
  { name: 'Maiduguri', bbox: [11.82, 13.10, 11.90, 13.20] },
  { name: 'Enugu', bbox: [6.42, 7.48, 6.50, 7.56] },
  { name: 'Onitsha', bbox: [6.13, 6.77, 6.20, 6.85] },
  { name: 'Aba', bbox: [5.08, 7.32, 5.17, 7.40] },
  { name: 'Ilorin', bbox: [8.47, 4.52, 8.55, 4.60] },
  { name: 'Abeokuta', bbox: [7.13, 3.33, 7.20, 3.42] },
  { name: 'Zaria', bbox: [11.07, 7.68, 11.13, 7.75] },
  { name: 'Warri', bbox: [5.49, 5.72, 5.55, 5.80] },
  { name: 'Sokoto', bbox: [13.05, 5.22, 13.10, 5.28] },
  { name: 'Oyo', bbox: [7.84, 3.92, 7.88, 3.97] },
  { name: 'Akure', bbox: [7.23, 5.18, 7.28, 5.25] },
  { name: 'Bauchi', bbox: [10.30, 9.83, 10.35, 9.88] },
  { name: 'Calabar', bbox: [4.93, 8.30, 5.00, 8.36] },
  { name: 'Ogbomosho', bbox: [8.10, 4.22, 8.17, 4.28] },
  { name: 'Osogbo', bbox: [7.75, 4.55, 7.80, 4.60] },
  { name: 'Lokoja', bbox: [7.78, 6.73, 7.83, 6.78] },
]

// Lagos-Ibadan / Apapa container freight corridor (Africa's busiest)
const LAGOS_IBADAN_BBOX: [number, number, number, number] = [6.40, 3.25, 7.45, 4.10]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function cityTier1Mult(lat: number, lon: number): number | null {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return c.mult
  return null
}
function inTier2(lat: number, lon: number): boolean {
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return true
  return false
}
function inLagosIbadan(lat: number, lon: number): boolean {
  return inBbox(lat, lon, LAGOS_IBADAN_BBOX)
}

const CLASS_AADT: Record<number, number> = {
  0: 35000, 1: 12000, 2: 6000, 3: 3000, 4: 1500, 5: 700, 6: 300,
}

function splitVehicles(aadt: number, tier: 'tier1_lagos' | 'tier1_other' | 'tier2' | 'rural' | 'lagos_ibadan'): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 'lagos_ibadan') {
    return {
      light: Math.round(aadt * 0.35),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.45),
      moto: Math.round(aadt * 0.15),
    }
  }
  if (tier === 'tier1_lagos' || tier === 'tier1_other') {
    return {
      light: Math.round(aadt * 0.45),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.15),
      moto: Math.round(aadt * 0.35),
    }
  }
  if (tier === 'tier2') {
    return {
      light: Math.round(aadt * 0.45),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.14),
      moto: Math.round(aadt * 0.35),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.50),
    medium: Math.round(aadt * 0.08),
    heavy: Math.round(aadt * 0.22),
    moto: Math.round(aadt * 0.20),
  }
}

async function main() {
  console.log(`=== NG Roads Enrichment — Nigerian CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: FERMA/FMW publish no open road data. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, NG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  NG-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
    const existingDatasetId = table.getChild('roads_dataset_id')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    const trafficSource = new Uint8Array(n)
    const datasetId = new Uint16Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trafficSource[i] = (existingSource?.get(i) as number) ?? 0
      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, NG_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const cls = (roadClass.get(i) as number) ?? 5
      const tier1Mult = cityTier1Mult(midLat, midLon)
      let mult: number
      let tierKey: 'tier1_lagos' | 'tier1_other' | 'tier2' | 'rural' | 'lagos_ibadan'
      if (tier1Mult !== null) {
        mult = tier1Mult
        tierKey = tier1Mult === 2.5 ? 'tier1_lagos' : 'tier1_other'
      } else if (inTier2(midLat, midLon)) {
        mult = 1.4
        tierKey = 'tier2'
      } else {
        mult = 1.0
        tierKey = 'rural'
      }

      // Override for Lagos-Ibadan freight corridor (outside Lagos bbox)
      if (!tier1Mult && inLagosIbadan(midLat, midLon) && cls <= 2) {
        tierKey = 'lagos_ibadan'
        mult = 1.8  // between rural and tier-1
      }

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tierKey)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      trafficSource[i] = 1
      datasetId[i] = MY_DATASET_ID
      hexMatched++
      matched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'roads_dataset_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())

      columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())
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
