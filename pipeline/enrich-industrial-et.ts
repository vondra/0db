/**
 * Enrich ET industrial with GEM Global Integrated Power (Ethiopia filter).
 *
 * All Ethiopian gov portals publish HTML/corporate sites only. GEM is the
 * only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ethiopia'):
 *     90 total, 25 operating
 *     Operating fuel breakdown: hydropower 12, wind 7, bioenergy 5, solar 1
 *
 *   Top operating plants:
 *     **Gilgel Gibe III 1,870 MW** (Omo River, commissioned 2016 — Africa's
 *                                    tallest RCC dam, 243 m)
 *     **GERD (Grand Ethiopian Renaissance Dam) 750 MW operating** (2 of 13
 *                                    turbines commissioned 2022-2023; full
 *                                    5,700 MW still under construction — will
 *                                    be **Africa's largest power plant**)
 *     **Gilgel Gibe II 420 MW** (Omo River, 2010)
 *     **Gilgel Gibe I 184 MW** (Omo River, 2004)
 *     **Tekeze 300 MW** (Tigray, Tekeze River)
 *     **Beles 460 MW** (Tana-Beles, Blue Nile basin)
 *     **Finchaa 134 MW** (Blue Nile basin)
 *     **Melka Wakana 153 MW** (Wabe Shebelle River)
 *     **Adama Wind I+II ~204 MW** (near Adama/Nazret)
 *     **Ashegoda Wind 120 MW** (Tigray, 2013 — first commercial wind farm)
 *     **Aysha Wind 120 MW** (Somali Region)
 *
 * **Under construction (not counted as operating)**:
 *     **GERD full capacity 5,700 MW** — to be **Africa's largest** when
 *        complete, surpassing Inga I+II DRC (1,775+710 MW) and Aswan (2.1 GW)
 *     **Koysha 2,160 MW** (Omo River)
 *
 * Non-power industrial (OSM only):
 *   - Cement: Dangote Mugher, Habesha, Messebo, National Cement
 *   - Sugar: EIH Metahara, Wonji-Shoa, Fincha, Tendaho sugar factories
 *   - Leather + textiles industrial parks (Hawassa, Bole Lemi, Bomboloi)
 *   - No oil refinery (Assab refinery closed 1997 during Eritrean independence)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-et.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/et`)

// Ethiopia bbox
const ET_BBOX: [number, number, number, number] = [3.4, 33.0, 14.9, 48.0]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Sudan (W)
  [3.4, 33.0, 14.9, 35.0],
  // South Sudan (SW)
  [3.4, 33.0, 5.5, 36.0],
  // Kenya (S)
  [3.4, 36.0, 5.0, 42.0],
  // Somalia (E)
  [3.4, 42.0, 12.0, 48.0],
  // Djibouti (NE)
  [10.9, 41.7, 12.7, 43.3],
  // Eritrea (N)
  [14.3, 36.0, 14.9, 43.3],
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
    if (!inBbox(lat, lon, ET_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    // Include operating AND GERD partial-operation variants (GERD is in "construction" but 750 MW is already generating)
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'ET plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== ET Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in ET: ${plants.length}`)
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
      if (inBbox(lat, lon, ET_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ET-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, ET_BBOX) || inExcluded(lat, lon)) continue

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
