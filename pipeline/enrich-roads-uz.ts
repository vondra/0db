/**
 * Enrich UZ roads.arrow with Uzbekistan CNOSSOS class defaults.
 *
 * No open national AADT data from Uzbekistan Road Fund or regional agencies.
 * Fall back to class defaults with city tier boosts.
 *
 * **Unique vehicle fleet**: UzAuto Motors (formerly GM Uzbekistan) in Asaka
 * produces ~300,000 Chevrolet cars/year (Cobalt, Malibu, Spark, Damas minivan).
 * Extreme import tariffs effectively block all other brands — virtually ALL
 * domestic passenger vehicles are Chevrolet/Daewoo monoculture.
 * HGV share elevated on Silk Road corridor and industrial routes.
 * Motorcycles present but lower density than South/Southeast Asia.
 *
 * Tashkent (~2.9M) is **Central Asia's largest city** — Soviet-era wide
 * boulevards (1966 earthquake reconstruction), metro, trolleybuses.
 *
 * M-39 Tashkent–Samarkand–Bukhara: main Silk Road highway, being upgraded
 * to expressway standard. High truck share (industrial/agricultural freight).
 *
 * ## Uzbekistan AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (M-39 Silk Road) | 25,000 | 50,000 | 35,000 |
 *   | 1 trunk | 12,000 | 24,000 | 16,800 |
 *   | 2 primary | 6,000 | 12,000 | 8,400 |
 *   | 3 secondary | 3,000 | 6,000 | 4,200 |
 *   | 4 tertiary | 1,400 | 2,800 | 1,960 |
 *   | 5 residential | 600 | 1,200 | 840 |
 *
 * ## Uzbekistan vehicle split
 *
 *   Tier-1 (Tashkent — Central Asia's largest city, Soviet-era boulevards):
 *     light 68% / medium 8% / heavy 18% / moto 6%
 *
 *   Tier-2 (other cities):
 *     light 65% / medium 6% / heavy 22% / moto 7%
 *
 *   Rural:
 *     light 55% / medium 4% / heavy 35% / moto 6%
 *
 *   M-39 Silk Road corridor (Tashkent–Samarkand–Bukhara, heavy freight):
 *     light 55% / medium 3% / heavy 38% / moto 4%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-uz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Uzbekistan bbox [minLat, minLon, maxLat, maxLon]
const UZ_BBOX: [number, number, number, number] = [37.2, 55.9, 45.6, 73.2]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Kazakhstan N (W of 68)',  bbox: [43.5, 55.9, 45.6, 68.0] },
  { name: 'Kazakhstan N (E of 68)',  bbox: [42.0, 68.0, 45.6, 73.2] },
  { name: 'Kyrgyzstan E',            bbox: [37.2, 71.5, 42.0, 73.2] },
  { name: 'Tajikistan SE',           bbox: [37.2, 69.0, 39.5, 73.2] },
  { name: 'Afghanistan S',           bbox: [37.2, 55.9, 37.5, 73.2] },
  { name: 'Turkmenistan W',          bbox: [37.2, 55.9, 43.0, 57.0] },
]

// Tier-1 city (×2.0): Tashkent — Central Asia's largest city ~2.9M
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Tashkent', bbox: [41.22, 69.15, 41.42, 69.42] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Samarkand',  bbox: [39.62, 66.90, 39.72, 67.02] },
  { name: 'Namangan',   bbox: [40.98, 71.58, 41.07, 71.72] },
  { name: 'Andijan',    bbox: [40.73, 72.31, 40.80, 72.42] },
  { name: 'Bukhara',    bbox: [39.74, 64.38, 39.82, 64.48] },
  { name: 'Fergana',    bbox: [40.37, 71.75, 40.43, 71.82] },
  { name: 'Nukus',      bbox: [42.44, 59.57, 42.52, 59.66] },
  { name: 'Karshi',     bbox: [38.84, 65.77, 38.90, 65.84] },
  { name: 'Jizzakh',    bbox: [40.10, 67.82, 40.16, 67.90] },
  { name: 'Navoi',      bbox: [40.08, 65.36, 40.14, 65.44] },
  { name: 'Urgench',    bbox: [41.53, 60.60, 41.60, 60.68] },
]

// M-39 Silk Road corridor: Tashkent ↔ Samarkand ↔ Bukhara (heavy freight)
const M39_CORRIDOR: [number, number, number, number] = [39.5, 63.8, 41.4, 69.4]

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
function inM39(lat: number, lon: number): boolean {
  return inBbox(lat, lon, M39_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 25000, 1: 12000, 2: 6000, 3: 3000, 4: 1400, 5: 600, 6: 300,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  if (tier === 1) return 2.0
  if (tier === 2) return 1.4
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2,
  cls: number,
  m39: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  // M-39 Silk Road corridor: heavy freight dominance
  if (tier === 0 && m39 && cls <= 1) {
    return {
      light: Math.round(aadt * 0.55),
      medium: Math.round(aadt * 0.03),
      heavy: Math.round(aadt * 0.38),
      moto: Math.round(aadt * 0.04),
    }
  }
  // Tier-1: Tashkent — Central Asia's largest city, Soviet-era boulevards
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.68),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.18),
      moto: Math.round(aadt * 0.06),
    }
  }
  // Tier-2: other cities
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.65),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.22),
      moto: Math.round(aadt * 0.07),
    }
  }
  // Rural
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.04),
    heavy: Math.round(aadt * 0.35),
    moto: Math.round(aadt * 0.06),
  }
}

async function main() {
  console.log(`=== UZ Roads Enrichment — Uzbekistan CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: No open AADT from Uzbekistan Road Fund. Using class defaults.\n`)
  console.log(`  Chevrolet/Daewoo monoculture: UzAuto (Asaka) ~300k cars/year, import tariffs block all other brands.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UZ-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, UZ_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const m39 = tier === 0 && inM39(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 300) * mult
      const split = splitVehicles(aadt, tier, cls, m39)
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
