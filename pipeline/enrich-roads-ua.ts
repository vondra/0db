/**
 * Enrich UA roads.arrow with Ukraine CNOSSOS class defaults.
 *
 * NOTE: Ukraine has been under Russian invasion since February 2022.
 * This enrichment represents **pre-war baseline** data.
 * Actual conditions in occupied/frontline areas are drastically different.
 * Several Tier-2/3 cities are occupied, frontline, or heavily damaged.
 *
 * No open national AADT from Ukravtodor. Fall back to class defaults
 * with city tier boosts. Ukraine road network: ~170,000 km total.
 * Key routes: M-06 Kyiv–Chop (E50, westward to Poland/EU),
 * M-03 Kyiv–Kharkiv (NE corridor to frontline), M-01 Kyiv–Boryspil,
 * M-05 Kyiv–Odesa (south).
 *
 * Vehicle split: European post-Soviet pattern — moderate car ownership,
 * very low motorcycle share. High HGV share on trunk/primary due to
 * grain and industrial freight.
 *
 * ## Ukraine AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.6) | Tier-3 (×1.3) |
 *   |---|---:|---:|---:|---:|
 *   | 0 motorway (M-06 Kyiv-Chop, M-03 Kyiv-Kharkiv) | 28,000 | 56,000 | 44,800 | 36,400 |
 *   | 1 trunk | 14,000 | 28,000 | 22,400 | 18,200 |
 *   | 2 primary | 7,000 | 14,000 | 11,200 | 9,100 |
 *   | 3 secondary | 3,500 | 7,000 | 5,600 | 4,550 |
 *   | 4 tertiary | 1,500 | 3,000 | 2,400 | 1,950 |
 *   | 5 residential | 600 | 1,200 | 960 | 780 |
 *
 * ## Ukraine vehicle split
 *
 *   Tier-1 Kyiv (~3M — capital, Dnipro River, Saint Sophia/Pechersk Lavra UNESCO):
 *     light 70% / medium 6% / heavy 18% / moto 6%
 *
 *   Tier-2 (Kharkiv/Odesa/Dnipro/Lviv/Zaporizhzhia/Donetsk):
 *     light 68% / medium 5% / heavy 22% / moto 5%
 *
 *   Rural:
 *     light 58% / medium 3% / heavy 35% / moto 4%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ua.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ua-national-roads')!.id

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

// Tier-1 (×2.0): Kyiv — capital, ~3M
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Kyiv',          bbox: [50.27, 30.25, 50.59, 30.82] },
]

// Tier-2 (×1.6): major cities
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Kharkiv',       bbox: [49.88, 36.15, 50.08, 36.40] },   // 2nd city, frontline
  { name: 'Odesa',         bbox: [46.37, 30.67, 46.52, 30.88] },   // Black Sea port, UNESCO
  { name: 'Dnipro',        bbox: [48.38, 34.91, 48.54, 35.12] },   // central, river city
  { name: 'Lviv',          bbox: [49.79, 23.92, 49.90, 24.08] },   // western, refugee hub
  { name: 'Zaporizhzhia',  bbox: [47.77, 35.07, 47.91, 35.22] },   // frontline, nuclear
  { name: 'Donetsk',       bbox: [47.96, 37.71, 48.07, 37.88] },   // occupied since 2014
]

// Tier-3 (×1.3): regional cities
const TIER3_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Mykolaiv',       bbox: [46.93, 31.93, 47.02, 32.06] },  // frontline, damaged
  { name: 'Vinnytsia',      bbox: [49.19, 28.43, 49.26, 28.52] },
  { name: 'Poltava',        bbox: [49.56, 34.51, 49.63, 34.61] },
  { name: 'Chernihiv',      bbox: [51.46, 31.26, 51.54, 31.34] },  // 2022 siege
  { name: 'Zhytomyr',       bbox: [50.24, 28.60, 50.29, 28.70] },
  { name: 'Sumy',           bbox: [50.89, 34.77, 50.96, 34.87] },  // 2022 siege
  { name: 'Khmelnytskyi',   bbox: [49.41, 26.95, 49.48, 27.04] },
  { name: 'Cherkasy',       bbox: [49.43, 32.04, 49.50, 32.12] },
  { name: 'Ivano-Frankivsk',bbox: [48.91, 24.69, 48.96, 24.77] },
  { name: 'Ternopil',       bbox: [49.54, 25.57, 49.60, 25.65] },
  { name: 'Rivne',          bbox: [50.60, 26.23, 50.66, 26.31] },
  { name: 'Uzhhorod',       bbox: [48.60, 22.27, 48.65, 22.34] },
  { name: 'Lutsk',          bbox: [50.73, 25.31, 50.78, 25.38] },
  { name: 'Chernivtsi',     bbox: [48.27, 25.91, 48.33, 25.98] },
  { name: 'Kropyvnytskyi',  bbox: [48.49, 32.24, 48.55, 32.32] },
  { name: 'Kremenchuk',     bbox: [49.06, 33.39, 49.12, 33.47] },
  { name: 'Mariupol',       bbox: [47.07, 37.50, 47.14, 37.60] },  // destroyed 2022 siege
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function cityTier(lat: number, lon: number): 0 | 1 | 2 | 3 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  for (const c of TIER3_CITIES) if (inBbox(lat, lon, c.bbox)) return 3
  return 0
}

const CLASS_AADT: Record<number, number> = {
  0: 28000, 1: 14000, 2: 7000, 3: 3500, 4: 1500, 5: 600, 6: 200,
}

function tierMultiplier(tier: 0 | 1 | 2 | 3): number {
  if (tier === 1) return 2.0
  if (tier === 2) return 1.6
  if (tier === 3) return 1.3
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2 | 3,
): { light: number; medium: number; heavy: number; moto: number } {
  // Tier-1: Kyiv — European post-Soviet capital, low moto
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.70),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.18),
      moto: Math.round(aadt * 0.06),
    }
  }
  // Tier-2/3: other cities — moderate car, high HGV
  if (tier === 2 || tier === 3) {
    return {
      light: Math.round(aadt * 0.68),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.22),
      moto: Math.round(aadt * 0.05),
    }
  }
  // Rural: grain/industrial freight dominant
  return {
    light: Math.round(aadt * 0.58),
    medium: Math.round(aadt * 0.03),
    heavy: Math.round(aadt * 0.35),
    moto: Math.round(aadt * 0.04),
  }
}

async function main() {
  console.log(`=== UA Roads Enrichment — Ukraine CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: Ukravtodor publishes no open AADT. Using class defaults.`)
  console.log(`  NOTE: Pre-war baseline. Occupied/frontline areas drastically different.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UA-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0, matched = 0, hexesUpdated = 0

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
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, UA_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const aadt = (CLASS_AADT[cls] ?? 200) * mult
      const split = splitVehicles(aadt, tier)
      aadtLight[i] = split.light; aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy; aadtMoto[i] = split.moto
      trafficSource[i] = 1; datasetId[i] = MY_DATASET_ID; hexMatched++; matched++
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
