/**
 * Enrich JO industrial with GEM Global Integrated Power (Jordan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Jordan'):
 *     167 total / 159 operating / ~6.75 GW
 *
 *     Operating fuel: solar 134, oil/gas 16, wind 9
 *
 *     Jordan is a SOLAR POWERHOUSE — one of MENA's leading solar markets,
 *     driven by extremely high solar irradiance (>300 sunny days/yr) and
 *     near-total energy import dependency. Solar share of installed capacity
 *     is among the highest in the Middle East.
 *
 *   Top operating plants:
 *     **Samra combined-cycle ~1,241 MW** (Zarqa — Jordan's main thermal base,
 *                                          multiple gas/oil units since 1970s)
 *     **IPP3 (Al-Qatrana) 574 MW** (gas/oil combined-cycle)
 *     **Zarqa Power Station 485 MW** (Zarqa, oil/gas steam)
 *     **Amman East 400 MW** (IPP1, combined-cycle)
 *     **Al-Qatrana 373 MW** (older IPP)
 *     **Rehab 300 MW** (gas turbine peakers)
 *     **Attarat oil shale 470 MW** — world's first commercial oil shale
 *                                     power plant (2020), uses Jordan's
 *                                     enormous oil shale reserves (2nd global)
 *     **Tafila Wind Farm 117 MW** — MENA's first utility-scale wind farm (2015)
 *
 * Non-power industrial (OSM only):
 *   - **JPRC (Jordan Petroleum Refining Company)** — Zarqa, Jordan's only
 *     oil refinery, ~100,000 bpd capacity
 *   - **Jordan Phosphate Mines Company (JPMC)** — Al-Abyad + Al-Hasa +
 *     Eshidiya mines; Jordan is one of the world's top-5 phosphate producers,
 *     3rd-largest exporter; phosphate is Jordan's top export commodity
 *   - **Arab Potash Company (APC)** — Dead Sea, Safi; world's 8th-largest
 *     potash producer; Dead Sea solar evaporation ponds visible from space
 *   - **ASEZA Aqaba Special Economic Zone** — Jordan's only sea outlet
 *     (Red Sea), strategic port, tourism, industrial free zone
 *   - **Cement**: Lafarge Jordan (Rashadiyya), Qatrana Cement, Jordan Cement
 *     Factories (Al-Fuheis) — cement tied to Gulf construction cycles
 *   - **Dead Sea Industries** — bromine, potassium compounds, magnesium
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-jo.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'
import { flatDistM, inBbox } from './lib/spatial.js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/jo`)

// Jordan bbox [minLat, minLon, maxLat, maxLon]
const JO_BBOX: [number, number, number, number] = [29.1, 34.9, 33.4, 39.4]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Syria N — above lat 33.0
  [33.0, 34.9, 33.4, 39.4],
  // Iraq E — east of 39.0
  [29.1, 39.0, 33.4, 39.4],
  // Saudi Arabia S/SE — below lat 30.0 east of 36
  [29.1, 36.0, 30.0, 39.0],
  // Saudi Arabia S — below lat 29.3 west of 36
  [29.1, 34.9, 29.3, 36.0],
  // Israel/Palestine W — west of 35.5 below lat 32.5 (Dead Sea/Jordan Valley/Arava border)
  [29.1, 34.9, 32.5, 35.5],
]

function inExcluded(lat: number, lon: number): boolean {
  for (const b of EXCLUDE_ZONES) if (inBbox(lat, lon, b)) return true
  return false
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
    if (!inBbox(lat, lon, JO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'JO plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== JO Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in JO: ${plants.length}`)
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
      if (inBbox(lat, lon, JO_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  JO-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, JO_BBOX) || inExcluded(lat, lon)) continue

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
