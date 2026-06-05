/**
 * Enrich CN industrial with ces_ricegis (Rice University GIS / Global Energy
 * Monitor) datasets — the richest national power/industrial point registries
 * in our pipeline.
 *
 * Source: `services.arcgis.com/lqRTrQp2HrfnJt8U/arcgis/rest/services/`
 *
 * Datasets:
 *   China_coal_power_plants_vJan2024_3    → 6,078 coal unit-phases (GEM)
 *   China_Gas_Power_Plants_EH_v2024        → 252 gas plants
 *   China_Nuclear_Power_Plants_vSep2024    → 163 nuclear plants
 *   China_Wind_Power_Plants_GEM_202406     → 8,281 wind farms/turbines
 *   China_Solar_Power_Plants_GEM_202406    → 13,489 solar plants
 *   ChinaLNGTerminals                       → 82 LNG terminals
 *
 * Total: 28,345 geocoded facilities — the largest industrial point registry
 * of any country in our pipeline. WRI GPPD only has ~4,000 CN plants; this
 * dataset is 7× more complete.
 *
 * Status filter: only 'operating' (skip cancelled/construction/retired).
 *
 * NACE mapping (all map to NACE 35 — Electricity supply):
 *   Coal, Gas, Nuclear, Wind, Solar, LNG → NACE 35
 *
 * This gives the heatmap-aircraft the correct industrial noise profile:
 *   - Coal plants: ~100 dB base emission (NACE 35 with heavy combustion)
 *   - Gas CCGT: ~95 dB
 *   - Nuclear: ~90 dB (mostly cooling towers)
 *   - Wind: per-turbine specs (hub height, rated power) — use IEC 61400-11 default
 *   - Solar PV: ~70 dB (inverters only — very low)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-cn.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'
import { flatDistM, inBbox } from './lib/spatial.js'

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cn`)

const CN_BBOX: [number, number, number, number] = [18.0, 73.0, 54.0, 135.5]
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  [18.0, 73.0, 29.0, 85.0],    // India south
  [24.0, 73.0, 37.5, 74.5],    // Pakistan west
  [26.5, 80.0, 30.5, 88.2],    // Nepal
  [26.7, 88.8, 28.3, 92.1],    // Bhutan
  [18.0, 92.0, 28.5, 100.5],   // Myanmar
  [13.0, 100.0, 22.5, 107.8],  // Laos
  [8.0, 102.0, 23.5, 110.0],   // Vietnam
  [5.0, 97.0, 21.0, 106.0],    // Thailand
  [36.0, 73.0, 50.0, 81.0],    // Central Asia
  [42.0, 88.0, 54.0, 120.0],   // Mongolia
  [37.5, 124.0, 43.0, 131.0],  // North Korea
  [33.0, 126.0, 38.5, 130.0],  // South Korea
  [50.0, 115.0, 54.0, 135.5],  // Russia Far East
  [24.0, 129.0, 54.0, 135.5],  // Japan
  [21.8, 119.5, 25.5, 122.1],  // Taiwan
]
function inExcluded(lat: number, lon: number): boolean {
  for (const b of EXCLUDE_ZONES) if (inBbox(lat, lon, b)) return true
  return false
}

interface IndSite {
  lat: number
  lon: number
  name: string
  source: string
  status: string
}

function loadPoints(path: string, source: string): IndSite[] {
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, CN_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || p.status || '').toString().toLowerCase()
    // Filter: only operating
    if (status && !['operating', '运营中', 'in operation'].some(s => status.includes(s))) continue
    out.push({
      lat, lon,
      name: p.Plant_name || p.plant_name || p.Name || p.name || p.Unit_name || 'unknown',
      source,
      status,
    })
  }
  return out
}

async function main() {
  console.log(`=== CN Industrial Enrichment — ces_ricegis / GEM datasets (${YEAR}) ===\n`)

  const coal = loadPoints(resolve(CACHE_DIR, 'coal-plants.geojson'), 'China coal plants (GEM Jan 2024)')
  const gas = loadPoints(resolve(CACHE_DIR, 'gas-plants.geojson'), 'China gas plants (GEM 2024)')
  const nuclear = loadPoints(resolve(CACHE_DIR, 'nuclear-plants.geojson'), 'China nuclear plants (Sep 2024)')
  const wind = loadPoints(resolve(CACHE_DIR, 'wind-plants.geojson'), 'China wind plants (GEM Jun 2024)')
  const solar = loadPoints(resolve(CACHE_DIR, 'solar-plants.geojson'), 'China solar plants (GEM Jun 2024)')
  const lng = loadPoints(resolve(CACHE_DIR, 'lng-terminals.geojson'), 'China LNG terminals')

  console.log(`  Coal plants (operating):   ${coal.length}`)
  console.log(`  Gas plants:                ${gas.length}`)
  console.log(`  Nuclear plants:            ${nuclear.length}`)
  console.log(`  Wind plants:               ${wind.length}`)
  console.log(`  Solar plants:              ${solar.length}`)
  console.log(`  LNG terminals:             ${lng.length}`)
  const total = coal.length + gas.length + nuclear.length + wind.length + solar.length + lng.length
  console.log(`  Total sites:               ${total}`)

  // All sites map to NACE 35 (electricity generation). Priority order for matching:
  // Coal > Gas > Nuclear > LNG > Solar > Wind (coal/gas are loudest)
  const allSites = [...coal, ...gas, ...nuclear, ...lng, ...solar, ...wind]

  // Spatial grid — ~10 km cells
  const grid = new Map<string, IndSite[]>()
  for (const s of allSites) {
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
      if (inBbox(lat, lon, CN_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CN-bbox hexes with industrial.arrow: ${hexDirs.length}`)

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
          if (!inBbox(lat, lon, CN_BBOX) || inExcluded(lat, lon)) continue

          // Find nearest industrial site within 1500m
          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: IndSite | null = null
          let bestDist = 1500
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const cell = grid.get(`${baseLat + dy}_${baseLon + dx}`)
              if (!cell) continue
              for (const s of cell) {
                const d = flatDistM(lat, lon, s.lat, s.lon)
                if (d < bestDist) { bestDist = d; best = s }
              }
            }
          }
          if (best) {
            const srcLower = best.source.toLowerCase()
            const nace6 = srcLower.includes('solar') ? 359900 : srcLower.includes('wind') ? 351200 : 351100
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

  console.log(`\n=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched to ces_ricegis:       ${matched.toLocaleString()}`)
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
