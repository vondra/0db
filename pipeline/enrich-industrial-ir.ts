/**
 * Enrich IR industrial with GEM Global Integrated Power (Iran filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Iran'):
 *     547 total / 408 operating / ~89.3 GW
 *     (2nd largest enriched after Turkey)
 *     Operating fuel: oil/gas 281 (OVERWHELMINGLY gas — Iran has world's 2nd
 *                                  largest gas reserves after Russia),
 *                    solar 90 (Yazd/Kerman desert belt),
 *                    hydro 24, wind 11, nuclear 1 (Bushehr VVER),
 *                    geothermal 1
 *
 *   Top operating plants:
 *     **Karun-III 2,000 MW** (Khuzestan, Karun River cascade)
 *     **Shahid Abbaspuor (Karun-1) 2,000 MW** (Khuzestan)
 *     **Masjed Soleyman (Karun-2) 2,000 MW** (Khuzestan)
 *     **Karun-IV + Upper Gotvand + Siahbishe + Dez** —
 *       Karun cascade ~8,520 MW total (Iran's dominant hydro system)
 *     **Bushehr Nuclear 1,000 MW** (Russian VVER-1000, Bushehr coast)
 *     **Mobarakeh Steel captive 914 MW** (Isfahan)
 *
 * Non-power industrial (OSM only):
 *   - **South Pars gas field** (Persian Gulf coast, Asaluyeh) — world's
 *     largest natural gas field, shared with Qatar's North Dome field.
 *     29 phases, ~1 billion m³/day, backbone of Iran's economy.
 *   - **Refineries**: Isfahan (largest, 370 kbd), Abadan (historic, 400 kbd
 *     capacity), Bandar Abbas (Star refinery ~480 kbd, Iran's largest),
 *     Tehran, Tabriz, Arak, Shiraz, Lavan (offshore island), Kermanshah
 *   - **Mobarakeh Steel Isfahan** — Middle East's largest steel mill,
 *     ~8 MT/yr hot-rolled coil
 *   - **NIOC / NIGC**: National Iranian Oil/Gas Company upstream assets
 *   - **Petrochem**: Asaluyeh Special Economic Zone (Bushehr/Asaluyeh coast),
 *     Mahshahr (Imam Khomeini Port), Iran's largest petrochem clusters
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ir.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ir`)

// Iran bbox [minLat, minLon, maxLat, maxLon]
const IR_BBOX: [number, number, number, number] = [25.0, 44.0, 39.8, 63.5]

const EXCLUDE_ZONES: Array<{ name: string; test: (lat: number, lon: number) => boolean }> = [
  // Turkey W — west of 44.8 above lat 37
  { name: 'Turkey W',            test: (lat, lon) => lon < 44.8 && lat > 37 },
  // Armenia/Azerbaijan NW — west of 45 above 38.8
  { name: 'Armenia/Azerbaijan NW', test: (lat, lon) => lon < 45 && lat > 38.8 },
  // Azerbaijan extra — east of 48 above 39
  { name: 'Azerbaijan E',        test: (lat, lon) => lon > 48 && lat > 39 },
  // Turkmenistan NE — east of 61 above 35.5
  { name: 'Turkmenistan NE',     test: (lat, lon) => lon > 61 && lat > 35.5 },
  // Afghanistan E — east of 61 below 35.5
  { name: 'Afghanistan E',       test: (lat, lon) => lon > 61 && lat <= 35.5 },
  // Pakistan SE — east of 60 below 27
  { name: 'Pakistan SE',         test: (lat, lon) => lon > 60 && lat < 27 },
  // Iraq W — west of 46 below 37
  { name: 'Iraq W',              test: (lat, lon) => lon < 46 && lat < 37 },
  // Persian Gulf/Oman S — below 25.5 east of 56
  { name: 'Persian Gulf/Oman S', test: (lat, lon) => lat < 25.5 && lon > 56 },
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inExcluded(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (z.test(lat, lon)) return true
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
    if (!inBbox(lat, lon, IR_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'IR plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== IR Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in IR: ${plants.length}`)
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
      if (inBbox(lat, lon, IR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  IR-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, IR_BBOX) || inExcluded(lat, lon)) continue

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
