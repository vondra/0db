/**
 * Enrich AO industrial with GEM Global Integrated Power (Angola filter).
 *
 * All Angolan gov portals (Sonangol, Prodel, RNT, Ministério dos Recursos
 * Minerais e Petróleo) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Angola'):
 *     76 total, 26 operating, ~5.1 GW
 *     Operating fuel: solar 14, hydropower 6, oil/gas 4, bioenergy 1, wind 1
 *
 *   Top operating plants:
 *     **Laúca 2,070 MW** (Kwanza River, opened 2017 — **Africa's 6th largest
 *                         hydropower, Angola's largest single plant**)
 *     **Cambambe II 700 MW** (Kwanza River, 2017)
 *     **Capanda 520 MW** (Kwanza River, 2004)
 *     **Soyo 720 MW** (2×360 MW CCGT, Zaire province — Angola's main gas plant,
 *                      fed by Congo River basin gas)
 *     **Biópio Solar 189 MW** (Benguela — Angola's largest utility solar)
 *     **Cambambe I 180 MW** (Kwanza River, 1963 — Angola's oldest major hydro)
 *     **CFL power station 125 MW** (oil/gas, Luanda railway depot)
 *     **Biocom bioenergy 100 MW** (sugarcane bagasse, Malanje — Biocom
 *                                   sugar-ethanol complex)
 *     **Benguela Solar 97 MW**, **Baía Farta 96 MW**, **Quileva 84 MW gas**
 *     **Gove Dam 60 MW**, **Lomaúm 50 MW** (hydros)
 *     **Morro do Ouro Wind 50 MW** (near Tombwa, Namibe — Angola's first wind farm)
 *
 *  **Under construction (not counted as operating)**:
 *     **Caculo Cabaça 2,172 MW** — Kwanza River, under construction since 2018,
 *                                   when complete will be **Angola's largest
 *                                   power plant**, overtaking Laúca
 *
 * Non-power industrial (OSM only):
 *   - **Sonangol** — state oil company, one of Africa's largest
 *     - **Offshore oil fields**: Kizomba, Plutonio, CLOV, Dalia, Girassol,
 *       Pazflor (deep-water Atlantic, Block 15/17/18)
 *     - **Angola is Africa's 2nd largest oil producer** after Nigeria
 *       (~1.1 Mbbl/day, historically OPEC member until 2023)
 *     - **Luanda Refinery** — ~65k bpd, old (1950s)
 *     - **Lobito Refinery** — under construction (new 200k bpd facility)
 *     - **Angola LNG (Soyo)** — opened 2013, Chevron/Sonangol/BP/ENI/TotalEnergies
 *   - **Cabinda enclave** — separated from mainland by DRC strip, hosts
 *     significant offshore operations (Malongo terminal, Cabinda Gulf Oil)
 *   - **Cement**: Nova Cimangola (Luanda), Ciment de Lobito, Empresa de Cimentos de Angola
 *   - **Diamonds**: **Catoca mine** (Lunda Sul — world's #4 diamond mine,
 *     Alrosa + Endiama), Lunda Norte alluvial operations
 *   - **Iron ore**: Cassinga (historic, reopening), Cassala-Kitungo
 *   - **Luanda Port** — Africa's busiest lusophone port
 *   - **Biocom sugar-ethanol** (Malanje) — integrated sugarcane complex
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ao.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ao`)

// Angola bbox — includes Cabinda enclave (north of DRC coastal strip)
const AO_BBOX: [number, number, number, number] = [-18.1, 11.6, -4.3, 24.2]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // DRC coastal strip between Cabinda and Angola mainland (narrow ~20 km)
  [-6.05, 11.6, -5.85, 13.20],
  // DRC mainland border north of Angola proper (Uíge/Bengo/Zaire N limit)
  // Angola mainland northern edge is roughly -6.0 to -7.0 depending on lon
  // Cabinda enclave is between -4.3 and -5.85 S, lon 12.0-13.0
  // DRC bounds: east of Cabinda (lon > 13.2 up to ~-4.3) and north of mainland
  [-5.85, 13.20, -4.3, 24.2],  // DRC N of Cabinda-mainland gap (up to Uíge lat)
  [-6.5, 16.0, -4.3, 24.2],    // DRC NE above mainland Angola eastern interior
  // Zambia (E) — south of -11S east of 22.5
  [-17.0, 22.5, -11.0, 24.2],
  // Namibia (S)
  [-18.1, 11.6, -17.0, 24.2],
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
    if (!inBbox(lat, lon, AO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'AO plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== AO Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in AO: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_SOURCE_ID = SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, AO_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  AO-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, AO_BBOX) || inExcluded(lat, lon)) continue

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
        columns['nace_4digit'] = vectorFromArray(newNace, new Uint16())
        columns['source_id'] = vectorFromArray(newDatasetId, new Uint16())
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
