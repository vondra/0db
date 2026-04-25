/**
 * Enrich PK industrial with GEM Global Integrated Power (Pakistan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Pakistan'):
 *     432 total / 203 operating / ~46.3 GW
 *     Operating fuel: oil/gas 60, solar 57, wind 36, coal 21, hydropower 18, nuclear 6
 *
 *   Top operating plants:
 *     **Tarbela 4,888 MW** (Indus River, KPK — Pakistan's largest hydro,
 *                            world's 9th largest earth-filled dam)
 *     **Ghazi Barotha 1,450 MW** (Indus near Attock, run-of-river)
 *     **Mangla 1,070 MW** (Jhelum River, AJK)
 *     **Neelum-Jhelum 969 MW** (AJK, underground powerhouse)
 *     **Karachi Nuclear 2,200 MW** (KANUPP-2 & KANUPP-3, Hualong One,
 *                                   2021/2022 — China-Pakistan nuclear deal,
 *                                   largest nuclear capacity in Muslim world)
 *     **Balloki RLNG 1,223 MW** + **Trimmu RLNG 900 MW** +
 *     **HBS RLNG 1,230 MW** + **Bhikki RLNG 1,180 MW** —
 *                            Pakistan's ~5,000+ MW RLNG gas fleet
 *                            (LNG imported via Port Qasim, Karachi)
 *
 * Non-power industrial (OSM only):
 *   - **Pakistan Steel Mills** (Karachi, Bin Qasim) — integrated steel
 *     plant, 1.1 MT/yr capacity, **largely defunct** since 2015 (PSM crisis)
 *   - **Faisalabad** — "Manchester of Pakistan", Pakistan's largest textile
 *     hub; 600+ export-oriented units, denim, knit, yarn, knitwear
 *   - **Cement**: Lucky Cement (DG Khan, Pezu), DG Khan Cement, Bestway
 *     (Hattar, Farooqia), Maple Leaf (Mianwali), Fauji Cement (Jhang)
 *   - **Oil refineries**: PRL (Pakistan Refinery Ltd, Karachi), ARL
 *     (Attock Refinery, Rawalpindi/Morgah), NRL (National Refinery, Karachi),
 *     Byco (Balochistan)
 *   - **Fertilizers**: Fauji Fertilizer (Goth Machhi, Sadiqabad), Engro
 *     Fertilizers (Daharki, Sindh), Fatima Fertilizer (Multan)
 *   - **CPEC (China-Pakistan Economic Corridor)**: Gwadar Port (deep-water,
 *     Balochistan), Gwadar Free Zone, Sahiwal Coal Power Plant (2×660 MW),
 *     Hub Power (1,320 MW CPEC coal)
 *   - **Chemicals/pharma**: ICI Pakistan (soda ash, Khewra Salt Mine area),
 *     Searle, Ferozsons
 *   - **Sugar mills**: Punjab/Sindh belt — Pakistan 5th largest sugar producer
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-pk.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/pk`)

// Pakistan bbox [minLat, minLon, maxLat, maxLon]
const PK_BBOX: [number, number, number, number] = [23.6, 60.8, 37.1, 77.8]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // India E — roughly east of 74.5 below lat 34
  [23.6, 74.5, 34.0, 77.8],
  // China NE — above lat 36 east of 74
  [36.0, 74.0, 37.1, 77.8],
  // Afghanistan NW/W — west of 66 above lat 30, plus west of 70 above lat 33
  [30.0, 60.8, 37.1, 66.0],
  [33.0, 60.8, 37.1, 70.0],
  // Iran SW — west of 63 below lat 28
  [23.6, 60.8, 28.0, 63.0],
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
    if (!inBbox(lat, lon, PK_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'PK plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== PK Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in PK: ${plants.length}`)
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
      if (inBbox(lat, lon, PK_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  PK-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, PK_BBOX) || inExcluded(lat, lon)) continue

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
