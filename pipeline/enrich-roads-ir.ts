/**
 * Enrich IR roads.arrow with Iran CNOSSOS class defaults.
 *
 * No open national AADT from RAH (Road Maintenance and Transportation
 * Organization). Fall back to class defaults with city tier boosts.
 *
 * Iran ~88M population. Tehran (~16M metro) is one of the world's largest
 * cities with extreme congestion. Iran produces ~1M cars/year domestically
 * (Peugeot 206/207, Samand, Dena — IKCO + SAIPA duopoly), giving high
 * per-capita car ownership despite sanctions. Iran has ~2,400 km of
 * freeway (آزادراه — controlled access), plus extensive trunk network.
 *
 * ## Iran AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.8) | Tier-3 (×1.4) |
 *   |---|---:|---:|---:|---:|
 *   | 0 motorway (آزادراه ~2,400 km) | 50,000 | 125,000 | 90,000 | 70,000 |
 *   | 1 trunk | 20,000 | 50,000 | 36,000 | 28,000 |
 *   | 2 primary | 11,000 | 27,500 | 19,800 | 15,400 |
 *   | 3 secondary | 5,500 | 13,750 | 9,900 | 7,700 |
 *   | 4 tertiary | 2,500 | 6,250 | 4,500 | 3,500 |
 *   | 5 residential | 900 | 2,250 | 1,620 | 1,260 |
 *
 * ## Iran vehicle split
 *
 *   Tier-1 Tehran (extreme congestion, domestic car dominance):
 *     light 65% / medium 10% / heavy 15% / moto 10%
 *
 *   Tier-2 (other major cities):
 *     light 65% / medium 8% / heavy 19% / moto 8%
 *
 *   Rural:
 *     light 55% / medium 5% / heavy 33% / moto 7%
 *
 *   Freeway/آزادراه (controlled access, moto rare):
 *     light 74% / medium 3% / heavy 21% / moto 2%
 *
 *   South Pars freight corridor (Bandar Abbas / Asaluyeh):
 *     light 40% / medium 4% / heavy 52% / moto 4%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ir.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ir-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Iran bbox [minLat, minLon, maxLat, maxLon]
const IR_BBOX: [number, number, number, number] = [25.0, 44.0, 39.8, 63.5]

const EXCLUDE_ZONES: Array<{ name: string; test: (lat: number, lon: number) => boolean }> = [
  { name: 'Turkey W',            test: (lat, lon) => lon < 44.8 && lat > 37 },
  { name: 'Armenia/Azerbaijan NW', test: (lat, lon) => lon < 45 && lat > 38.8 },
  { name: 'Azerbaijan E',        test: (lat, lon) => lon > 48 && lat > 39 },
  { name: 'Turkmenistan NE',     test: (lat, lon) => lon > 61 && lat > 35.5 },
  { name: 'Afghanistan E',       test: (lat, lon) => lon > 61 && lat <= 35.5 },
  { name: 'Pakistan SE',         test: (lat, lon) => lon > 60 && lat < 27 },
  { name: 'Iraq W',              test: (lat, lon) => lon < 46 && lat < 37 },
  { name: 'Persian Gulf/Oman S', test: (lat, lon) => lat < 25.5 && lon > 56 },
]

// Tier-1 megacity (×2.5): Tehran (~16M — one of world's largest, extreme congestion)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Tehran', bbox: [35.55, 51.15, 35.85, 51.65] },
]

// Tier-2 cities (×1.8)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Isfahan',  bbox: [32.55, 51.55, 32.75, 51.80] },
  { name: 'Mashhad',  bbox: [36.22, 59.45, 36.38, 59.70] },
  { name: 'Tabriz',   bbox: [37.98, 46.20, 38.12, 46.40] },
  { name: 'Shiraz',   bbox: [29.54, 52.42, 29.66, 52.60] },
  { name: 'Karaj',    bbox: [35.78, 50.85, 35.98, 51.10] },
]

// Tier-3 cities (×1.4)
const TIER3_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Ahvaz',         bbox: [31.28, 48.58, 31.38, 48.72] },
  { name: 'Kerman',        bbox: [30.26, 57.00, 30.35, 57.10] },
  { name: 'Qom',           bbox: [34.60, 50.83, 34.72, 50.97] },
  { name: 'Urmia',         bbox: [37.50, 44.98, 37.60, 45.10] },
  { name: 'Kermanshah',    bbox: [34.30, 47.00, 34.40, 47.12] },
  { name: 'Zahedan',       bbox: [29.46, 60.82, 29.56, 60.94] },
  { name: 'Rasht',         bbox: [37.24, 49.55, 37.34, 49.67] },
  { name: 'Hamadan',       bbox: [34.77, 48.47, 34.87, 48.58] },
  { name: 'Arak',          bbox: [34.06, 49.66, 34.14, 49.76] },
  { name: 'Yazd',          bbox: [31.85, 54.32, 31.95, 54.42] },
  { name: 'Ardabil',       bbox: [38.22, 48.25, 38.32, 48.37] },
  { name: 'Bandar Abbas',  bbox: [27.16, 56.22, 27.26, 56.34] },
  { name: 'Sanandaj',      bbox: [35.30, 46.97, 35.40, 47.07] },
  { name: 'Zanjan',        bbox: [36.65, 48.46, 36.73, 48.56] },
  { name: 'Gorgan',        bbox: [36.82, 54.43, 36.90, 54.53] },
  { name: 'Birjand',       bbox: [32.85, 59.18, 32.93, 59.28] },
  { name: 'Bushehr',       bbox: [28.95, 50.80, 29.05, 50.90] },
  { name: 'Khorramabad',   bbox: [33.45, 48.33, 33.55, 48.43] },
  { name: 'Sari',          bbox: [36.54, 53.03, 36.62, 53.13] },
  { name: 'Bojnurd',       bbox: [37.45, 57.29, 37.55, 57.39] },
]

// Freeway/آزادراه corridor: Tehran ring + Karaj–Qazvin–Tabriz (controlled access)
const FREEWAY_CORRIDOR: [number, number, number, number] = [35.5, 46.0, 38.2, 51.8]

// South Pars freight corridor: Bandar Abbas + Asaluyeh heavy freight
const SOUTH_PARS_CORRIDOR: [number, number, number, number] = [27.0, 52.5, 29.1, 57.0]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (z.test(lat, lon)) return true
  return false
}
function cityTier(lat: number, lon: number): 0 | 1 | 2 | 3 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  for (const c of TIER3_CITIES) if (inBbox(lat, lon, c.bbox)) return 3
  return 0
}
function inFreeway(lat: number, lon: number): boolean {
  return inBbox(lat, lon, FREEWAY_CORRIDOR)
}
function inSouthPars(lat: number, lon: number): boolean {
  return inBbox(lat, lon, SOUTH_PARS_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 50000, 1: 20000, 2: 11000, 3: 5500, 4: 2500, 5: 900, 6: 400,
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
  freeway: boolean,
  southPars: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  // Freeway/آزادراه: controlled access, motorcycles rare
  if (tier === 0 && freeway && cls === 0) {
    return {
      light: Math.round(aadt * 0.74),
      medium: Math.round(aadt * 0.03),
      heavy: Math.round(aadt * 0.21),
      moto: Math.round(aadt * 0.02),
    }
  }
  // South Pars freight corridor (Bandar Abbas / Asaluyeh): extreme HGV share
  if (tier === 0 && southPars) {
    return {
      light: Math.round(aadt * 0.40),
      medium: Math.round(aadt * 0.04),
      heavy: Math.round(aadt * 0.52),
      moto: Math.round(aadt * 0.04),
    }
  }
  // Tier-1 Tehran: domestic car dominance, high congestion
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.15),
      moto: Math.round(aadt * 0.10),
    }
  }
  // Tier-2: other major cities
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.19),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Tier-3: smaller cities (same as tier-2 split)
  if (tier === 3) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.19),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.05),
    heavy: Math.round(aadt * 0.33),
    moto: Math.round(aadt * 0.07),
  }
}

async function main() {
  console.log(`=== IR Roads Enrichment — Iran CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: No open AADT from RAH. Using class defaults + city tier boosts.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, IR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  IR-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, IR_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const freeway = tier === 0 && inFreeway(midLat, midLon)
      const southPars = tier === 0 && inSouthPars(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, cls, freeway, southPars)
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
