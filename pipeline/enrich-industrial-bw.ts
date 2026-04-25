/**
 * Enrich BW industrial with GEM Global Integrated Power (Botswana filter).
 *
 * Botswana gov portals (DRTS/MoTC, BPC, Ministry of Minerals and Energy,
 * DEA) publish corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Botswana'):
 *     59 total, 13 operating, ~820 MW
 *     Operating fuel: coal 8, solar 4, oil/gas 1
 *
 *   Top operating plants:
 *     **Morupule B 600 MW** (4×150 MW coal, opened 2012 — Botswana's
 *                             largest plant, plagued by technical problems
 *                             since commissioning. Chinese-built by China
 *                             National Electric Equipment Corporation)
 *     **Morupule A 132 MW** (4×33 MW coal, 1986, upgraded 2008)
 *     **Francistown APR 70 MW** (diesel emergency rental, Aggreko)
 *     **Kweneng/Central/NW/Gaborone Solar** (4 small solar plants, 1-11 MW)
 *
 * **Botswana imports ~40% of electricity** from South Africa (Eskom) and
 * Mozambique. **Morupule B chronic technical problems** have made the
 * country even more import-dependent.
 *
 * Non-power industrial (OSM only):
 *   - **Jwaneng Diamond Mine** (Jwaneng, S Botswana) — **world's richest
 *     diamond mine by value**, De Beers/Debswana JV (50% De Beers + 50%
 *     Government of Botswana). The single economic asset that transformed
 *     Botswana from one of Africa's poorest at independence (1966) to
 *     one of its wealthiest.
 *   - **Orapa Diamond Mine** (Orapa, central) — **world's largest diamond
 *     mine by area** (world's 2nd largest open pit)
 *   - **Letlhakane Diamond Mine** (near Orapa) — Debswana
 *   - **Karowe Diamond Mine** (Letlhakane) — Lucara Diamond (world's 2nd
 *     largest gem diamond Lesedi La Rona 1,109ct found here 2015)
 *   - **Morupule Coal Mine** — Debswana/Minergy, feeds Morupule A+B plants
 *   - **BCL Selebi-Phikwe** — nickel/copper smelter+mine complex,
 *     **closed 2016** after commodity collapse. Selebi-Phikwe town was
 *     purpose-built for this mine (1973-2016, ~45 year lifespan).
 *   - **Gaborone industrial** — Kgale Glass, BMC (Botswana Meat Commission)
 *   - **Cement**: PPC Botswana (Gaborone)
 *   - **Soda ash**: Botswana Ash (Sua Pan, Makgadikgadi — world's largest
 *     soda ash deposit by area, mining since 1991)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bw.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/bw`)

// Botswana bbox — mostly Kalahari Desert, population concentrated SE
const BW_BBOX: [number, number, number, number] = [-26.9, 19.9, -17.8, 29.4]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Namibia (W + NW) — Caprivi strip and western border
  [-26.9, 19.9, -17.8, 21.0],
  // Namibia Caprivi (N strip)
  [-18.5, 21.0, -17.8, 25.3],
  // Zimbabwe (NE) — east of 27.5 north of -22
  [-22.0, 27.5, -17.8, 29.4],
  // South Africa (S + SE)
  [-26.9, 24.0, -25.2, 29.4],
  [-26.9, 19.9, -24.5, 24.0],
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
    if (!inBbox(lat, lon, BW_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'BW plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== BW Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in BW: ${plants.length}`)
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
      if (inBbox(lat, lon, BW_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  BW-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, BW_BBOX) || inExcluded(lat, lon)) continue

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
