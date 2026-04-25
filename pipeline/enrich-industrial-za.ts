/**
 * Enrich ZA industrial with ESKOM (UP mirror) + GEM + GEM Coal Mines 2024.
 *
 * Sources:
 *   - **ESKOM Power Stations** (University of Pretoria mirror,
 *     owner `christel.hansen_uparcgis`):
 *       services8.arcgis.com/ZhTpwEGNVUBxG9VW/.../Power_Stations/FeatureServer/0
 *     33 stations with NAME, CATEGORY, LOAD_MW
 *     Includes: Medupi 4,788 MW, Kusile 4,500 MW, Kendal 4,116 MW,
 *     Majuba 4,110 MW, Matimba 3,990 MW, Lethabo 3,708 MW, Tutuka 3,654 MW,
 *     Duvha 3,600 MW, Matla 3,600 MW, Kriel 3,000 MW, Arnot 2,100 MW,
 *     Hendrina 2,000 MW, **Koeberg nuclear 1,800 MW (Africa's only
 *     operating nuclear plant)**, Camden 1,600 MW, Ingula pumped storage
 *     1,352 MW, plus hydro/wind/peaking gas/CSP
 *     CATEGORY: BASELOAD COAL 11, PEAKING HYDRO 7, STANDBY COAL 3,
 *     PEAKING GAS 2, GAS TURBINE 2, PEAKING PUMP STORAGE 2, WIND 2,
 *     COAL 1, PUMPED STORAGE 1, BASELOAD NUCLEAR 1, CSP 1
 *
 *   - **GEM Global Integrated Power August 2025** (Country_area='South Africa'):
 *     502 total, 314 operating
 *     Fuel (operating): solar 151, coal 90, wind 38, oil 20, hydro 7, gas 6, nuclear 2
 *     Includes all Eskom coal plants + Jeffreys Bay/Cookhouse/Hopefield
 *     wind + Copperton/Garob/Oyster Bay/Nxuba/Nojoli/Gibson Bay wind farms
 *     + Kathu/Ilanga/Karoshoek CSP + many PV plants (REIPPPP program)
 *
 *   - **GEM Global Coal Mines 2024** (Country='South Africa'):
 *     services7.arcgis.com/IyvyFk20mB7Wpc95/.../Global_Coal_Mines_2_view
 *     137 coal mines (79 Operating, 36 Proposed, 13 Mothballed, 6 Cancelled)
 *     Fields: Mine_Name, Status, Mine_Type (Surface/Underground/Both),
 *             State__Province (mostly Mpumalanga Highveld Coalfield +
 *             Limpopo Waterberg Coalfield)
 *     → NACE 05 (Mining of coal and lignite)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-za.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/za`)

// South Africa bbox (excluding Marion Island and the Prince Edward Islands)
const ZA_BBOX: [number, number, number, number] = [-35.0, 16.3, -22.0, 33.0]

// Exclusion zones for neighbouring countries (most are fully enclosed by ZA)
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Lesotho (fully enclosed, ~30,355 km²)
  [-30.7, 27.0, -28.5, 29.5],
  // Eswatini / Swaziland (enclosed on 3 sides)
  [-27.3, 30.8, -25.7, 32.2],
  // Namibia (W)
  [-29.0, 16.3, -22.0, 20.0],
  // Botswana (N)
  [-27.0, 20.0, -22.0, 29.4],
  // Zimbabwe (N)
  [-22.4, 25.2, -22.0, 33.0],
  // Mozambique (E)
  [-27.0, 31.9, -22.0, 33.0],
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

interface IndSite {
  lat: number; lon: number; name: string; nace: string; source: string
}

function loadEskomPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-plants-eskom.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, ZA_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const cat = (p.CATEGORY || '').toString().toLowerCase()
    let fuel = 'coal'
    if (/nuclear/.test(cat)) fuel = 'nuclear'
    else if (/hydro|pump/.test(cat)) fuel = 'hydropower'
    else if (/gas/.test(cat)) fuel = 'oil/gas'
    else if (/wind/.test(cat)) fuel = 'wind'
    else if (/csp|solar/.test(cat)) fuel = 'solar'
    out.push({
      lat, lon,
      name: (p.NAME || 'ZA Eskom plant').toString(),
      nace: '351100',
      source: `Eskom UP (${fuel})`,
    })
  }
  return out
}

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
    if (!inBbox(lat, lon, ZA_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    const fuel = (p.Type || p.Fuel || 'unknown').toString().toLowerCase()
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'ZA plant').toString(),
      nace: '351100',
      source: `GEM ZA (${fuel})`,
    })
  }
  return out
}

function loadCoalMines(): IndSite[] {
  const path = resolve(CACHE_DIR, 'coal-mines-gem.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, ZA_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString()
    if (status !== 'Operating') continue
    const mtype = (p.Mine_Type || '').toString()
    const prov = (p.State__Province || '').toString()
    out.push({
      lat, lon,
      name: `${p.Mine_Name || 'ZA coal mine'} (${mtype}, ${prov})`,
      nace: '05',  // Mining of coal and lignite
      source: `GEM Coal Mines ZA (${mtype})`,
    })
  }
  return out
}

async function main() {
  console.log(`=== ZA Industrial Enrichment — Eskom UP + GEM + GEM Coal Mines (${YEAR}) ===\n`)

  const eskom = loadEskomPlants()
  console.log(`  Eskom (UP): ${eskom.length} plants`)

  const gem = loadGemPlants()
  console.log(`  GEM operating: ${gem.length} plants`)

  const coalMines = loadCoalMines()
  console.log(`  GEM Coal Mines (Operating): ${coalMines.length} mines`)

  // Priority: Eskom UP (verified national data) > GEM (broader renewable coverage) > coal mines
  // Dedup by coordinate
  const seen = new Set<string>()
  const allSites: IndSite[] = []
  for (const s of [...eskom, ...gem, ...coalMines]) {
    const key = `${s.lat.toFixed(3)}_${s.lon.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    allSites.push(s)
  }
  console.log(`  Total unique sites: ${allSites.length}`)

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
      if (inBbox(lat, lon, ZA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ZA-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0, matched = 0, newEntries = 0
  const bySource: Record<string, number> = {}

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
          if (!inBbox(lat, lon, ZA_BBOX) || inExcluded(lat, lon)) continue

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
            // NACE values may be 2-digit ('07') or 6-digit ('351100'); pad to 6-digit.
            const nace6Raw = best.nace.length < 6 ? (best.nace + '0000').substring(0, 6) : best.nace
            const nace6 = parseInt(nace6Raw, 10) || 0
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
  console.log(`  By source:`)
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`)
  }
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
