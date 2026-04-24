/**
 * Enrich CI industrial with GEM Global Integrated Power (Côte d'Ivoire filter).
 *
 * All Ivorian gov portals (AGEROUTE-CI, CI-Energies, Ministère des Mines et
 * de l'Énergie) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Côte d'Ivoire'):
 *     42 total, 13 operating
 *     Operating fuel breakdown: oil/gas 6, hydropower 5, solar 2
 *
 *   Top operating plants:
 *     **Azito 460+253 = 713 MW** (CCGT, Azito district Abidjan — Globeleq/IFC,
 *                                  Côte d'Ivoire's largest thermal)
 *     **CIPREL 255+111 MW** (Compagnie Ivoirienne de Production d'Électricité,
 *                             Vridi district Abidjan — ENI/EDF/IFC)
 *     **Soubré 275 MW** (hydropower — Sassandra River, opened 2017, China-built
 *                         Sinohydro, Côte d'Ivoire's newest major hydro)
 *     **Taabo 210 MW** (hydropower — Bandama River, 1979)
 *     **Kossou 174 MW** (hydropower — Bandama River, Lake Kossou 1972, largest
 *                         reservoir in Côte d'Ivoire)
 *     **Buyo 165 MW** (hydropower — Sassandra River, 1980)
 *     **Gribo-Popoli 112 MW** (hydropower — Sassandra River, opened 2021)
 *     **Agrekko Vridi 200 MW** (emergency gas rental — Vridi Abidjan, 2× 100 MW)
 *     **Boundiali Solar 38 MW** (Côte d'Ivoire's first utility solar, 2023)
 *
 * Non-power industrial (OSM only):
 *   - **SIR** (Société Ivoirienne de Raffinage) refinery — Vridi/Abidjan,
 *     ~80k bpd, Côte d'Ivoire's only oil refinery (supplies fuel for 7 West
 *     African countries)
 *   - **LafargeHolcim** + **SCA (Société des Ciments d'Abidjan)** — cement
 *   - **Cocoa processing**: Yopougon (Abidjan industrial), San Pédro
 *     (Côte d'Ivoire is the world's #1 cocoa producer, ~40% of global supply)
 *   - **Palm oil**: Palmci, Sifca — Southern rainforest belt
 *   - **Rubber processing**: SAPH, SOGB — Southern rainforest belt
 *   - **Port of Abidjan** (Africa's 2nd-largest francophone port) + **Port of
 *     San Pédro** (world's largest cocoa export port)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ci.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ci`)

// Côte d'Ivoire bbox
const CI_BBOX: [number, number, number, number] = [4.3, -8.6, 10.8, -2.5]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Liberia (W)
  [4.3, -8.6, 8.6, -7.55],
  // Guinea (NW)
  [8.6, -8.6, 10.8, -7.6],
  // Mali (N)
  [10.3, -8.6, 10.8, -4.5],
  // Burkina Faso (NE)
  [9.5, -5.5, 10.8, -2.5],
  // Ghana (E)
  [4.3, -3.1, 10.8, -2.5],
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
    if (!inBbox(lat, lon, CI_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CI plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== CI Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in CI: ${plants.length}`)
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
      if (inBbox(lat, lon, CI_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CI-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, CI_BBOX) || inExcluded(lat, lon)) continue

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
