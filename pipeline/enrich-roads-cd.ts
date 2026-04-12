/**
 * Enrich CD roads.arrow with DR Congo CNOSSOS class defaults.
 *
 * The Office des Routes publishes no open GIS or AADT data.
 * Fall back to class defaults with Kinshasa Tier-1 megacity boost (×2.5)
 * and secondary city Tier-2 boosts.
 *
 * DR Congo is **Africa's 2nd largest country** (2.345M km², ~100M pop) and
 * Africa's 2nd most populous after Nigeria. It borders 9 countries: Republic
 * of Congo (W), CAR (N), South Sudan (NE), Uganda (E), Rwanda (E), Burundi
 * (E), Tanzania (E), Zambia (S), Angola (SW). Neighbour-border excludes are
 * needed to avoid applying Congolese defaults to segments in those countries
 * that fall within the CD bounding box.
 *
 * Only ~3,000 km of DR Congo's ~153,000 km road network is paved.
 * Kinshasa (~17M metro) is Africa's 3rd largest city — megacity multiplier ×2.5.
 *
 * ## DRC AADT defaults
 *
 *   | OSM class | Rural |
 *   |---|---:|
 *   | 0 motorway (NONE in DRC) | 15,000 |
 *   | 1 trunk (RN paved) | 5,000 |
 *   | 2 primary | 2,500 |
 *   | 3 secondary | 1,200 |
 *   | 4 tertiary | 500 |
 *   | 5 residential | 250 |
 *   | 6 service/other | 100 |
 *
 * ## Congolese vehicle split
 *
 * Kinshasa has massive traffic but terrible road infrastructure. Heavy transit
 * trucks dominate RN1 (Matadi port freight). Motorcycles ("moto") are dominant
 * in eastern DRC and rural areas. Mining trucks are heavy in Katanga.
 *
 *   Tier-1 (Kinshasa ×2.5):    light 40% / medium 20% / heavy 15% / moto 25%
 *   Tier-2:                    light 35% / medium 12% / heavy 25% / moto 28%
 *   Rural:                     light 25% / medium  5% / heavy 35% / moto 35%
 *   **RN1 corridor** (Matadi port freight):
 *                              light 25% / medium  5% / heavy 58% / moto 12%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-cd.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// [minLat, minLon, maxLat, maxLon]
const CD_BBOX: [number, number, number, number] = [-13.5, 12.0, 5.5, 31.5]

/**
 * Returns true if the segment midpoint is clearly outside DR Congo — i.e.
 * belongs to a neighbouring country that overlaps the CD bounding box.
 */
function isExcluded(lat: number, lon: number): boolean {
  // CAR/South Sudan N: beyond DRC's northern tip
  if (lat > 5.5) return true
  // Deep Zambia S: beyond DRC's southern tip
  if (lat < -13.5) return true
  // Tanzania/Uganda E: beyond DRC's eastern border
  if (lon > 31.5) return true
  // Atlantic/Republic of Congo W: beyond DRC's western border
  // (DRC has the Muanda strip at ~12.3°E giving it Atlantic access)
  if (lon < 12.0) return true
  // Angola west of Katanga (Angola S already enriched)
  if (lat < -9.0 && lon < 20.0) return true
  // Republic of Congo NW
  if (lat > 2.0 && lon < 16.0) return true
  return false
}

const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // [minLat, minLon, maxLat, maxLon]
  { name: 'Kinshasa', bbox: [-4.50, 15.20, -4.20, 15.45] }, // capital, ~17M metro, Africa's 3rd largest city, across Congo River from Brazzaville
]

const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Lubumbashi', bbox: [-11.70, 27.45, -11.63, 27.52] }, // ~3M, 2nd city, Haut-Katanga, copper/cobalt capital
  { name: 'Mbuji-Mayi', bbox: [-6.16, 23.58, -6.12, 23.62] },  // ~2.5M, Kasai, diamond capital, MIBA
  { name: 'Kisangani',  bbox: [0.50, 25.17, 0.54, 25.21] },    // ~1.5M, 3rd city, former Stanleyville, Congo River navigation terminus
  { name: 'Kananga',    bbox: [-5.92, 22.40, -5.88, 22.44] },  // ~1.5M, Kasai-Central
  { name: 'Bukavu',     bbox: [-2.52, 28.84, -2.48, 28.88] },  // ~1M, South Kivu, Lake Kivu, conflict zone
  { name: 'Goma',       bbox: [-1.70, 29.22, -1.66, 29.26] },  // ~1M, North Kivu, Nyiragongo volcano, conflict epicenter
  { name: 'Likasi',     bbox: [-10.99, 26.72, -10.95, 26.76] }, // ~600k, Haut-Katanga, copper smelting
  { name: 'Kolwezi',    bbox: [-10.72, 25.45, -10.68, 25.49] }, // ~500k, Lualaba, cobalt capital, Kamoa-Kakula, Tenke Fungurume
  { name: 'Matadi',     bbox: [-5.83, 13.45, -5.80, 13.49] },  // ~350k, Kongo Central, Congo River port
  { name: 'Kikwit',     bbox: [-5.05, 18.80, -5.01, 18.84] },  // ~400k, Kwilu, palm oil
]

// RN1 Kinshasa↔Matadi — Congo River corridor, main import/export route from Matadi port on Atlantic
const RN1_CORRIDOR: [number, number, number, number] = [-5.85, 13.40, -4.25, 15.50]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

function cityTier(lat: number, lon: number): 0 | 1 | 2 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}

function inRN1(lat: number, lon: number): boolean {
  return inBbox(lat, lon, RN1_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 15000, 1: 5000, 2: 2500, 3: 1200, 4: 500, 5: 250, 6: 100,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.5 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2, rn1: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.40),
      medium: Math.round(aadt * 0.20),
      heavy: Math.round(aadt * 0.15),
      moto: Math.round(aadt * 0.25),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.35),
      medium: Math.round(aadt * 0.12),
      heavy: Math.round(aadt * 0.25),
      moto: Math.round(aadt * 0.28),
    }
  }
  if (rn1) {
    return {
      light: Math.round(aadt * 0.25),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.58),
      moto: Math.round(aadt * 0.12),
    }
  }
  return {
    light: Math.round(aadt * 0.25),
    medium: Math.round(aadt * 0.05),
    heavy: Math.round(aadt * 0.35),
    moto: Math.round(aadt * 0.35),
  }
}

async function main() {
  console.log(`=== CD Roads Enrichment — DR Congo CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: Office des Routes publishes no open AADT. Neighbour excludes active.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, CD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CD-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, CD_BBOX)) continue
      if (isExcluded(midLat, midLon)) continue
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const rn1 = tier === 0 && inRN1(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 250) * mult
      const split = splitVehicles(aadt, tier, rn1)
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
