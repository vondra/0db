/**
 * Enrich VE industrial with VE360 (SIGOT mirror) + GEM (backfill).
 *
 * Sources:
 *   - **VE360 Parque de Generación Eléctrica** (proyecto.ve360 SIGOT mirror):
 *       services6.arcgis.com/lpJCO3ug8HhNiEOV/.../Parque_de_Generación_Eléctrica_gdb
 *     289 power plant entries with rich fields:
 *       PLANTA, PROPIEDAD (PDVSA/Corpoelec/etc), CAPACIDAD_MW,
 *       OPERACIÓN_ACTUAL_MW (!), ESTADO_DEL_MANTENIMIENTO, FECHA
 *     Critical observation: total nameplate 15,361 MW but ACTUAL operation
 *     only 3,786 MW (~25%). This reflects the real-world collapse of the
 *     Venezuelan electricity grid due to years of underinvestment and brain
 *     drain.
 *     Filter: only include plants with `OPERACIÓN_ACTUAL_MW > 0`
 *
 *   - **VE360 Subestaciones Eléctricas**: 209 substations
 *   - **VE360 Oil wells (Pozos Petroleros)**: 20,714 wells in Faja del Orinoco
 *     + Lake Maracaibo basin (NACE 06)
 *   - **VE360 Oil pipelines (Ductos)**: 2,269 oil/gas line segments
 *   - **VE360 Oil plants**: 28 processing plants
 *   - **VE360 Oil stations**: 110 pumping/compressor stations
 *   - **VE360 Gas flares**: 148 flaring/venting points
 *
 *   - **GEM Global Integrated Power v1** (Country_area='Venezuela'):
 *     102 features for backfill, especially **Guri Dam** (10,200 MW) +
 *     Macagua + Caruachi hydroelectric complex on the Caroní River which
 *     VE360 dataset appears to underrepresent.
 *
 * Mining (not captured — CVG SIDOR, Alcasa, Venalum, Ferrominera rely on OSM).
 * Major refineries: Paraguaná CRP (Amuay, Cardón, Bajo Grande), El Palito,
 * Puerto La Cruz, San Roque — rely on OSM landuse=industrial tags.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ve.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ve`)

// Venezuela bbox
const VE_BBOX: [number, number, number, number] = [0.6, -73.4, 12.5, -59.0]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Colombia (W)
  [-4.3, -73.4, 12.5, -67.0],
  // Brazil (S)
  [0.6, -68.0, 5.3, -59.0],
  // Guyana (E, Essequibo disputed — but Venezuela claims it; exclude conservatively)
  [0.6, -61.4, 8.7, -56.5],
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

function loadVePowerPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-plants-ve360.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    // Filter: only plants with actual operation > 0
    const actual = p['OPERACIÓN_ACTUAL_MW']
    const actualMw = typeof actual === 'number' ? actual : parseFloat(String(actual || 0)) || 0
    if (actualMw <= 0) continue
    out.push({
      lat, lon,
      name: `${p.PLANTA || 'VE plant'} (${p.PROPIEDAD || '?'})`,
      nace: '351100',
      source: `VE360 power (${p.PROPIEDAD || '?'})`,
    })
  }
  return out
}

function loadVeSubstations(): IndSite[] {
  const path = resolve(CACHE_DIR, 'substations-ve360.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    out.push({
      lat, lon,
      name: (p.NOMBRE || p.Nombre || p.nombre || 'VE substation').toString(),
      nace: '351100',
      source: 'VE360 substation',
    })
  }
  return out
}

function loadVeOilWells(): IndSite[] {
  const path = resolve(CACHE_DIR, 'oil-wells.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    out.push({
      lat, lon,
      name: (p.NOMBRE || p.Nombre || p.nombre || 'VE oil well').toString(),
      nace: '06',  // Extraction of crude petroleum and natural gas
      source: 'VE360 oil well',
    })
  }
  return out
}

function loadVeOilPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'oil-plants.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    out.push({
      lat, lon,
      name: (p.NOMBRE || p.Nombre || p.nombre || 'VE oil plant').toString(),
      nace: '19',  // Manufacture of coke and refined petroleum products
      source: 'VE360 oil plant',
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
    if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    const fuel = (p.Type || 'unknown').toString().toLowerCase()
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'VE plant').toString(),
      nace: '351100',
      source: `GEM VE (${fuel})`,
    })
  }
  return out
}

async function main() {
  console.log(`=== VE Industrial Enrichment — VE360 SIGOT + GEM (${YEAR}) ===\n`)

  const vePower = loadVePowerPlants()
  console.log(`  VE360 power (actual MW > 0): ${vePower.length}`)

  const veSubs = loadVeSubstations()
  console.log(`  VE360 substations:           ${veSubs.length}`)

  const veOilWells = loadVeOilWells()
  console.log(`  VE360 oil wells:             ${veOilWells.length}`)

  const veOilPlants = loadVeOilPlants()
  console.log(`  VE360 oil plants:            ${veOilPlants.length}`)

  const gem = loadGemPlants()
  console.log(`  GEM operating plants:        ${gem.length}`)

  // Dedup by coordinate
  const seen = new Set<string>()
  const allSites: IndSite[] = []
  // Priority: specific (oil plants/wells) before general (power plants)
  for (const s of [...veOilPlants, ...vePower, ...gem, ...veOilWells, ...veSubs]) {
    const key = `${s.lat.toFixed(3)}_${s.lon.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    allSites.push(s)
  }
  console.log(`  Total unique sites:          ${allSites.length}`)

  const grid = new Map<string, IndSite[]>()
  for (const s of allSites) {
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
      if (inBbox(lat, lon, VE_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  VE-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, VE_BBOX) || inExcluded(lat, lon)) continue

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
        columns['nace_4digit'] = vectorFromArray(Array.from(newNace), new Uint16())
        columns['source_id'] = vectorFromArray(Array.from(newDatasetId), new Uint16())
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
