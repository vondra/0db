/**
 * Enrich MA roads.arrow with Moroccan CNOSSOS class defaults.
 *
 * All Moroccan gov portals are dead or TCP-blocked. ADM publishes no
 * traffic data. data.gov.ma is Drupal/tabular without GIS. Fall back to
 * class defaults with Tier-1/Tier-2 city boosts.
 *
 * ## Moroccan AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (A-autoroute toll) | 30,000 | 60,000 | 42,000 |
 *   | 1 trunk (RN paved)             | 12,000 | 24,000 | 16,800 |
 *   | 2 primary                       |  6,000 | 12,000 |  8,400 |
 *   | 3 secondary                     |  3,000 |  6,000 |  4,200 |
 *   | 4 tertiary                      |  1,500 |  3,000 |  2,100 |
 *   | 5 residential                   |    700 |  1,400 |    980 |
 *
 * ## Moroccan vehicle split
 *
 * Moderate motorcycle share (~15-20% urban). Heavy share on phosphate
 * corridors + Atlantic container freight (Tangier Med port, Casablanca,
 * Jorf Lasfar, Safi).
 *
 *   Tier-1 (Casablanca/Rabat/Fez/Marrakech/Tangier): light 65% / medium 6% / heavy 12% / moto 17%
 *   Tier-2: light 65% / medium 8% / heavy 12% / moto 15%
 *   Rural: light 62% / medium 8% / heavy 20% / moto 10%
 *   **Phosphate corridor (Khouribga/Jorf/Safi)**: light 50% / medium 8% / heavy 35% / moto 7%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ma.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ma-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const MA_BBOX: [number, number, number, number] = [20.7, -17.3, 36.0, -1.0]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Algeria E', bbox: [20.7, -1.5, 36.0, -1.0] },
  { name: 'Mauritania S', bbox: [20.7, -17.3, 21.5, -4.8] },
]

// Tier-1 cities (×2.0, 5 metros)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Casablanca', bbox: [33.45, -7.75, 33.70, -7.45] },
  { name: 'Rabat', bbox: [33.95, -6.95, 34.10, -6.75] },
  { name: 'Marrakech', bbox: [31.55, -8.10, 31.72, -7.90] },
  { name: 'Fez', bbox: [33.95, -5.05, 34.08, -4.90] },
  { name: 'Tangier', bbox: [35.70, -5.88, 35.82, -5.72] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Meknes', bbox: [33.85, -5.60, 33.95, -5.48] },
  { name: 'Oujda', bbox: [34.65, -1.95, 34.75, -1.85] },
  { name: 'Kenitra', bbox: [34.23, -6.62, 34.33, -6.52] },
  { name: 'Tetouan', bbox: [35.53, -5.42, 35.60, -5.33] },
  { name: 'Salé', bbox: [34.03, -6.85, 34.10, -6.75] },
  { name: 'Agadir', bbox: [30.40, -9.65, 30.48, -9.55] },
  { name: 'Nador', bbox: [35.15, -2.97, 35.22, -2.90] },
  { name: 'Safi', bbox: [32.28, -9.27, 32.33, -9.20] },
  { name: 'El Jadida', bbox: [33.22, -8.55, 33.28, -8.48] },
  { name: 'Khouribga', bbox: [32.85, -6.95, 32.92, -6.88] },
  { name: 'Béni Mellal', bbox: [32.32, -6.40, 32.38, -6.32] },
  { name: 'Taza', bbox: [34.20, -4.03, 34.25, -3.97] },
  { name: 'Khemisset', bbox: [33.80, -6.10, 33.85, -6.02] },
  { name: 'Laâyoune', bbox: [27.12, -13.25, 27.18, -13.15] },
  { name: 'Mohammedia', bbox: [33.68, -7.42, 33.75, -7.33] },
  { name: 'Settat', bbox: [32.98, -7.65, 33.05, -7.58] },
  { name: 'Larache', bbox: [35.17, -6.18, 35.22, -6.12] },
  { name: 'Ouarzazate', bbox: [30.90, -6.93, 30.95, -6.87] },
  { name: 'Taourirt', bbox: [34.38, -2.92, 34.43, -2.85] },
  { name: 'Essaouira', bbox: [31.48, -9.80, 31.55, -9.73] },
]

// Phosphate corridor — extreme HGV share (OCP)
const PHOSPHATE_BBOX: [number, number, number, number] = [31.90, -9.50, 33.30, -7.00]

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
function inPhosphate(lat: number, lon: number): boolean {
  return inBbox(lat, lon, PHOSPHATE_BBOX)
}

const CLASS_AADT: Record<number, number> = {
  0: 30000, 1: 12000, 2: 6000, 3: 3000, 4: 1500, 5: 700, 6: 300,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, phosphate: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.17),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.15),
    }
  }
  if (phosphate) {
    return {
      light: Math.round(aadt * 0.50),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.35),
      moto: Math.round(aadt * 0.07),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.62),
    medium: Math.round(aadt * 0.08),
    heavy: Math.round(aadt * 0.20),
    moto: Math.round(aadt * 0.10),
  }
}

async function main() {
  console.log(`=== MA Roads Enrichment — Moroccan CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: ADM/DR publish no open road data. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, MA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  MA-bbox hexes with roads.arrow: ${hexDirs.length}`)

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

      if (!inBbox(midLat, midLon, MA_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const phosphate = inPhosphate(midLat, midLon)

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, phosphate && tier === 0)
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
