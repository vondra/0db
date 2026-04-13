/**
 * Enrich MX roads.arrow with Mexican CNOSSOS class defaults.
 *
 * SCT (Secretaría de Comunicaciones y Transportes) publishes conteo
 * volumétrico data as PDF reports, not open machine-readable AADT.
 * Fall back to class defaults with city tier boosts and a Mexico City ↔
 * Querétaro autopista freight corridor boost.
 *
 * Mexico has **land borders** — neighbour-border excludes are needed to
 * avoid applying Mexican defaults to segments in the US (N), Guatemala (S),
 * and Belize (SE) that fall within the MX bbox.
 *
 * Notable road context:
 *   - **CDMX Periférico / Viaducto** — Mexico City ring/express: ~200k vpd
 *   - **Autopista México–Querétaro (MEX-57)** — principal industrial/freight
 *     corridor, ~350 km; autos + heavy trucks to Bajío auto cluster
 *   - **Autopista México–Puebla (MEX-150D)** — connects CDMX to VW/AUDI plants
 *   - **Autopista Monterrey–Laredo (MEX-85)** — US border freight, NAFTA corridor
 *   - **Tijuana–Ensenada** — Baja California tourist/freight
 *   - **Autopista del Sol (MEX-95D)** — CDMX ↔ Acapulco, high tourist traffic
 *   - **Combi/pesero** (minibuses) and **mototaxis** prevalent in cities
 *   - High moto share nationally (motorcycles 15–20% in urban areas)
 *
 * ## Mexican AADT defaults
 *
 *   | OSM class | Rural | Tier-2 (×1.4) | Tier-1 (×2.0) | Tier-1 mega (×2.5) |
 *   |---|---:|---:|---:|---:|
 *   | 0 motorway          | 45,000 | 63,000 |  90,000 | 112,500 |
 *   | 1 trunk             | 20,000 | 28,000 |  40,000 |  50,000 |
 *   | 2 primary           | 10,000 | 14,000 |  20,000 |  25,000 |
 *   | 3 secondary         |  5,000 |  7,000 |  10,000 |  12,500 |
 *   | 4 tertiary          |  2,000 |  2,800 |   4,000 |   5,000 |
 *   | 5 residential       |    800 |  1,120 |   1,600 |   2,000 |
 *
 * ## Mexican vehicle split
 *
 *   Tier-1 mega (CDMX): light 55% / medium 15% / heavy 15% / moto 15%
 *   Tier-1 (GDL/MTY):   light 58% / medium 12% / heavy 16% / moto 14%
 *   Tier-2:             light 52% / medium 10% / heavy 24% / moto 14%
 *   Rural:              light 40% / medium  5% / heavy 38% / moto 17%
 *   Querétaro corridor: light 35% / medium 15% / heavy 35% / moto 15%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-mx.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// [minLat, minLon, maxLat, maxLon]
const MX_BBOX: [number, number, number, number] = [14.5, -118.5, 32.7, -86.7]

/**
 * Returns true if the segment midpoint is clearly outside Mexico — i.e.
 * belongs to a neighbouring country that overlaps the Mexico bounding box.
 */
function isExcluded(lat: number, lon: number): boolean {
  // US north
  if (lat > 32.8) return true
  // Guatemala/Belize south
  if (lat < 14.5) return true
  // Pacific (past Baja tip)
  if (lon < -118.5) return true
  // Caribbean (past Yucatán)
  if (lon > -86.5) return true
  return false
}

// Tier-1 mega: Mexico City metro (~22M)
const TIER1_MEGA_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Mexico City', bbox: [19.30, -99.20, 19.50, -99.05] },
]

// Tier-1 large: Guadalajara, Monterrey (~5M each)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Guadalajara', bbox: [20.63, -103.40, 20.70, -103.33] },
  { name: 'Monterrey',   bbox: [25.65, -100.35, 25.70, -100.28] },
]

// Tier-2
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Puebla',         bbox: [19.02, -98.24, 19.06, -98.18] },   // ~3M
  { name: 'Tijuana',        bbox: [32.50, -117.05, 32.54, -117.00] }, // ~2M
  { name: 'León',           bbox: [21.10, -101.70, 21.14, -101.66] }, // ~1.6M
  { name: 'Ciudad Juárez',  bbox: [31.68, -106.44, 31.72, -106.40] }, // ~1.5M
  { name: 'Mérida',         bbox: [20.96,  -89.64, 21.00,  -89.60] }, // ~1.1M
  { name: 'Cancún',         bbox: [21.14,  -86.86, 21.18,  -86.82] }, // ~900k
  { name: 'Querétaro',      bbox: [20.58, -100.42, 20.62, -100.38] }, // ~1.1M
  { name: 'Veracruz',       bbox: [19.17,  -96.16, 19.20,  -96.13] }, // ~800k
]

// Mexico City ↔ Querétaro autopista: principal industrial/freight corridor
const QUERETARO_CORRIDOR: [number, number, number, number] = [19.3, -100.5, 20.7, -99.0]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

// Returns 0=rural, 1=tier1, 2=tier2, 3=tier1-mega
function cityTier(lat: number, lon: number): 0 | 1 | 2 | 3 {
  for (const c of TIER1_MEGA_CITIES) if (inBbox(lat, lon, c.bbox)) return 3
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}

function inQueretaroCorridor(lat: number, lon: number): boolean {
  return inBbox(lat, lon, QUERETARO_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 45000, 1: 20000, 2: 10000, 3: 5000, 4: 2000, 5: 800,
}

function tierMultiplier(tier: 0 | 1 | 2 | 3): number {
  if (tier === 3) return 2.5
  if (tier === 1) return 2.0
  if (tier === 2) return 1.4
  return 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2 | 3,
  corridor: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 3) {
    // CDMX mega: high moto share, significant medium (combis/trucks)
    return {
      light:  Math.round(aadt * 0.55),
      medium: Math.round(aadt * 0.15),
      heavy:  Math.round(aadt * 0.15),
      moto:   Math.round(aadt * 0.15),
    }
  }
  if (tier === 1) {
    // Guadalajara/Monterrey: industrial cities, notable heavy share
    return {
      light:  Math.round(aadt * 0.58),
      medium: Math.round(aadt * 0.12),
      heavy:  Math.round(aadt * 0.16),
      moto:   Math.round(aadt * 0.14),
    }
  }
  if (tier === 2) {
    return {
      light:  Math.round(aadt * 0.52),
      medium: Math.round(aadt * 0.10),
      heavy:  Math.round(aadt * 0.24),
      moto:   Math.round(aadt * 0.14),
    }
  }
  if (corridor) {
    // MEX-57 corridor: Bajío auto industry, heavy freight
    return {
      light:  Math.round(aadt * 0.35),
      medium: Math.round(aadt * 0.15),
      heavy:  Math.round(aadt * 0.35),
      moto:   Math.round(aadt * 0.15),
    }
  }
  // Rural
  return {
    light:  Math.round(aadt * 0.40),
    medium: Math.round(aadt * 0.05),
    heavy:  Math.round(aadt * 0.38),
    moto:   Math.round(aadt * 0.17),
  }
}

async function main() {
  console.log(`=== MX Roads Enrichment — Mexican CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: SCT publishes no open per-link AADT. Neighbour excludes active.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, MX_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  MX-bbox hexes with roads.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, MX_BBOX)) continue
      if (isExcluded(midLat, midLon)) continue
      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const corridor = tier === 0 && inQueretaroCorridor(midLat, midLon)
      const aadt = (CLASS_AADT[cls] ?? 800) * mult
      const split = splitVehicles(aadt, tier, corridor)
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
