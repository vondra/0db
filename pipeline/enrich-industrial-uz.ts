/**
 * Enrich UZ industrial with GEM Global Integrated Power (Uzbekistan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Uzbekistan'):
 *     179 total / 93 operating / ~21.1 GW
 *     Operating fuel: gas 56 (oil/gas dominant), solar 13, hydro 10,
 *                     coal 12 (Angren lignite basin), wind 2
 *
 *   Top operating plants:
 *     **Talimarjan 1,700 MW** (gas complex, Kashkadarya)
 *     **ACWA Power Sirdarya 1,500 MW** (Saudi CCGT, Sirdarya — newest mega-plant,
 *                                       commissioned 2023)
 *     **Navoi 928 MW** (gas, central Navoi region)
 *     **Turakurgan 900 MW** (gas, Namangan)
 *     **Charvak 666 MW** (largest hydro, Chirchiq River, Tashkent region)
 *     **Bash + Dzhankeldy wind 1,000 MW** (new wind farms)
 *     **Karaulbazar + Nishan solar 1,000 MW** (new solar parks, Bukhara/Kashkadarya)
 *     **Angren 484 MW** (lignite coal, Tashkent region — only coal plant)
 *
 * Non-power industrial (OSM only):
 *   - **Muruntau gold mine** (Navoi region — world's largest open-pit gold mine,
 *     Navoi Mining & Metallurgical Combinat / state, ~2 Moz/year, one of the
 *     deepest open pits on earth)
 *   - **Almalyk Mining & Metallurgical Combinat (AGMK)** (Tashkent region —
 *     Central Asia's largest copper-gold-molybdenum complex)
 *   - **Bukhara oil refinery (BNPZ)** + **Ferghana oil refinery** (two main
 *     refineries, Soviet-era, processing Uzbek crude + imports)
 *   - **Shurtan Gas Chemical Complex** (Kashkadarya — gas-to-polyethylene,
 *     major export earner)
 *   - **Kungrad soda ash plant** (Karakalpakstan, near Aral Sea)
 *   - **Bekabad steel** (Tashkent region, electric arc, Soviet-era)
 *   - **Chirchiq chemical** (nitrogen fertilizer, near Tashkent)
 *   - **Navoiy Chemical Plant** (hydrometallurgy, uranium leaching history)
 *   - **Cotton processing**: post-2017 reforms ended forced labor; sector
 *     restructuring continues (UZ is world's 6th largest cotton exporter)
 *   - **UzAuto Motors (Asaka)** — GM Uzbekistan joint-venture; produces
 *     ~300,000 Chevrolet cars/year (Cobalt, Malibu, Spark, Damas minivan);
 *     near-total domestic market dominance due to extreme import tariffs
 *   - **Doubly landlocked**: Uzbekistan + Liechtenstein — only 2 in the world
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-uz.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/uz`)

// Uzbekistan bbox [minLat, minLon, maxLat, maxLon]
const UZ_BBOX: [number, number, number, number] = [37.2, 55.9, 45.6, 73.2]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Kazakhstan N — above lat 43.5 west of 68
  [43.5, 55.9, 45.6, 68.0],
  // Kazakhstan N — above lat 42 east of 68
  [42.0, 68.0, 45.6, 73.2],
  // Kyrgyzstan E — east of 71.5 below lat 42
  [37.2, 71.5, 42.0, 73.2],
  // Tajikistan SE — east of 69 below lat 39.5
  [37.2, 69.0, 39.5, 73.2],
  // Afghanistan S — below lat 37.5
  [37.2, 55.9, 37.5, 73.2],
  // Turkmenistan W — west of 57 below lat 43
  [37.2, 55.9, 43.0, 57.0],
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExcluded(lat: number, lon: number): boolean {
  for (const b of EXCLUDE_ZONES) if (inBbox(lat, lon, b)) return true
  return false
}
function flatDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

interface IndSite { lat: number; lon: number; name: string; fuel: string }

function loadGemPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-plants-gem.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, UZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'UZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== UZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in UZ: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_SOURCE_ID = SOURCES_BY_KEY.get('global-industrial-national-mix')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0, matched = 0, newEntries = 0

  for (const hex of hexDirs) {
    const arrowPath = resolve(H3R4_DIR, hex, 'industrial.arrow')
    if (!existsSync(arrowPath)) continue
    try {
      await withArrowWrite(arrowPath, table => {
        const n = table.numRows
        if (n === 0) return table
        const osmId = table.getChild('osm_id')
        const centroidLat = table.getChild('centroid_lat') ?? table.getChild('lat')
        const centroidLon = table.getChild('centroid_lon') ?? table.getChild('lon')
        const existingNaceCol = table.getChild('nace_4digit')
        const existingDatasetIdCol = table.getChild('source_id')
        if (!osmId || !centroidLat || !centroidLon) return table
        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        const existingSourceId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          existingSourceId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
          newDatasetId[j] = existingSourceId[j]
        }
        let anyChanged = false

        for (let i = 0; i < n; i++) {
          totalOsm++
          const lat = centroidLat.get(i) as number
          const lon = centroidLon.get(i) as number
          if (lat == null || lon == null) continue
          if (!inBbox(lat, lon, UZ_BBOX) || inExcluded(lat, lon)) continue

          const searchRadius = 2000
          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: IndSite | null = null
          let bestDist = searchRadius
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const cell = grid.get(`${baseLat + dy}_${baseLon + dx}`)
              if (!cell) continue
              for (const s of cell) {
                const d = flatDistM(lat, lon, s.lat, s.lon)
                if (d < bestDist) { bestDist = d; best = s }
              }
            }
          }
          if (best) {
            const nace6 = best.fuel.includes('solar') ? 359900 : best.fuel.includes('wind') ? 351200 : 351100
            const nace4 = Math.floor(nace6 / 100)
            const existingId = existingSourceId[i]
            if (shouldOverwrite(existingId, MY_SOURCE_ID)) {
              newNace[i] = nace4
              newDatasetId[i] = MY_SOURCE_ID
              if (existingId === 0) newEntries++
              matched++
              anyChanged = true
            }
          }
        }
        if (!anyChanged) return table
        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'source_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = vectorFromArray(Array.from(newNace), new Uint16())
        columns['source_id'] = vectorFromArray(Array.from(newDatasetId), new Uint16())
        return makeTable(columns)
      })
    } catch {}
  }

  console.log(`=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched:                      ${matched.toLocaleString()}`)
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
