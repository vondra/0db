/**
 * Enrich IQ roads.arrow with Iraq CNOSSOS class defaults.
 *
 * No open national AADT data from Iraqi Ministry of Transport or
 * provincial authorities. Fall back to class defaults with city tier boosts.
 *
 * Iraq ~42M population. Baghdad is one of the world's largest Middle Eastern
 * cities (~8M), notorious for extreme congestion, security checkpoints
 * (reduced post-2020), and the Tigris bisecting the city into east/west
 * banks linked by major bridges. Oil corridor (Basra) dominates heavy
 * freight. Motorcycle share moderate — Gulf-influenced culture but less
 * affluent than GCC, with growing motorcycle use.
 *
 * ## Iraq AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.6) | Tier-3 (×1.3) |
 *   |---|---:|---:|---:|---:|
 *   | 0 motorway (Baghdad expressways, Hwy 1 Baghdad–Fallujah) | 40,000 | 100,000 | 64,000 | 52,000 |
 *   | 1 trunk | 18,000 | 45,000 | 28,800 | 23,400 |
 *   | 2 primary | 9,000 | 22,500 | 14,400 | 11,700 |
 *   | 3 secondary | 4,500 | 11,250 | 7,200 | 5,850 |
 *   | 4 tertiary | 2,000 | 5,000 | 3,200 | 2,600 |
 *   | 5 residential | 800 | 2,000 | 1,280 | 1,040 |
 *
 * ## Iraq vehicle split
 *
 *   Tier-1 Baghdad (extreme congestion, mixed military/civil):
 *     light 60% / medium 10% / heavy 22% / moto 8%
 *
 *   Tier-2 (Basra, Erbil, Sulaymaniyah):
 *     light 58% / medium 8% / heavy 26% / moto 8%
 *
 *   Rural:
 *     light 50% / medium 5% / heavy 38% / moto 7%
 *
 *   Basra oil corridor (extreme heavy freight, tankers, supply trucks):
 *     light 35% / medium 3% / heavy 58% / moto 4%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-iq.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Iraq bbox [minLat, minLon, maxLat, maxLon]
const IQ_BBOX: [number, number, number, number] = [29.0, 38.7, 37.4, 48.6]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Turkey N',      bbox: [37.2, 38.7, 37.4, 45.0] },
  { name: 'Iran E high',   bbox: [32.0, 46.5, 37.4, 48.6] },
  { name: 'Iran E low',    bbox: [29.0, 48.0, 32.0, 48.6] },
  { name: 'Kuwait SE',     bbox: [29.0, 46.5, 29.5, 48.6] },
  { name: 'Saudi Arabia S',bbox: [29.0, 38.7, 29.4, 48.6] },
  { name: 'Syria W',       bbox: [33.0, 38.7, 37.4, 40.5] },
  { name: 'Jordan SW',     bbox: [29.0, 38.7, 33.0, 39.5] },
]

// Tier-1 megacity (×2.5): Baghdad
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Baghdad', bbox: [33.20, 44.20, 33.50, 44.55] },
]

// Tier-2 cities (×1.6)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Basra',        bbox: [30.45, 47.65, 30.65, 47.90] },
  { name: 'Erbil',        bbox: [36.12, 43.97, 36.24, 44.08] },
  { name: 'Sulaymaniyah', bbox: [35.53, 45.40, 35.60, 45.48] },
]

// Tier-3 cities (×1.3)
const TIER3_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Mosul',      bbox: [36.30, 43.05, 36.42, 43.18] },
  { name: 'Najaf',      bbox: [31.96, 44.29, 32.05, 44.37] },
  { name: 'Karbala',    bbox: [32.59, 44.00, 32.67, 44.07] },
  { name: 'Kirkuk',     bbox: [35.44, 44.37, 35.52, 44.45] },
  { name: 'Nasiriyah',  bbox: [31.02, 46.21, 31.10, 46.29] },
  { name: 'Hillah',     bbox: [32.45, 44.41, 32.53, 44.49] },
  { name: 'Diwaniyah',  bbox: [31.98, 44.90, 32.06, 44.98] },
  { name: 'Kut',        bbox: [32.48, 45.79, 32.56, 45.87] },
  { name: 'Tikrit',     bbox: [34.59, 43.67, 34.67, 43.75] },
  { name: 'Samarra',    bbox: [34.18, 43.85, 34.26, 43.93] },
  { name: 'Fallujah',   bbox: [33.34, 43.74, 33.42, 43.82] },
  { name: 'Ramadi',     bbox: [33.41, 43.28, 33.49, 43.36] },
  { name: 'Amara',      bbox: [31.82, 47.13, 31.90, 47.21] },
]

// Basra oil corridor: heavy freight tankers/supply trucks, southern Iraq
const BASRA_OIL_CORRIDOR: [number, number, number, number] = [29.5, 46.5, 31.5, 48.5]

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
function inBasraOilCorridor(lat: number, lon: number): boolean {
  return inBbox(lat, lon, BASRA_OIL_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 40000, 1: 18000, 2: 9000, 3: 4500, 4: 2000, 5: 800, 6: 400,
}

function tierMultiplier(tier: 0 | 1 | 2 | 3): number {
  if (tier === 1) return 2.5
  if (tier === 2) return 1.6
  if (tier === 3) return 1.3
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2 | 3,
  oilCorridor: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  // Basra oil corridor: extreme heavy freight, tankers, supply trucks
  if (tier === 0 && oilCorridor) {
    return {
      light: Math.round(aadt * 0.35),
      medium: Math.round(aadt * 0.03),
      heavy: Math.round(aadt * 0.58),
      moto: Math.round(aadt * 0.04),
    }
  }
  // Tier-1: Baghdad — extreme congestion, mixed military/civil
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.60),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.22),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Tier-2: Basra, Erbil, Sulaymaniyah
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.58),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.26),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Tier-3: other cities
  if (tier === 3) {
    return {
      light: Math.round(aadt * 0.58),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.26),
      moto: Math.round(aadt * 0.08),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.50),
    medium: Math.round(aadt * 0.05),
    heavy: Math.round(aadt * 0.38),
    moto: Math.round(aadt * 0.07),
  }
}

async function main() {
  console.log(`=== IQ Roads Enrichment — Iraq CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: Iraqi MoT publishes no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, IQ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  IQ-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, IQ_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const oilCorridor = tier === 0 && inBasraOilCorridor(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, oilCorridor)
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
  console.log(`  Already enriched (skip):    ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matched.toLocaleString()}`)
  console.log(`  Total enriched:             ${matched.toLocaleString()} (${(100 * matched / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
