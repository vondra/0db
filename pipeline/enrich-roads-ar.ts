/**
 * Enrich AR roads.arrow with IGN GeoServer DNV roads + DNV TMDA 2017-18 +
 * Argentine-tuned CNOSSOS.
 *
 * Sources:
 *   - IGN GeoServer WFS (Instituto Geográfico Nacional):
 *       wms.ign.gob.ar/geoserver/transporte/ows
 *       transporte:vial_nacional      → 2,723 DNV national routes (RN)
 *       transporte:vial_provincial    → 12,936 provincial routes (RP)
 *     Fields: tipo_de_via_de_transporte (Ruta/Autopista/Autovía),
 *             tipo_de_superficie_de_via (Pavimentado/Consolidado/Tierra),
 *             designacion_de_red_vial (route number)
 *
 *   - IDE Transporte TMDA 2017-18 (Tránsito Medio Diario Anual):
 *       ide.transporte.gob.ar/geoserver/observ/ows
 *       observ:_3.4.1.4.1.tmda_17_18_view → 1,234 line features with REAL AADT
 *     Fields: cod_ruta, valor (TMDA value), tmda17, sentido
 *     Vintage: 2017-18 (stale but real). DNV publishes annual TMDA but
 *     newer years are not exposed via this WFS endpoint.
 *
 * ## Argentine AADT defaults (fallback when no TMDA match)
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (autopista) | 45,000 | 90,000 | 63,000 |
 *   | 1 trunk (RN paved)     | 18,000 | 36,000 | 25,200 |
 *   | 2 primary              | 9,000  | 18,000 | 12,600 |
 *   | 3 secondary            | 4,000  |  8,000 |  5,600 |
 *   | 4 tertiary             | 1,800  |  3,600 |  2,520 |
 *   | 5 residential          | 800    |  1,600 |  1,120 |
 *
 * ## DNV spatial-match AADT (by surface type)
 *
 *   Pavimentado + Autopista/Autovía → 30,000 × tier
 *   Pavimentado + Ruta              → 18,000 × tier
 *   Consolidado / Tierra            →  3,000 × tier
 *
 * ## Argentine vehicle split
 *
 * Argentina has a low motorcycle share (~5% urban, ~3% rural) and a high
 * heavy-vehicle share on Pampas grain corridors and Patagonian oil/gas routes.
 *
 *   Tier-1 (Buenos Aires/Córdoba): light 75% / medium 10% / heavy 10% / moto 5%
 *   Tier-2:                        light 73% / medium 10% / heavy 12% / moto 5%
 *   Rural:                         light 60% / medium 10% / heavy 27% / moto 3%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ar.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ar-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ar`)

// Argentina bbox (with Tierra del Fuego, excluding South Sandwich)
const AR_BBOX: [number, number, number, number] = [-55.5, -73.6, -21.7, -53.6]

// Exclusion zones for neighbours
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // Chile (entire west)
  { name: 'Chile', bbox: [-56.0, -76.0, -17.5, -69.0] },
  // Bolivia (NW corner above ~-22)
  { name: 'Bolivia', bbox: [-22.9, -69.7, -9.5, -57.5] },
  // Paraguay (north of ~-27, between Pilcomayo and Paraguay rivers)
  { name: 'Paraguay', bbox: [-27.6, -62.7, -19.0, -54.2] },
  // Brazil (NE)
  { name: 'Brazil', bbox: [-33.8, -57.7, 5.3, -34.0] },
  // Uruguay (east of Río Uruguay, south of Brazil)
  { name: 'Uruguay', bbox: [-35.0, -58.45, -30.0, -53.0] },
]

// Tier-1 cities (×2.0) — Greater Buenos Aires + Córdoba
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Buenos Aires (Gran BA)', bbox: [-35.05, -58.95, -34.30, -58.20] },
  { name: 'Córdoba', bbox: [-31.55, -64.32, -31.28, -64.05] },
]

// Tier-2 cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Rosario',         bbox: [-33.05, -60.78, -32.85, -60.55] },
  { name: 'Mendoza',         bbox: [-33.00, -68.92, -32.80, -68.72] },
  { name: 'San Miguel de Tucumán', bbox: [-26.92, -65.30, -26.75, -65.10] },
  { name: 'La Plata',        bbox: [-35.00, -58.05, -34.85, -57.85] },
  { name: 'Mar del Plata',   bbox: [-38.10, -57.65, -37.90, -57.45] },
  { name: 'Salta',           bbox: [-24.85, -65.50, -24.70, -65.30] },
  { name: 'Santa Fe',        bbox: [-31.70, -60.78, -31.55, -60.60] },
  { name: 'San Juan',        bbox: [-31.60, -68.60, -31.45, -68.45] },
  { name: 'Resistencia',     bbox: [-27.55, -59.10, -27.40, -58.95] },
  { name: 'Neuquén',         bbox: [-39.00, -68.20, -38.90, -68.00] },
  { name: 'Bahía Blanca',    bbox: [-38.78, -62.35, -38.65, -62.18] },
  { name: 'Posadas',         bbox: [-27.42, -56.00, -27.32, -55.85] },
  { name: 'Corrientes',      bbox: [-27.55, -58.90, -27.40, -58.75] },
  { name: 'Paraná',          bbox: [-31.78, -60.60, -31.65, -60.45] },
  { name: 'Santiago del Estero', bbox: [-27.85, -64.32, -27.72, -64.18] },
  { name: 'San Salvador de Jujuy', bbox: [-24.25, -65.35, -24.15, -65.20] },
  { name: 'Río Cuarto',      bbox: [-33.18, -64.40, -33.05, -64.25] },
  { name: 'Comodoro Rivadavia', bbox: [-45.92, -67.55, -45.78, -67.40] },
  { name: 'San Luis',        bbox: [-33.35, -66.40, -33.22, -66.25] },
  { name: 'La Rioja',        bbox: [-29.48, -66.92, -29.35, -66.78] },
  { name: 'Catamarca',       bbox: [-28.55, -65.85, -28.40, -65.70] },
  { name: 'Formosa',         bbox: [-26.25, -58.25, -26.12, -58.10] },
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function cityTier(lat: number, lon: number): 0 | 1 | 2 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}

// Geometry helpers (planar approx, accurate at AR latitudes)
function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}
function pointToSegmentDist(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat, py = pLat * 110540
  const ax = aLon * 111320 * cosLat, ay = aLat * 110540
  const bx = bLon * 111320 * cosLat, by = bLat * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}
function pointToPolylineDist(pLat: number, pLon: number, coords: [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    if (d < best) best = d
  }
  return best
}

interface DnvFeat {
  coords: [number, number][]
  tipo: string         // Ruta / Autopista / Autovía
  superficie: string   // Pavimentado / Consolidado / Tierra
  brNum: string
  isNational: boolean
}

interface TmdaFeat {
  coords: [number, number][]
  aadt: number
  codRuta: string
}

function loadDnv(file: string, isNational: boolean): DnvFeat[] {
  const path = resolve(CACHE_DIR, file)
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: DnvFeat[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g) continue
    let coords: [number, number][] = []
    if (g.type === 'LineString') coords = g.coordinates
    else if (g.type === 'MultiLineString') {
      for (const part of g.coordinates) coords.push(...part)
    }
    if (coords.length < 2) continue
    const p = f.properties || {}
    out.push({
      coords,
      tipo: (p.tipo_de_via_de_transporte || '').toString().trim(),
      superficie: (p.tipo_de_superficie_de_via || '').toString().trim(),
      brNum: (p.designacion_de_red_vial || '').toString().trim(),
      isNational,
    })
  }
  return out
}

function loadTmda(): TmdaFeat[] {
  const path = resolve(CACHE_DIR, 'tmda-2017-18.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: TmdaFeat[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g) continue
    let coords: [number, number][] = []
    if (g.type === 'LineString') coords = g.coordinates
    else if (g.type === 'MultiLineString') {
      for (const part of g.coordinates) coords.push(...part)
    }
    if (coords.length < 2) continue
    const p = f.properties || {}
    const v = p.valor ?? p.tmda17 ?? 0
    const aadt = typeof v === 'number' ? v : parseInt(String(v), 10) || 0
    if (aadt < 50) continue  // discard tiny/zero values
    out.push({
      coords,
      aadt,
      codRuta: (p.cod_ruta || '').toString().trim(),
    })
  }
  return out
}

function buildLineGrid<T extends { coords: [number, number][] }>(features: T[]): Map<string, T[]> {
  const grid = new Map<string, T[]>()
  for (const feat of features) {
    const seen = new Set<string>()
    for (const [lon, lat] of feat.coords) {
      const key = `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`
      if (!seen.has(key)) {
        seen.add(key)
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key)!.push(feat)
      }
    }
  }
  return grid
}

function nearestLine<T extends { coords: [number, number][] }>(
  midLat: number, midLon: number, grid: Map<string, T[]>, radiusM: number,
): { feat: T; dist: number } | null {
  const reach = Math.max(1, Math.ceil(radiusM / 1000))
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
  let best: T | null = null
  let bestDist = radiusM
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const cell = grid.get(`${baseLat + dy}_${baseLon + dx}`)
      if (!cell) continue
      for (const feat of cell) {
        const d = pointToPolylineDist(midLat, midLon, feat.coords)
        if (d < bestDist) { bestDist = d; best = feat }
      }
    }
  }
  return best ? { feat: best, dist: bestDist } : null
}

function dnvAadt(feat: DnvFeat): number {
  const paved = /pavi/i.test(feat.superficie)
  if (!paved) return 3000
  const motorway = /autopista|autov/i.test(feat.tipo)
  if (motorway) return 30000
  return feat.isNational ? 18000 : 12000
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    return {
      light: Math.round(aadt * 0.75),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.10),
      moto: Math.round(aadt * 0.05),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.73),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.12),
      moto: Math.round(aadt * 0.05),
    }
  }
  // Rural — high heavy share for grain/freight/oil corridors
  return {
    light: Math.round(aadt * 0.60),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.27),
    moto: Math.round(aadt * 0.03),
  }
}

async function main() {
  console.log(`=== AR Roads Enrichment — IGN DNV + TMDA 2017-18 + Argentine CNOSSOS (${YEAR}) ===\n`)
  const dnvNat = loadDnv('roads-national.geojson', true)
  const dnvProv = loadDnv('roads-provincial.geojson', false)
  const dnv = [...dnvNat, ...dnvProv]
  console.log(`  DNV national:   ${dnvNat.length}`)
  console.log(`  DNV provincial: ${dnvProv.length}`)
  console.log(`  DNV total:      ${dnv.length}`)

  const tmda = loadTmda()
  console.log(`  TMDA 2017-18:   ${tmda.length} segments with real AADT`)

  const dnvGrid = buildLineGrid(dnv)
  const tmdaGrid = buildLineGrid(tmda)
  console.log(`  DNV grid cells: ${dnvGrid.size}`)
  console.log(`  TMDA grid cells: ${tmdaGrid.size}\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, AR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  AR-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let matchedTmda = 0, matchedDnv = 0, matchedClass = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const roadPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(roadPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const roadClass = table.getChild('road_class')!
    const existingSourceId = table.getChild('source_id')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')
    const sourceId = new Uint16Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(sourceId[i], MY_DATASET_ID)) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, AR_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5

      let aadt = 0
      // 1. TMDA real AADT (best — only for class ≤ 2)
      if (cls <= 2) {
        const t = nearestLine(midLat, midLon, tmdaGrid, 300)
        if (t) {
          aadt = t.feat.aadt * mult
          matchedTmda++
        }
      }
      // 2. DNV class-derived (paved/motorway → 30k, paved/RN → 18k, etc.)
      if (aadt === 0 && cls <= 2) {
        const d = nearestLine(midLat, midLon, dnvGrid, 400)
        if (d) {
          aadt = dnvAadt(d.feat) * mult
          matchedDnv++
        }
      }
      // 3. Argentine class default
      if (aadt === 0) continue  // A.1: unmatched → source_id=0 → engine country-tier cascade

      const split = splitVehicles(aadt, tier)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      sourceId[i] = MY_DATASET_ID
      hexMatched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }

      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
      const newTable = makeTable(columns)
      writeFileSync(roadPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedTmda} TMDA + ${matchedDnv} DNV + ${matchedClass} class`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:        ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip):    ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by TMDA (real):     ${matchedTmda.toLocaleString()}`)
  console.log(`  Matched by DNV class:       ${matchedDnv.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matchedClass.toLocaleString()}`)
  const tot = matchedTmda + matchedDnv + matchedClass
  console.log(`  Total enriched:             ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
