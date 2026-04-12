/**
 * Enrich SD roads.arrow with Sudanese CNOSSOS class defaults.
 *
 * Sudan's Ministry of Roads publishes no open GIS or AADT data.
 * Fall back to class defaults with Khartoum/Omdurman Tier-1 and secondary city
 * Tier-2 boosts.
 *
 * Sudan is a **northeastern African country** (1.88M km², ~46M pop) —
 * neighbour-border excludes prevent applying Sudanese defaults to segments in
 * Egypt (N), South Sudan (S), Chad/Libya (W), Eritrea (E), and Libya NW corner.
 *
 * Civil war since April 2023 (RSF vs SAF) — severely disrupts road traffic
 * in Khartoum, Darfur (Nyala, El Fasher), and Kordofan areas.
 *
 * ## Sudanese AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (none — Khartoum has ring roads but no motorways) | 20,000 | 40,000 | 28,000 |
 *   | 1 trunk (RN1/RN20 — main paved arteries) | 8,000 | 16,000 | 11,200 |
 *   | 2 primary | 4,000 | 8,000 | 5,600 |
 *   | 3 secondary | 2,000 | 4,000 | 2,800 |
 *   | 4 tertiary | 800 | 1,600 | 1,120 |
 *   | 5 residential | 350 | 700 | 490 |
 *   | 6 service/other | 140 | 280 | 196 |
 *
 * ## Sudanese vehicle split
 *
 * Large country with oil-funded vehicle fleet; high motorcycle share in
 * rural Darfur/Kordofan; significant heavy truck transit to Port Sudan:
 *   - **Khartoum–Port Sudan corridor** — main transit freight axis; ~800 km
 *   - **Nile agricultural corridor** — Atbara, Shendi, Merowe; moderate traffic
 *   - **Darfur corridor** (El Obeid–Nyala) — humanitarian/military traffic
 *
 *   Tier-1 (Khartoum/Omdurman):  light 48% / medium 15% / heavy 17% / moto 20%
 *   Tier-2:                       light 42% / medium 10% / heavy 25% / moto 23%
 *   Rural:                        light 32% / medium  5% / heavy 35% / moto 28%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-sd.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// [minLat, minLon, maxLat, maxLon]
const SD_BBOX: [number, number, number, number] = [8.7, 21.8, 22.2, 38.6]

/**
 * Returns true if the segment midpoint is clearly outside Sudan.
 */
function isExcluded(lat: number, lon: number): boolean {
  if (lat > 22.2) return true                          // Egypt N
  if (lat < 8.8) return true                           // South Sudan S
  if (lon < 22.0) return true                          // Chad / Libya W
  if (lon > 38.5) return true                          // Eritrea / Red Sea E
  if (lat > 20.0 && lon < 24.0) return true            // Libya NW corner
  return false
}

const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Khartoum',  bbox: [15.55, 32.48, 15.65, 32.58] }, // capital, ~6M metro, Nile confluence
  { name: 'Omdurman',  bbox: [15.63, 32.45, 15.67, 32.49] }, // ~3M, across White Nile from Khartoum
]

const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Port Sudan',  bbox: [19.60, 37.20, 19.63, 37.23] }, // ~500k, Red Sea port, main trade gateway
  { name: 'Kassala',    bbox: [15.45, 36.38, 15.48, 36.41] }, // ~400k, eastern Sudan, Eritrea border
  { name: 'El Obeid',   bbox: [13.17, 30.22, 13.20, 30.25] }, // ~350k, North Kordofan capital
  { name: 'Nyala',      bbox: [12.03, 24.88, 12.06, 24.91] }, // ~500k, South Darfur capital
  { name: 'Wad Madani', bbox: [14.38, 33.51, 14.41, 33.54] }, // ~400k, Gezira State, Blue Nile
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

function cityTier(lat: number, lon: number): 0 | 1 | 2 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}

const CLASS_AADT: Record<number, number> = {
  0: 20000, 1: 8000, 2: 4000, 3: 2000, 4: 800, 5: 350, 6: 140,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.48),
      medium: Math.round(aadt * 0.15),
      heavy: Math.round(aadt * 0.17),
      moto: Math.round(aadt * 0.20),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.42),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.25),
      moto: Math.round(aadt * 0.23),
    }
  }
  return {
    light: Math.round(aadt * 0.32),
    medium: Math.round(aadt * 0.05),
    heavy: Math.round(aadt * 0.35),
    moto: Math.round(aadt * 0.28),
  }
}

async function main() {
  console.log(`=== SD Roads Enrichment — Sudanese CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: Sudan publishes no open AADT. Neighbour excludes active.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, SD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  SD-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, matched = 0, hexesUpdated = 0

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
      if (trafficSource[i] > 0) continue
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, SD_BBOX)) continue
      if (isExcluded(midLat, midLon)) continue
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const aadt = (CLASS_AADT[cls] ?? 350) * mult
      const split = splitVehicles(aadt, tier)
      aadtLight[i] = split.light; aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy; aadtMoto[i] = split.moto
      trafficSource[i] = 1; hexMatched++; matched++
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
  console.log(`  Matched by class default:   ${matched.toLocaleString()}`)
  console.log(`  Total enriched:             ${matched.toLocaleString()} (${(100 * matched / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
