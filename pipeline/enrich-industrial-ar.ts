/**
 * Enrich AR industrial with GEM Global Integrated Power (Argentina filter).
 *
 * Source: GEM Global Integrated Power v1
 *   services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/
 *   Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Argentina'
 *
 * Records: 393 plants total, 263 operating
 *   - oil/gas: 136 (Centrales Costanera, Loma de la Lata, Brigadier López,
 *     Pilar, Genelba, Manuel Belgrano, Vuelta de Obligado, AES Paraná)
 *   - wind: 105 (Patagonia: Comodoro Rivadavia, Madryn, Loma Blanca,
 *     Aluar, Arauco, Manantiales Behr; coastal Buenos Aires; La Pampa)
 *   - solar: 96 (Cauchari Jujuy 300 MW, La Puna, San Juan)
 *   - hydropower: 41 (Yacyretá 3.1 GW, Salto Grande 1.89 GW, Piedra del
 *     Águila 1.42 GW, Chocón 1.2 GW, Alicurá 1.04 GW, Futaleufú,
 *     Río Hondo, Cabra Corral, Los Reyunos)
 *   - bioenergy: 7 (sugarcane bagasse Tucumán, biogas)
 *   - nuclear: 5 (Atucha I 362 MW, Atucha II 745 MW, Embalse 648 MW;
 *     Atucha III pre-construction; Carem-25 small modular reactor)
 *   - coal: 3 (Río Turbio mine-mouth in Santa Cruz, smaller units)
 *
 * Argentina has no SIGACONTROL/CAMMESA equivalent ArcGIS layer for
 * facilities (only spot prices and balances). GEM is the only consistent
 * GPS+capacity+fuel source. Non-power industrial NACE classification
 * relies on global E-PRTR-equivalent (not available for AR).
 *
 * All operating plants map to NACE 35 (Electricity generation).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ar.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ar`)

const AR_BBOX: [number, number, number, number] = [-55.5, -73.6, -21.7, -53.6]
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  [-56.0, -76.0, -17.5, -69.0],  // Chile
  [-22.9, -69.7, -9.5, -57.5],   // Bolivia
  [-27.6, -62.7, -19.0, -54.2],  // Paraguay
  [-33.8, -57.7, 5.3, -34.0],    // Brazil
  [-35.0, -58.45, -30.0, -53.0], // Uruguay
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

interface IndSite { lat: number; lon: number; name: string; fuel: string; capMw: number }

function loadGemPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-plants.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, AR_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue  // skip cancelled/announced/construction/mothballed
    const fuel = (p.Type || p.Fuel || 'unknown').toString().toLowerCase()
    const cap = typeof p.Capacity__MW_ === 'number' ? p.Capacity__MW_ : 0
    const name = (p.Plant___Project_name || 'AR plant').toString()
    out.push({ lat, lon, name, fuel, capMw: cap })
  }
  return out
}

async function main() {
  console.log(`=== AR Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in AR: ${plants.length}`)
  console.log(`  Fuel breakdown:`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  // Spatial grid (~0.1° = 11 km cells)
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
      if (inBbox(lat, lon, AR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  AR-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, AR_BBOX) || inExcluded(lat, lon)) continue

          // 2 km search radius — wind/solar farms have large polygons,
          // OSM points may be off from GEM centroids
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
