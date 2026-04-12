/**
 * Enrich EG roads.arrow with Egyptian CNOSSOS class defaults + Nile Valley
 * focus.
 *
 * **GARBLT and MOT publish zero open spatial data.** All gov portals are
 * dead or TCP-blocked. Fall back to class defaults with aggressive tier
 * boosts for Greater Cairo (~22M, world's 6th largest metro), Alexandria,
 * Giza, and the Nile Valley cities.
 *
 * ## Egyptian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.5) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (Ring Road, Desert Road toll) | 40,000 | 100,000 | 60,000 |
 *   | 1 trunk (main road) | 15,000 | 37,500 | 22,500 |
 *   | 2 primary | 7,000 | 17,500 | 10,500 |
 *   | 3 secondary | 3,500 | 8,750 | 5,250 |
 *   | 4 tertiary | 1,500 | 3,750 | 2,250 |
 *   | 5 residential | 700 | 1,750 | 1,050 |
 *
 * **Greater Cairo uses a 2.5× multiplier** (not the usual 2.0×) to reflect
 * its exceptional density: 22M people packed into the Nile Valley north of
 * the Mouqattam Hills, with Ring Road and 26th July Corridor carrying
 * >200,000 AADT in peak sections. Cairo Ring Road is among the most
 * congested urban highways in the world.
 *
 * ## Egyptian vehicle split
 *
 * Cairo has **high motorcycle + tuktuk share** (~25-30%). Heavy freight
 * share is moderate on Suez/Red Sea Road but lower than SA coal corridors.
 *
 *   Tier-1 (Greater Cairo / Alexandria): light 55% / medium 8% / heavy 10% / moto 27%
 *   Tier-2:                              light 60% / medium 8% / heavy 12% / moto 20%
 *   Rural Delta:                         light 58% / medium 8% / heavy 20% / moto 14%
 *   **Suez corridor + Desert Roads**:    light 52% / medium 8% / heavy 30% / moto 10%
 *   Upper Egypt (Nile Valley S):         light 55% / medium 10% / heavy 20% / moto 15%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-eg.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const EG_BBOX: [number, number, number, number] = [22.0, 24.7, 31.7, 36.9]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Libya W', bbox: [22.0, 24.7, 31.7, 25.0] },
  { name: 'Sudan S', bbox: [22.0, 24.7, 22.1, 36.9] },
  { name: 'Israel+Gaza NE', bbox: [29.5, 34.25, 31.7, 34.9] },
  { name: 'Saudi E', bbox: [22.0, 34.95, 29.3, 36.9] },
  { name: 'Jordan', bbox: [29.5, 34.95, 30.3, 35.2] },
]

// Tier-1 cities (×2.5 — Cairo is uniquely dense)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Greater Cairo', bbox: [29.90, 31.05, 30.30, 31.70] },
  { name: 'Giza', bbox: [29.95, 31.10, 30.15, 31.25] },
  { name: 'Alexandria', bbox: [31.05, 29.80, 31.35, 30.15] },
]

// Tier-2 cities (×1.5)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Port Said', bbox: [31.20, 32.25, 31.30, 32.35] },
  { name: 'Suez', bbox: [29.93, 32.50, 30.00, 32.58] },
  { name: 'Ismailia', bbox: [30.57, 32.24, 30.64, 32.32] },
  { name: 'Luxor', bbox: [25.65, 32.60, 25.73, 32.68] },
  { name: 'Aswan', bbox: [24.05, 32.85, 24.12, 32.93] },
  { name: 'Hurghada', bbox: [27.20, 33.80, 27.30, 33.88] },
  { name: 'Sharm El Sheikh', bbox: [27.85, 34.25, 27.95, 34.35] },
  { name: 'Tanta', bbox: [30.75, 30.95, 30.83, 31.05] },
  { name: 'Mansoura', bbox: [31.02, 31.33, 31.10, 31.42] },
  { name: 'Mahalla el-Kubra', bbox: [30.95, 31.13, 31.02, 31.22] },
  { name: 'Asyut', bbox: [27.15, 31.15, 27.22, 31.22] },
  { name: 'Sohag', bbox: [26.52, 31.67, 26.58, 31.74] },
  { name: 'Damanhur', bbox: [31.02, 30.43, 31.10, 30.52] },
  { name: 'Zagazig', bbox: [30.55, 31.48, 30.62, 31.55] },
  { name: 'Faiyum', bbox: [29.28, 30.82, 29.35, 30.88] },
  { name: 'Minya', bbox: [28.08, 30.70, 28.15, 30.78] },
  { name: 'Beni Suef', bbox: [29.05, 31.08, 29.12, 31.15] },
  { name: 'Qena', bbox: [26.12, 32.70, 26.20, 32.78] },
  { name: 'Kafr el-Sheikh', bbox: [31.08, 30.90, 31.15, 30.98] },
  { name: 'New Cairo', bbox: [29.95, 31.40, 30.10, 31.58] },
  { name: '6th of October City', bbox: [29.88, 30.85, 29.98, 30.97] },
]

// Desert corridors — extreme heavy share
const DESERT_ROAD_BBOXES: Array<[number, number, number, number]> = [
  // Desert Road Cairo ↔ Alexandria
  [29.95, 30.25, 31.25, 31.25],
  // Suez Road Cairo ↔ Suez
  [29.88, 31.35, 30.10, 32.60],
  // Red Sea Road Cairo ↔ Hurghada
  [27.15, 31.50, 30.05, 33.90],
]

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
function inDesertRoad(lat: number, lon: number): boolean {
  for (const b of DESERT_ROAD_BBOXES) if (inBbox(lat, lon, b)) return true
  return false
}

// Egypt regional classifier
function egRegion(lat: number, lon: number): 'delta' | 'upper' | 'desert' {
  // Delta: south of 30, north of 30.3 (Nile Delta north of Cairo)
  if (lat > 30.3 && lon < 32.5) return 'delta'
  // Upper Egypt: south of Cairo (29.8), Nile Valley
  if (lat < 29.5) return 'upper'
  // Desert / Sinai / Red Sea: east or far west
  return 'desert'
}

const CLASS_AADT: Record<number, number> = {
  0: 40000, 1: 15000, 2: 7000, 3: 3500, 4: 1500, 5: 700, 6: 300,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.5 : tier === 2 ? 1.5 : 1.0  // Cairo uses 2.5×
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, region: string, desertRoad: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.55),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.10),
      moto: Math.round(aadt * 0.27),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.60),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.20),
    }
  }
  if (desertRoad) {
    return {
      light: Math.round(aadt * 0.52),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.30),
      moto: Math.round(aadt * 0.10),
    }
  }
  if (region === 'delta') {
    return {
      light: Math.round(aadt * 0.58),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.20),
      moto: Math.round(aadt * 0.14),
    }
  }
  if (region === 'upper') {
    return {
      light: Math.round(aadt * 0.55),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.20),
      moto: Math.round(aadt * 0.15),
    }
  }
  // Desert rural
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.08),
    heavy: Math.round(aadt * 0.25),
    moto: Math.round(aadt * 0.12),
  }
}

async function main() {
  console.log(`=== EG Roads Enrichment — Egyptian CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: GARBLT/MOT publish no open road data. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, EG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  EG-bbox hexes with roads.arrow: ${hexDirs.length}`)

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

      if (!inBbox(midLat, midLon, EG_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const region = egRegion(midLat, midLon)
      const desert = inDesertRoad(midLat, midLon)

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, region, desert && tier === 0)
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
