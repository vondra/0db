/**
 * Enrich DZ roads.arrow with Algerian CNOSSOS class defaults.
 *
 * Ministère des Travaux Publics publishes no open GIS. ADA (Agence
 * Nationale des Autoroutes) and ANA (Agence Nationale d'Aménagement du
 * Territoire) have geoportals but no open AADT. Fall back to class defaults.
 *
 * Algeria's road infrastructure is dominated by:
 * 1. **Autoroute Est-Ouest** — ~1,216 km, Tunisia border ↔ Morocco border
 *    via Annaba, Constantine, Sétif, Algiers, Blida, Chlef, Oran, Tlemcen.
 *    **One of Africa's longest motorways**, completed 2015.
 * 2. **Autoroute des Hauts Plateaux** — ~1,020 km, Tebessa ↔ Tlemcen
 *    parallel inland. Under construction (2024).
 * 3. **Trans-Sahara Highway (RN1)** — Algiers ↔ In Salah ↔ Tamanrasset ↔
 *    Niger border. ~3,400 km total (including Niger section).
 *
 * ## Algerian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (Autoroute Est-Ouest, Hauts Plateaux) | 35,000 | 70,000 | 49,000 |
 *   | 1 trunk (RN-route paved) | 12,000 | 24,000 | 16,800 |
 *   | 2 primary | 6,000 | 12,000 | 8,400 |
 *   | 3 secondary | 3,000 | 6,000 | 4,200 |
 *   | 4 tertiary | 1,500 | 3,000 | 2,100 |
 *   | 5 residential | 700 | 1,400 | 980 |
 *
 * ## Algerian vehicle split
 *
 * Algeria is Mediterranean/European in vehicle mix like Tunisia — low
 * motorcycle share, high light-vehicle share, high heavy share on oil/gas
 * freight corridors.
 *
 *   - **Taxi clandestin (inter-wilayas)** — informal shared intercity taxis
 *   - **ETUSA buses** — Algiers city buses (Entreprise de Transport Urbain
 *     et Suburbain d'Alger)
 *   - **Fourgons** — minibus taxis in smaller cities
 *   - **Motorcycles** — low share, growing slightly post-2018
 *   - **Heavy trucks** — abundant on oil/gas corridors and Trans-Sahara
 *
 *   Tier-1 (Algiers): light 66% / medium 12% / heavy 13% / moto 9%
 *   Tier-2:           light 66% / medium 10% / heavy 16% / moto 8%
 *   Rural:            light 58% / medium 7% / heavy 29% / moto 6%
 *   **Autoroute Est-Ouest** (coastal motorway): light 74% / medium 5% / heavy 17% / moto 4%
 *   **Hassi R'Mel/Messaoud oil-gas corridors**: light 38% / medium 5% / heavy 52% / moto 5%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-dz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const DZ_BBOX: [number, number, number, number] = [18.9, -8.7, 37.1, 12.0]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Morocco W',     bbox: [27.0, -8.7, 37.1, -2.0] },
  { name: 'W Sahara',      bbox: [22.0, -8.7, 27.0, -3.0] },
  { name: 'Mauritania SW', bbox: [18.9, -8.7, 22.0, -4.5] },
  { name: 'Mali S',        bbox: [18.9, -4.5, 25.0, 4.2] },
  { name: 'Niger SE',      bbox: [18.9, 4.2, 23.5, 12.0] },
  { name: 'Libya E',       bbox: [18.9, 10.0, 33.0, 12.0] },
  { name: 'Tunisia NE',    bbox: [33.0, 8.3, 37.1, 12.0] },
]

// Tier-1 cities (×2.0) — Grand Alger metropolitan area
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Grand Alger', bbox: [36.65, 2.95, 36.85, 3.30] },
]

// Tier-2 cities (×1.4) — wilaya capitals and major cities
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Oran',            bbox: [35.66, -0.72, 35.76, -0.55] },  // 2nd city, port
  { name: 'Constantine',     bbox: [36.33, 6.58, 36.40, 6.70] },    // 3rd city, rocky plateau
  { name: 'Annaba',          bbox: [36.88, 7.73, 36.93, 7.79] },    // port + El Hadjar steel
  { name: 'Blida',           bbox: [36.46, 2.80, 36.50, 2.86] },    // Mitidja plain, Algiers satellite
  { name: 'Batna',           bbox: [35.54, 6.16, 35.58, 6.20] },    // Aurès mountains
  { name: 'Djelfa',          bbox: [34.66, 3.25, 34.70, 3.29] },    // high plateau
  { name: 'Sétif',           bbox: [36.17, 5.39, 36.20, 5.43] },    // high plateau + tramway
  { name: 'Sidi Bel Abbès',  bbox: [35.18, -0.66, 35.21, -0.60] },  // western interior + tramway
  { name: 'Biskra',          bbox: [34.84, 5.72, 34.87, 5.76] },    // Sahara gateway
  { name: 'Tébessa',         bbox: [35.39, 8.10, 35.42, 8.14] },    // phosphate, Tunisia border
  { name: 'Tlemcen',         bbox: [34.87, -1.33, 34.90, -1.28] },  // Morocco border
  { name: 'Béjaïa',          bbox: [36.74, 5.06, 36.78, 5.10] },    // Kabyle port
  { name: 'Tiaret',          bbox: [35.36, 1.30, 35.40, 1.35] },
  { name: 'Bechar',          bbox: [31.61, -2.23, 31.65, -2.19] },  // Sahara NW
  { name: 'Skikda',          bbox: [36.87, 6.89, 36.91, 6.94] },    // port + LNG + refinery
  { name: 'Chlef',           bbox: [36.15, 1.31, 36.19, 1.36] },
  { name: 'Mostaganem',      bbox: [35.92, 0.06, 35.95, 0.12] },    // port + tramway
  { name: 'Ouargla',         bbox: [31.93, 5.30, 31.97, 5.35] },    // Sahara, oil+gas hub + tramway
  { name: 'Ghardaïa',        bbox: [32.47, 3.65, 32.50, 3.69] },    // M'zab valley UNESCO
  { name: 'Laghouat',        bbox: [33.79, 2.86, 33.82, 2.89] },
  { name: 'Hassi Messaoud',  bbox: [31.68, 5.95, 31.74, 6.08] },    // oil capital
  { name: "Hassi R'Mel",     bbox: [32.88, 3.24, 32.95, 3.30] },    // gas hub
  { name: 'Adrar',           bbox: [27.86, -0.30, 27.89, -0.27] },  // deep Sahara, wind farm
  { name: 'Tamanrasset',     bbox: [22.78, 5.51, 22.82, 5.54] },    // Ahaggar, deep south
  { name: 'Tizi Ouzou',      bbox: [36.71, 4.03, 36.73, 4.07] },    // Kabyle
  { name: 'El Oued',         bbox: [33.36, 6.85, 33.38, 6.89] },    // Souf oasis
  { name: 'Boumerdès',       bbox: [36.75, 3.46, 36.78, 3.50] },    // Algiers east satellite
]

// Autoroute Est-Ouest — Tunisia border ↔ Morocco border (coastal northern Algeria)
// Covers whole corridor roughly along 35-37 N, -1 to 8 E
const EST_OUEST: [number, number, number, number] = [35.0, -1.8, 36.95, 8.2]

// Hassi Messaoud / Hassi R'Mel oil+gas corridor — deep Sahara heavy-truck zone
const OIL_GAS_CORRIDOR: [number, number, number, number] = [29.0, 2.5, 33.5, 7.5]

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
function inEstOuest(lat: number, lon: number): boolean {
  return inBbox(lat, lon, EST_OUEST)
}
function inOilGas(lat: number, lon: number): boolean {
  return inBbox(lat, lon, OIL_GAS_CORRIDOR)
}

const CLASS_AADT: Record<number, number> = {
  0: 35000, 1: 12000, 2: 6000, 3: 3000, 4: 1500, 5: 700, 6: 280,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(
  aadt: number,
  tier: 0 | 1 | 2,
  estOuest: boolean,
  oilGas: boolean,
): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.66),
      medium: Math.round(aadt * 0.12),
      heavy: Math.round(aadt * 0.13),
      moto: Math.round(aadt * 0.09),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.66),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.16),
      moto: Math.round(aadt * 0.08),
    }
  }
  if (oilGas) {
    return {
      light: Math.round(aadt * 0.38),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.52),
      moto: Math.round(aadt * 0.05),
    }
  }
  if (estOuest) {
    return {
      light: Math.round(aadt * 0.74),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.17),
      moto: Math.round(aadt * 0.04),
    }
  }
  return {
    light: Math.round(aadt * 0.58),
    medium: Math.round(aadt * 0.07),
    heavy: Math.round(aadt * 0.29),
    moto: Math.round(aadt * 0.06),
  }
}

async function main() {
  console.log(`=== DZ Roads Enrichment — Algerian CNOSSOS class defaults (${YEAR}) ===\n`)
  console.log(`  Note: Ministère des Travaux Publics publishes no open AADT. Using class defaults.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, DZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  DZ-bbox hexes with roads.arrow: ${hexDirs.length}`)

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

      if (!inBbox(midLat, midLon, DZ_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5
      const estOuest = tier === 0 && inEstOuest(midLat, midLon)
      const oilGas = tier === 0 && inOilGas(midLat, midLon)

      const aadt = (CLASS_AADT[cls] ?? 400) * mult
      const split = splitVehicles(aadt, tier, estOuest, oilGas)
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
