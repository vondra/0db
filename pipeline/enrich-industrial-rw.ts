/**
 * Enrich RW industrial with GEM Global Integrated Power (Rwanda filter).
 *
 * GEM only has 6 entries for Rwanda (4 operating) — this severely under-
 * represents Rwanda's actual ~220 MW installed fleet, since most capacity
 * is in **many small hydros (2-20 MW each)** that fall below GEM's
 * reporting threshold.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Rwanda'):
 *     6 total, 4 operating, ~68 MW
 *     Operating fuel: oil/gas 1 (actually methane), solar 3
 *
 *   Known plants:
 *     **KivuWatt 26-56 MW** (GEM shows 56 MW — Lake Kivu dissolved methane
 *                             extraction. **World's only operational lake
 *                             methane power plant.** Contour Global operated.
 *                             Methane dissolved in Lake Kivu at depth, pumped
 *                             and burned in gas engines. Lake Kivu contains
 *                             ~65 km³ of dissolved CO₂ + methane — a **limnic
 *                             eruption risk** if not managed.)
 *     **Agahozo Solar 7 MW** (Rwamagana, one of East Africa's first utility
 *                              solar, 2014)
 *     **Nasho Solar 3.3 MW**, **Bugesera Solar 1.8 MW**
 *
 * **NOT in GEM but significant** (small hydros below reporting threshold):
 *     - **Ntaruka 11 MW** (Lake Burera → Ruhondo)
 *     - **Mukungwa I+II ~16 MW** (Musanze)
 *     - **Nyabarongo I 28 MW** (Muhanga, opened 2014)
 *     - **Rusumo Falls 80 MW** (Akagera River, shared Rwanda/Tanzania/Burundi,
 *                                opened 2023 — binational Nile Equatorial Lakes
 *                                Subsidiary Action Program)
 *     - **Rugezi, Gihira, Keya, Mukungwa III** — numerous 2-10 MW micro-hydros
 *     - **Jabana diesel/HFO** (Kigali — emergency thermal)
 *
 * Non-power industrial (OSM only):
 *   - **No heavy industry** — Rwanda's economy is service-oriented (tourism,
 *     coffee, tea, minerals, ICT)
 *   - **Tin/Tantalum/Tungsten (3T) mining** — Rwanda is a significant
 *     processor of Central African conflict minerals (DRC origin) at
 *     various smelters (Piran, LuNa, MSA). Regulated under Dodd-Frank
 *   - **Cement**: CIMERWA (LafargeHolcim, Rusizi) — only cement plant
 *   - **Coffee**: Rwanda specialty coffee processing (washed arabica,
 *     high premium)
 *   - **Tea**: NAEB-managed plantations (Mulindi, Nyabihu, Rubaya)
 *   - **Kigali Special Economic Zone** — IT hub (Carnegie Mellon Africa,
 *     Andela, VW mobility hub)
 *   - **Bugesera International Airport** — under construction since 2017
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-rw.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/rw`)

// Rwanda bbox — tiny and extremely dense (26k km²)
const RW_BBOX: [number, number, number, number] = [-2.85, 28.85, -1.05, 30.9]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Uganda (N) — north of -1.1
  [-1.1, 28.85, -1.05, 30.9],
  // Tanzania (E) — east of 30.8
  [-2.85, 30.8, -1.05, 30.9],
  // Burundi (S) — south of -2.3 east of 29.4
  [-2.85, 29.4, -2.3, 30.9],
  // DRC (W) — west of 29.0 (Lake Kivu + Virunga border)
  [-2.85, 28.85, -1.05, 29.0],
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
    if (!inBbox(lat, lon, RW_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'RW plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== RW Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in RW: ${plants.length}`)
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
      if (inBbox(lat, lon, RW_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  RW-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, RW_BBOX) || inExcluded(lat, lon)) continue
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
