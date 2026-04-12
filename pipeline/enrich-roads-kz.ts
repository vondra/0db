/**
 * Enrich KZ roads.arrow with Kazakhstan CNOSSOS class defaults.
 *
 * No open national AADT data from KazAvtoyol (Kazakhstan road agency).
 * Fall back to class defaults with city tier boosts.
 *
 * Kazakhstan ~19M population on 2.7M km² (7 people/km² average) —
 * one of world's most sparsely populated countries. Vast steppe and
 * desert dominate. Very LOW motorcycle share (extreme continental climate
 * like Mongolia — harsh winters make motorcycles impractical). HIGH freight
 * share on oil/coal corridors (Caspian oil, Ekibastuz coal).
 * M-routes (Astana–Almaty) under upgrade to full motorway standard.
 *
 * ## Kazakhstan AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (M-routes) | 20,000 | 40,000 | 28,000 |
 *   | 1 trunk | 8,000 | 16,000 | 11,200 |
 *   | 2 primary | 4,000 | 8,000 | 5,600 |
 *   | 3 secondary | 2,000 | 4,000 | 2,800 |
 *   | 4 tertiary | 800 | 1,600 | 1,120 |
 *   | 5 residential | 350 | 700 | 490 |
 *
 * ## Kazakhstan vehicle split
 *
 *   Tier-1 (Almaty/Astana — large cities, Russian-influenced):
 *     light 72% / medium 6% / heavy 18% / moto 4%
 *
 *   Tier-2 (other cities):
 *     light 68% / medium 5% / heavy 24% / moto 3%
 *
 *   Rural:
 *     light 55% / medium 3% / heavy 40% / moto 2%
 *
 *   Ekibastuz/Caspian oil freight corridors (extreme heavy freight):
 *     light 35% / medium 2% / heavy 62% / moto 1%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-kz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Kazakhstan bbox [minLat, minLon, maxLat, maxLon]
const KZ_BBOX: [number, number, number, number] = [40.5, 46.4, 55.5, 87.4]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Russia N (W)',      bbox: [54.5, 46.4, 55.5, 70.0] },
  { name: 'Russia N (E)',      bbox: [53.5, 70.0, 55.5, 87.4] },
  { name: 'China E',           bbox: [40.5, 81.0, 47.0, 87.4] },
  { name: 'Kyrgyzstan SE',     bbox: [40.5, 72.0, 43.0, 87.4] },
  { name: 'Uzbekistan S',      bbox: [40.5, 46.4, 41.5, 69.0] },
  { name: 'Turkmenistan SW',   bbox: [40.5, 46.4, 42.0, 53.0] },
]

// Tier-1 cities (×2.0): Almaty (~2M), Astana (~1.3M)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Almaty',  bbox: [43.15, 76.80, 43.40, 77.10] },
  { name: 'Astana',  bbox: [51.10, 71.30, 51.30, 71.60] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Shymkent',           bbox: [42.27, 69.55, 42.38, 69.70] },
  { name: 'Karaganda',          bbox: [49.78, 73.05, 49.90, 73.18] },
  { name: 'Aktobe',             bbox: [50.25, 57.15, 50.35, 57.25] },
  { name: 'Atyrau',             bbox: [47.08, 51.85, 47.18, 51.95] },
  { name: 'Aktau',              bbox: [43.62, 51.14, 43.72, 51.24] },
  { name: 'Pavlodar',           bbox: [52.27, 76.91, 52.37, 77.01] },
  { name: 'Kostanay',           bbox: [53.19, 63.58, 53.27, 63.66] },
  { name: 'Oskemen',            bbox: [49.94, 82.59, 50.03, 82.69] },
  { name: 'Semey',              bbox: [50.38, 80.21, 50.48, 80.31] },
  { name: 'Taraz',              bbox: [42.86, 71.34, 42.96, 71.44] },
  { name: 'Petropavl',          bbox: [54.85, 69.12, 54.95, 69.22] },
  { name: 'Turkestan',          bbox: [43.27, 68.18, 43.36, 68.28] },
  { name: 'Kyzylorda',          bbox: [44.82, 65.46, 44.92, 65.56] },
]

// Ekibastuz/Caspian oil freight corridors (extreme heavy: coal exports + Tengiz/Kashagan oil)
// Ekibastuz coal: Pavlodar–Ekibastuz area
const EKIBASTUZ_FREIGHT: [number, number, number, number] = [51.5, 72.5, 53.5, 77.5]
// Caspian oil: Atyrau–Aktau coastal corridor
const CASPIAN_OIL_FREIGHT: [number, number, number, number] = [43.0, 50.5, 48.0, 54.0]

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
function inFreightCorridor(lat: number, lon: number): boolean {
  return inBbox(lat, lon, EKIBASTUZ_FREIGHT) || inBbox(lat, lon, CASPIAN_OIL_FREIGHT)
}

const CLASS_AADT: Record<number, number> = {
  0: 20000, 1: 8000, 2: 4000, 3: 2000, 4: 800, 5: 350, 6: 150,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  if (tier === 1) return 2.0
  if (tier === 2) return 1.4
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2,
  freight: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  // Ekibastuz coal / Caspian oil freight corridors: extreme heavy freight
  if (tier === 0 && freight) {
    return {
      light: Math.round(aadt * 0.35),
      medium: Math.round(aadt * 0.02),
      heavy: Math.round(aadt * 0.62),
      moto: Math.round(aadt * 0.01),
    }
  }
  // Tier-1: Almaty/Astana — large cities, Russian-influenced, very low moto
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.72),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.18),
      moto: Math.round(aadt * 0.04),
    }
  }
  // Tier-2: other cities
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.68),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.24),
      moto: Math.round(aadt * 0.03),
    }
  }
  // Rural: vast steppe/desert, high freight share
  return {
    light: Math.round(aadt * 0.55),
    medium: Math.round(aadt * 0.03),
    heavy: Math.round(aadt * 0.40),
    moto: Math.round(aadt * 0.02),
  }
}

async function main() {
  console.log(`=== KZ Roads Enrichment — Kazakhstan CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: KazAvtoyol publishes no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, KZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  KZ-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, KZ_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const freight = tier === 0 && inFreightCorridor(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 150) * mult
      const split = splitVehicles(aadt, tier, freight)
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
