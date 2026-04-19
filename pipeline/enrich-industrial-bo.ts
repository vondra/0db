/**
 * Enrich BO industrial with MHE (official) + GEM (backfill).
 *
 * Sources:
 *   - **MHE GeoServer** (Ministerio de Hidrocarburos y Energía):
 *       geoportal.mhe.gob.bo/geoserver/ows
 *     - gen_sin_20260304: 47 SIN grid plants with Tipo/Area/Central/Propietari/Pn
 *     - Gen_Ais_2026: 35 isolated system plants (off-grid)
 *     - Subestaciones_SIN_MAR_20260: 230 substations
 *     - transmision_sin_20260304: 291 HV transmission lines
 *
 *     Tipo codes:
 *       HE = Hidroeléctrica (hydro)
 *       TG = Turbina gas (thermal/gas turbine)
 *       BM = Biomasa
 *       EO = Eólica (wind)
 *       SL = Solar
 *       DO = Diesel
 *
 *     Top operating plants:
 *       Warnes 556 MW TG (Santa Cruz, ENDE ANDINA)
 *       Central del Sur 516 MW TG
 *       Entre Ríos 505 MW TG (Cochabamba, ENDE ANDINA)
 *       Guaracachi 411 MW TG (Santa Cruz, ENDE GUARACACHI)
 *       Carrasco 159 MW TG (Cochabamba, VHE)
 *       Misicuni 126 MW HE (Cochabamba hydro)
 *       Solar Oruro 104 MW SL (Altiplano solar)
 *
 *   - **GEM Global Integrated Power v1** (Country_area='Bolivia'):
 *       66 features, 37 operating — fallback for plants not in MHE grid layer
 *
 *   - Substations ≥69 kV (MHE) also tagged as NACE 35
 *
 * Mining: AJAM (Autoridad Jurisdiccional Administrativa Minera) does not
 * publish a public REST endpoint. Major mines (San Cristóbal, Huanuni,
 * Colquiri, Vinto smelter, San Bartolomé Cerro Rico, Mutún iron) rely on
 * OSM + generic defaults.
 *
 * YPFB hydrocarbons: YPFB Portal GIS metadata is accessible but query
 * endpoints return HTTP 400 (backend DB unavailable). Gas fields (Camiri,
 * Margarita, Incahuasi, Vuelta Grande) and refineries (Gualberto Villarroel
 * Cochabamba, Guillermo Elder Bell Santa Cruz) rely on OSM.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bo.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/bo`)

// Bolivia bbox
const BO_BBOX: [number, number, number, number] = [-22.9, -69.7, -9.5, -57.5]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Brazil (N, NE, E)
  [-16.0, -61.0, -9.5, -57.5],
  // Paraguay (SE)
  [-22.9, -62.7, -19.0, -57.5],
  // Argentina (S)
  [-22.9, -67.5, -21.7, -60.0],
  // Chile (SW)
  [-22.9, -69.7, -17.5, -68.0],
  // Peru (W)
  [-18.4, -69.7, -9.5, -68.5],
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
  lat: number; lon: number; name: string; fuel: string; source: string
}

const MHE_TIPO_TO_FUEL: Record<string, string> = {
  HE: 'hydropower',
  TG: 'oil/gas',
  BM: 'bioenergy',
  EO: 'wind',
  SL: 'solar',
  DO: 'diesel',
}

function loadMheGen(file: string, source: string): IndSite[] {
  const path = resolve(CACHE_DIR, file)
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, BO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const tipo = (p.Tipo || '').toString().toUpperCase()
    const fuel = MHE_TIPO_TO_FUEL[tipo] || 'unknown'
    out.push({
      lat, lon,
      name: (p.Central || 'BO plant').toString(),
      fuel,
      source,
    })
  }
  return out
}

function loadMheSubstations(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-substations.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, BO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    // MHE substations list includes distribution; we only care about transmission (≥69 kV)
    const tens = p.Tension ?? p.tension ?? 0
    const tv = typeof tens === 'number' ? tens : parseInt(String(tens), 10) || 0
    if (tv > 0 && tv < 69) continue  // skip low-voltage distribution
    out.push({
      lat, lon,
      name: (p.Nombre || p.NOMBRE || p.nombre || 'BO substation').toString(),
      fuel: 'transmission',
      source: 'MHE substation',
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
    if (!inBbox(lat, lon, BO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    const fuel = (p.Type || 'unknown').toString().toLowerCase()
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'BO plant').toString(),
      fuel,
      source: 'GEM BO',
    })
  }
  return out
}

async function main() {
  console.log(`=== BO Industrial Enrichment — MHE + GEM (${YEAR}) ===\n`)

  const mheSin = loadMheGen('power-gen-sin.geojson', 'MHE SIN')
  console.log(`  MHE SIN grid plants:       ${mheSin.length}`)

  const mheAis = loadMheGen('power-gen-ais.geojson', 'MHE AIS')
  console.log(`  MHE isolated system plants: ${mheAis.length}`)

  const mheSub = loadMheSubstations()
  console.log(`  MHE substations (≥69 kV):  ${mheSub.length}`)

  const gem = loadGemPlants()
  console.log(`  GEM operating plants:      ${gem.length}`)

  // Dedup by coordinate (MHE and GEM may overlap)
  const seen = new Set<string>()
  const allSites: IndSite[] = []
  for (const s of [...mheSin, ...mheAis, ...gem, ...mheSub]) {
    const key = `${s.lat.toFixed(3)}_${s.lon.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    allSites.push(s)
  }
  console.log(`  Total unique sites:        ${allSites.length}`)

  const grid = new Map<string, IndSite[]>()
  for (const s of allSites) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('bo-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, BO_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  BO-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        const existingDatasetIdCol = table.getChild('industrial_dataset_id')
        if (!osmId || !centroidLat || !centroidLon) return table
        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        const existingDatasetId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          existingDatasetId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
          newDatasetId[j] = existingDatasetId[j]
        }
        let anyChanged = false

        for (let i = 0; i < n; i++) {
          totalOsm++
          const lat = centroidLat.get(i) as number
          const lon = centroidLon.get(i) as number
          if (lat == null || lon == null) continue
          if (!inBbox(lat, lon, BO_BBOX) || inExcluded(lat, lon)) continue

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
            const existingId = existingDatasetId[i]
            if (shouldOverwrite(existingId, MY_DATASET_ID)) {
              newNace[i] = nace4
              newDatasetId[i] = MY_DATASET_ID
              if (existingId === 0) newEntries++
              matched++
              anyChanged = true
            }
          }
        }
        if (!anyChanged) return table
        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'industrial_dataset_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = vectorFromArray(Array.from(newNace), new Uint16())
        columns['industrial_dataset_id'] = vectorFromArray(Array.from(newDatasetId), new Uint16())
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
  console.log(`  New nace-lookup entries:      ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
