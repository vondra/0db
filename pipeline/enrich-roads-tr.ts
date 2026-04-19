/**
 * Enrich TR roads.arrow with Turkey CNOSSOS class defaults.
 *
 * No open national AADT data from KGM (Karayolları Genel Müdürlüğü —
 * Turkish General Directorate of Highways). Fall back to class defaults
 * with city tier boosts.
 *
 * Turkey ~85M population, rapidly urbanising. Istanbul straddles the
 * Bosphorus (European + Asian sides) — one of world's most congested
 * cities. O-road motorway network (O-1/O-2/O-3/O-4) among Europe's
 * busiest corridors. D-400 Mediterranean coastal route (Mersin–Adana–
 * İskenderun) is a major international transit artery.
 *
 * ## Turkey AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.8) | Tier-3 (×1.4) |
 *   |---|---:|---:|---:|---:|
 *   | 0 motorway (O-roads) | 55,000 | 137,500 | 99,000 | 77,000 |
 *   | 1 trunk (D-routes) | 22,000 | 55,000 | 39,600 | 30,800 |
 *   | 2 primary | 12,000 | 30,000 | 21,600 | 16,800 |
 *   | 3 secondary | 6,000 | 15,000 | 10,800 | 8,400 |
 *   | 4 tertiary | 3,000 | 7,500 | 5,400 | 4,200 |
 *   | 5 residential | 1,000 | 2,500 | 1,800 | 1,400 |
 *
 * ## Turkey vehicle split
 *
 *   Tier-1 (İstanbul — straddles Bosphorus, Europe+Asia):
 *     light 62% / medium 12% / heavy 18% / moto 8%
 *
 *   Tier-2 (Ankara, İzmir):
 *     light 64% / medium 10% / heavy 19% / moto 7%
 *
 *   Rural:
 *     light 55% / medium 6% / heavy 32% / moto 7%
 *
 *   O-motorway (controlled access, O-1/O-2/O-3/O-4):
 *     light 72% / medium 4% / heavy 22% / moto 2%
 *
 *   D-400 Mediterranean transit (Mersin–Adana–İskenderun, heavy freight):
 *     light 55% / medium 5% / heavy 35% / moto 5%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-tr.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('tr-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Turkey bbox [minLat, minLon, maxLat, maxLon]
const TR_BBOX: [number, number, number, number] = [35.8, 25.6, 42.2, 44.8]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Greece/Bulgaria W',  bbox: [40.5, 25.6, 42.2, 26.5] },
  { name: 'Georgia NE',         bbox: [41.0, 42.5, 42.2, 44.8] },
  { name: 'Armenia NE',         bbox: [39.0, 43.5, 42.2, 44.8] },
  { name: 'Iran E',             bbox: [35.8, 44.0, 39.8, 44.8] },
  { name: 'Iraq SE',            bbox: [35.8, 42.0, 37.5, 44.8] },
  { name: 'Syria S',            bbox: [35.8, 36.0, 36.2, 44.8] },
]

// Tier-1 megacity (×2.5): İstanbul (European + Asian sides, straddles Bosphorus)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'İstanbul', bbox: [40.85, 28.55, 41.20, 29.40] },
]

// Tier-2 cities (×1.8)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Ankara',   bbox: [39.82, 32.62, 40.08, 33.02] },
  { name: 'İzmir',    bbox: [38.32, 26.93, 38.52, 27.22] },
]

// Tier-3 cities (×1.4)
const TIER3_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Bursa',        bbox: [40.15, 28.89, 40.27, 29.12] },
  { name: 'Antalya',      bbox: [36.82, 30.60, 36.95, 30.80] },
  { name: 'Adana',        bbox: [36.98, 35.24, 37.08, 35.42] },
  { name: 'Gaziantep',    bbox: [37.03, 37.31, 37.12, 37.44] },
  { name: 'Konya',        bbox: [37.83, 32.41, 37.95, 32.57] },
  { name: 'Kayseri',      bbox: [38.68, 35.42, 38.78, 35.56] },
  { name: 'Mersin',       bbox: [36.78, 34.56, 36.88, 34.72] },
  { name: 'Eskişehir',    bbox: [39.72, 30.48, 39.82, 30.60] },
  { name: 'Diyarbakır',   bbox: [37.89, 40.17, 37.99, 40.28] },
  { name: 'Samsun',       bbox: [41.26, 36.28, 41.36, 36.42] },
  { name: 'Trabzon',      bbox: [40.98, 39.67, 41.08, 39.78] },
  { name: 'Şanlıurfa',    bbox: [37.13, 38.74, 37.22, 38.87] },
  { name: 'Malatya',      bbox: [38.33, 38.28, 38.41, 38.38] },
  { name: 'Erzurum',      bbox: [39.88, 41.24, 39.98, 41.34] },
  { name: 'Van',          bbox: [38.46, 43.35, 38.53, 43.44] },
  { name: 'Denizli',      bbox: [37.76, 29.08, 37.84, 29.18] },
  { name: 'Manisa',       bbox: [38.60, 27.41, 38.68, 27.52] },
  { name: 'Kocaeli',      bbox: [40.73, 29.88, 40.83, 30.05] },
  { name: 'Sakarya',      bbox: [40.75, 30.38, 40.82, 30.48] },
]

// O-motorway network: O-1 (TEM, İstanbul–Ankara), O-2, O-3, O-4 (controlled access)
// Broad band covering the main O-road network east of İstanbul
const O_MOTORWAY_CORRIDOR: [number, number, number, number] = [39.8, 26.5, 41.5, 44.8]

// D-400 Mediterranean transit: Mersin–Adana–İskenderun coastal freight route
const D400_CORRIDOR: [number, number, number, number] = [36.7, 34.5, 37.2, 36.7]

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
function inOMotorway(lat: number, lon: number): boolean {
  return inBbox(lat, lon, O_MOTORWAY_CORRIDOR)
}
function inD400(lat: number, lon: number): boolean {
  return inBbox(lat, lon, D400_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 55000, 1: 22000, 2: 12000, 3: 6000, 4: 3000, 5: 1000, 6: 400,
}

function tierMultiplier(tier: 0 | 1 | 2 | 3): number {
  if (tier === 1) return 2.5
  if (tier === 2) return 1.8
  if (tier === 3) return 1.4
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2 | 3,
  cls: number,
  oMotorway: boolean,
  d400: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  // O-motorway: controlled access, low motorcycle share
  if (tier === 0 && oMotorway && cls === 0) {
    return {
      light: Math.round(aadt * 0.72),
      medium: Math.round(aadt * 0.04),
      heavy: Math.round(aadt * 0.22),
      moto: Math.round(aadt * 0.02),
    }
  }
  // D-400 Mediterranean transit: heavy international freight
  if (tier === 0 && d400) {
    return {
      light: Math.round(aadt * 0.55),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.35),
      moto: Math.round(aadt * 0.05),
    }
  }
  // Tier-1: İstanbul — European-ish split, moderate moto
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.62),
      medium: Math.round(aadt * 0.12),
      heavy: Math.round(aadt * 0.18),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Tier-2: Ankara, İzmir
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.64),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.19),
      moto: Math.round(aadt * 0.07),
    }
  }
  // Tier-3: other cities
  if (tier === 3) {
    return {
      light: Math.round(aadt * 0.64),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.19),
      moto: Math.round(aadt * 0.07),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.06),
    heavy: Math.round(aadt * 0.32),
    moto: Math.round(aadt * 0.07),
  }
}

async function main() {
  console.log(`=== TR Roads Enrichment — Turkey CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: KGM publishes no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TR-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, TR_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const oMotorway = tier === 0 && inOMotorway(midLat, midLon)
      const d400 = tier === 0 && inD400(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, cls, oMotorway, d400)
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
