/**
 * Enrich ET roads.arrow with Ethiopian CNOSSOS class defaults.
 *
 * ERA (Ethiopian Roads Authority) publishes no open GIS. Fall back to class
 * defaults with Addis Ababa Tier-1 boost.
 *
 * ## Ethiopian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (Addis-Adama Expressway, Addis Ring Road) | 30,000 | 60,000 | 42,000 |
 *   | 1 trunk (A-route paved) | 10,000 | 20,000 | 14,000 |
 *   | 2 primary | 5,000 | 10,000 | 7,000 |
 *   | 3 secondary | 2,500 | 5,000 | 3,500 |
 *   | 4 tertiary | 1,200 | 2,400 | 1,680 |
 *   | 5 residential | 600 | 1,200 | 840 |
 *
 * ## Ethiopian vehicle split
 *
 * Low motorcycle share (~8-12% — lower than Nigeria/Kenya but higher than SA).
 * Large share of minibus taxis and Bajaj auto-rickshaws in cities.
 * High heavy share on Addis ↔ Djibouti corridor (container freight from
 * landlocked Ethiopia's only sea outlet).
 *
 *   Tier-1 (Addis Ababa): light 60% / medium 15% / heavy 12% / moto 13%
 *   Tier-2: light 62% / medium 12% / heavy 14% / moto 12%
 *   Rural: light 58% / medium 10% / heavy 24% / moto 8%
 *   **Addis-Djibouti container corridor**: light 40% / medium 8% / heavy 45% / moto 7%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-et.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const ET_BBOX: [number, number, number, number] = [3.4, 33.0, 14.9, 48.0]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Sudan W', bbox: [3.4, 33.0, 14.9, 35.0] },
  { name: 'South Sudan SW', bbox: [3.4, 33.0, 5.5, 36.0] },
  { name: 'Kenya S', bbox: [3.4, 36.0, 5.0, 42.0] },
  { name: 'Somalia E', bbox: [3.4, 42.0, 12.0, 48.0] },
  { name: 'Djibouti NE', bbox: [10.9, 41.7, 12.7, 43.3] },
  { name: 'Eritrea N', bbox: [14.3, 36.0, 14.9, 43.3] },
]

// Tier-1 cities (×2.0)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Addis Ababa', bbox: [8.90, 38.60, 9.10, 38.90] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Dire Dawa', bbox: [9.58, 41.83, 9.65, 41.90] },
  { name: 'Mekelle', bbox: [13.48, 39.43, 13.53, 39.50] },
  { name: 'Gondar', bbox: [12.58, 37.43, 12.63, 37.50] },
  { name: 'Bahir Dar', bbox: [11.57, 37.35, 11.63, 37.42] },
  { name: 'Hawassa', bbox: [7.02, 38.45, 7.08, 38.52] },
  { name: 'Adama (Nazret)', bbox: [8.52, 39.25, 8.58, 39.32] },
  { name: 'Dessie', bbox: [11.10, 39.60, 11.15, 39.67] },
  { name: 'Jimma', bbox: [7.65, 36.82, 7.70, 36.88] },
  { name: 'Dilla', bbox: [6.40, 38.28, 6.45, 38.35] },
  { name: 'Debre Markos', bbox: [10.32, 37.70, 10.37, 37.77] },
  { name: 'Debre Birhan', bbox: [9.65, 39.50, 9.70, 39.55] },
  { name: 'Shashamane', bbox: [7.18, 38.57, 7.23, 38.63] },
  { name: 'Assela', bbox: [7.93, 39.12, 7.98, 39.17] },
  { name: 'Nekemte', bbox: [9.08, 36.53, 9.13, 36.58] },
  { name: 'Kombolcha', bbox: [11.07, 39.72, 11.12, 39.78] },
  { name: 'Harar', bbox: [9.30, 42.10, 9.33, 42.14] },
  { name: 'Arba Minch', bbox: [6.02, 37.55, 6.07, 37.60] },
  { name: 'Wukro', bbox: [13.78, 39.58, 13.82, 39.62] },
]

// Addis Ababa ↔ Djibouti container corridor (parallel to EDR railway)
const ADDIS_DJIBOUTI_BBOX: [number, number, number, number] = [8.80, 38.80, 11.70, 43.20]

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
function inAddisDjibouti(lat: number, lon: number): boolean {
  return inBbox(lat, lon, ADDIS_DJIBOUTI_BBOX)
}

const CLASS_AADT: Record<number, number> = {
  0: 30000, 1: 10000, 2: 5000, 3: 2500, 4: 1200, 5: 600, 6: 250,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, addisDjibouti: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.60),
      medium: Math.round(aadt * 0.15),  // blue-and-white minibus taxis
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.13),    // Bajaj tuktuks + some motorcycles
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.62),
      medium: Math.round(aadt * 0.12),
      heavy: Math.round(aadt * 0.14),
      moto: Math.round(aadt * 0.12),
    }
  }
  if (addisDjibouti) {
    return {
      light: Math.round(aadt * 0.40),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.45),
      moto: Math.round(aadt * 0.07),
    }
  }
  return {
    light: Math.round(aadt * 0.58),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.24),
    moto: Math.round(aadt * 0.08),
  }
}

async function main() {
  console.log(`=== ET Roads Enrichment — Ethiopian CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: ERA publishes no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, ET_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ET-bbox hexes with roads.arrow: ${hexDirs.length}`)

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

      if (!inBbox(midLat, midLon, ET_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const addisDji = tier === 0 && inAddisDjibouti(midLat, midLon)

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, addisDji)
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
