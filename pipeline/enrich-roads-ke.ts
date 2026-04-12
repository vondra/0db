/**
 * Enrich KE roads.arrow with Kenyan CNOSSOS class defaults.
 *
 * KeNHA/KURA/KeRRA publish viewer dashboards but no open AADT. Kenya Open
 * Data Initiative (opendata.go.ke) has been dormant since ~2015. Fall back
 * to class defaults with Tier-1 Nairobi boost.
 *
 * ## Kenyan AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (Nairobi Expressway) | 30,000 | 60,000 | 42,000 |
 *   | 1 trunk (Class A/B)             | 10,000 | 20,000 | 14,000 |
 *   | 2 primary                        |  5,000 | 10,000 |  7,000 |
 *   | 3 secondary                      |  2,500 |  5,000 |  3,500 |
 *   | 4 tertiary                       |  1,200 |  2,400 |  1,680 |
 *   | 5 residential                    |    600 |  1,200 |    840 |
 *
 * ## Kenyan vehicle split
 *
 * **High boda-boda (motorcycle taxi) + matatu (minibus) share** in
 * Nairobi and all urban centers. Matatus aren't strictly motorcycles but
 * typically register as medium-duty. Boda bodas are motorcycles.
 *
 *   Tier-1 (Nairobi/Mombasa): light 50% / medium 15% / heavy 10% / moto 25%
 *   Tier-2: light 52% / medium 15% / heavy 10% / moto 23%
 *   Rural: light 55% / medium 10% / heavy 20% / moto 15%
 *   **Mombasa-Nairobi container corridor**: light 45% / medium 8% / heavy 35% / moto 12%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ke.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const KE_BBOX: [number, number, number, number] = [-4.7, 33.9, 5.5, 41.9]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Ethiopia N', bbox: [3.5, 33.9, 5.5, 41.9] },
  { name: 'South Sudan NW', bbox: [4.0, 33.9, 5.5, 36.0] },
  { name: 'Uganda W', bbox: [-1.5, 33.9, 4.5, 35.0] },
  { name: 'Tanzania S', bbox: [-4.7, 33.9, -0.9, 37.0] },
  { name: 'Somalia NE', bbox: [-1.6, 41.0, 4.5, 41.9] },
]

// Tier-1 cities (×2.0)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Nairobi', bbox: [-1.40, 36.70, -1.20, 37.00] },
  { name: 'Mombasa', bbox: [-4.10, 39.60, -3.95, 39.75] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Nakuru', bbox: [-0.33, 36.05, -0.25, 36.13] },
  { name: 'Eldoret', bbox: [0.48, 35.25, 0.55, 35.33] },
  { name: 'Kisumu', bbox: [-0.13, 34.73, -0.05, 34.80] },
  { name: 'Thika', bbox: [-1.05, 37.05, -1.00, 37.12] },
  { name: 'Ruiru', bbox: [-1.17, 36.95, -1.12, 37.02] },
  { name: 'Kiambu', bbox: [-1.18, 36.80, -1.13, 36.85] },
  { name: 'Machakos', bbox: [-1.52, 37.24, -1.48, 37.30] },
  { name: 'Naivasha', bbox: [-0.75, 36.40, -0.70, 36.48] },
  { name: 'Kitale', bbox: [1.00, 34.97, 1.05, 35.03] },
  { name: 'Malindi', bbox: [-3.25, 40.08, -3.18, 40.15] },
  { name: 'Kakamega', bbox: [0.27, 34.73, 0.32, 34.78] },
  { name: 'Kisii', bbox: [-0.70, 34.75, -0.65, 34.80] },
  { name: 'Embu', bbox: [-0.55, 37.45, -0.50, 37.50] },
  { name: 'Meru', bbox: [0.03, 37.65, 0.08, 37.70] },
  { name: 'Nyeri', bbox: [-0.45, 36.95, -0.40, 37.00] },
  { name: 'Garissa', bbox: [-0.48, 39.63, -0.43, 39.68] },
  { name: 'Lamu', bbox: [-2.30, 40.90, -2.25, 40.95] },
  { name: 'Kilifi', bbox: [-3.65, 39.83, -3.60, 39.88] },
]

// Mombasa-Nairobi container freight corridor (SGR parallel)
const MOMBASA_NAIROBI_BBOX: [number, number, number, number] = [-4.10, 36.70, -1.20, 39.80]

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
function inMombasaNairobi(lat: number, lon: number): boolean {
  return inBbox(lat, lon, MOMBASA_NAIROBI_BBOX)
}

const CLASS_AADT: Record<number, number> = {
  0: 30000, 1: 10000, 2: 5000, 3: 2500, 4: 1200, 5: 600, 6: 250,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, mombasaCorr: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.50),
      medium: Math.round(aadt * 0.15),  // matatus = medium
      heavy: Math.round(aadt * 0.10),
      moto: Math.round(aadt * 0.25),    // boda bodas
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.52),
      medium: Math.round(aadt * 0.15),
      heavy: Math.round(aadt * 0.10),
      moto: Math.round(aadt * 0.23),
    }
  }
  if (mombasaCorr) {
    return {
      light: Math.round(aadt * 0.45),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.35),
      moto: Math.round(aadt * 0.12),
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
  console.log(`=== KE Roads Enrichment — Kenyan CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: KeNHA/KURA/KeRRA publish no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, KE_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  KE-bbox hexes with roads.arrow: ${hexDirs.length}`)

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

      if (!inBbox(midLat, midLon, KE_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const mombasaCorr = tier === 0 && inMombasaNairobi(midLat, midLon)

      let aadt = (CLASS_AADT[cls] ?? 400) * mult
      if (mombasaCorr && cls <= 2) aadt *= 1.8  // freight corridor boost

      const split = splitVehicles(aadt, tier, mombasaCorr)
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
