/**
 * Enrich BR roads.arrow with DNIT federal highways + Brazilian-tuned CNOSSOS.
 *
 * Source: DNIT (Departamento Nacional de Infraestrutura de Transportes) via
 * public ArcGIS Online mirror:
 *   services3.arcgis.com/KYEMegXJrTiWSYWk/arcgis/rest/services/
 *   RODOVIAS_FEDERAIS_DNIT_2017/FeatureServer/0
 *
 * Records: 7,607 polyline segments of Brazilian federal highways (BR-series)
 * Fields: Codigo_BR (BR number, e.g. 101, 116, 040), Unidade_Fe (state),
 *         Sigla_Tipo (type), Codigo_SNV, Quilometragem, Extensao, Superficie
 *         (PAV=paved, IMP=unpaved, PLA=planned, OBR=under construction),
 *         Administra (Federal / Concessionada)
 *
 * No per-segment AADT available (DNIT PNCT exists at servicos.dnit.gov.br but
 * is geo-blocked from non-BR IPs). Use class-based default AADT scaled for
 * Brazilian traffic patterns.
 *
 * ## Brazilian AADT defaults
 *
 *   | OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
 *   |---|---:|---:|---:|
 *   | 0 motorway (rodovia federal dual-carriageway) | 50,000 | 100,000 | 70,000 |
 *   | 1 trunk (BR-series, concession toll rod) | 25,000 | 50,000 | 35,000 |
 *   | 2 primary | 12,000 | 24,000 | 16,800 |
 *   | 3 secondary | 5,000 | 10,000 | 7,000 |
 *   | 4 tertiary | 2,000 | 4,000 | 2,800 |
 *   | 5 residential | 1,000 | 2,000 | 1,400 |
 *
 * DNIT spatial-match AADT (by Superficie + Administra):
 *   PAV Federal concessionada (concession toll) → 35,000 × tier
 *   PAV Federal (paved federal)                  → 25,000 × tier
 *   Outros (unpaved / planned / construction)    → 3,000 × tier
 *
 * ## Brazilian vehicle split
 *
 * Brazil has a lower motorcycle share than Southeast Asia but much higher
 * heavy-vehicle share (agricultural freight, iron ore, soy, mining).
 *
 *   Tier-1 (SP/Rio/Brasília/BH):  light 70% / medium 10% / heavy 15% / moto 5%
 *   Tier-2:                       light 70% / medium 10% / heavy 15% / moto 5%
 *   Rural:                        light 60% / medium 10% / heavy 25% / moto 5%
 *
 * ## Exclusion zones
 *
 * Brazil shares borders with 10 neighbours. Tight bboxes for each.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-br.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_BR_NATIONAL_ROADS } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_BR_NATIONAL_ROADS

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/br`)

// Brazil bbox
const BR_BBOX: [number, number, number, number] = [-34.0, -74.0, 5.3, -34.8]

// Exclusion zones for neighbouring countries
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // Argentina (south of 22°S west of Uruguay + south-west)
  { name: 'Argentina', bbox: [-56.0, -74.0, -22.0, -53.7] },
  // Uruguay (between Argentina and BR south edge)
  { name: 'Uruguay', bbox: [-35.0, -58.5, -30.1, -53.1] },
  // Paraguay (west of BR, south of -19°)
  { name: 'Paraguay', bbox: [-27.7, -62.7, -19.3, -54.2] },
  // Bolivia (west of Amazon)
  { name: 'Bolivia', bbox: [-23.0, -69.7, -9.7, -57.5] },
  // Peru (west edge)
  { name: 'Peru', bbox: [-18.4, -82.0, -0.0, -68.5] },
  // Colombia (NW edge)
  { name: 'Colombia', bbox: [-4.2, -79.1, 13.0, -66.8] },
  // Venezuela (north edge)
  { name: 'Venezuela', bbox: [0.6, -73.4, 13.0, -59.8] },
  // Guyana (NE edge)
  { name: 'Guyana', bbox: [1.2, -61.4, 8.7, -56.5] },
  // Suriname (NE edge)
  { name: 'Suriname', bbox: [1.8, -58.1, 6.1, -53.9] },
  // French Guiana (NE edge)
  { name: 'French Guiana', bbox: [2.1, -54.6, 5.8, -51.6] },
  // Chile (far west)
  { name: 'Chile', bbox: [-56.0, -76.0, -17.5, -66.4] },
  // Ecuador (far NW)
  { name: 'Ecuador', bbox: [-5.0, -81.0, 1.5, -75.2] },
]

// Tier-1 Brazilian metros (×2.0)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'São Paulo (Grande SP)', bbox: [-23.85, -46.9, -23.4, -46.3] },
  { name: 'Rio de Janeiro', bbox: [-23.0, -43.8, -22.7, -43.1] },
  { name: 'Brasília', bbox: [-16.0, -48.05, -15.7, -47.8] },
  { name: 'Belo Horizonte', bbox: [-19.95, -44.1, -19.75, -43.85] },
]

// Tier-2 Brazilian cities (×1.4)
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Salvador', bbox: [-13.0, -38.6, -12.85, -38.4] },
  { name: 'Fortaleza', bbox: [-3.85, -38.65, -3.7, -38.45] },
  { name: 'Curitiba', bbox: [-25.55, -49.35, -25.35, -49.15] },
  { name: 'Manaus', bbox: [-3.15, -60.1, -3.0, -59.9] },
  { name: 'Recife', bbox: [-8.1, -35.0, -7.95, -34.85] },
  { name: 'Porto Alegre', bbox: [-30.15, -51.3, -29.95, -51.1] },
  { name: 'Goiânia', bbox: [-16.75, -49.35, -16.6, -49.2] },
  { name: 'Belém', bbox: [-1.5, -48.55, -1.35, -48.4] },
  { name: 'Guarulhos', bbox: [-23.5, -46.55, -23.4, -46.4] },
  { name: 'Campinas', bbox: [-22.95, -47.1, -22.85, -47.0] },
  { name: 'São Luís', bbox: [-2.6, -44.35, -2.5, -44.2] },
  { name: 'Maceió', bbox: [-9.7, -35.8, -9.55, -35.65] },
  { name: 'Natal', bbox: [-5.85, -35.25, -5.75, -35.15] },
  { name: 'Campo Grande', bbox: [-20.5, -54.7, -20.4, -54.55] },
  { name: 'Teresina', bbox: [-5.13, -42.85, -5.05, -42.75] },
  { name: 'João Pessoa', bbox: [-7.17, -34.93, -7.07, -34.83] },
  { name: 'Nova Iguaçu', bbox: [-22.8, -43.5, -22.7, -43.4] },
  { name: 'São Bernardo', bbox: [-23.75, -46.6, -23.65, -46.5] },
  { name: 'Santo André', bbox: [-23.7, -46.6, -23.6, -46.5] },
  { name: 'Osasco', bbox: [-23.56, -46.82, -23.46, -46.72] },
  { name: 'Ribeirão Preto', bbox: [-21.2, -47.85, -21.1, -47.75] },
  { name: 'Uberlândia', bbox: [-18.95, -48.35, -18.85, -48.25] },
  { name: 'Sorocaba', bbox: [-23.55, -47.5, -23.45, -47.4] },
  { name: 'São José dos Campos', bbox: [-23.25, -45.95, -23.15, -45.85] },
  { name: 'Niterói', bbox: [-22.92, -43.15, -22.85, -43.05] },
  { name: 'Contagem', bbox: [-19.95, -44.12, -19.85, -44.02] },
  { name: 'Joinville', bbox: [-26.35, -48.9, -26.25, -48.8] },
  { name: 'Aracaju', bbox: [-10.97, -37.1, -10.87, -37.0] },
  { name: 'Cuiabá', bbox: [-15.63, -56.15, -15.53, -56.05] },
  { name: 'Florianópolis', bbox: [-27.65, -48.6, -27.55, -48.5] },
  { name: 'Vitória', bbox: [-20.35, -40.35, -20.25, -40.25] },
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

// Geometry
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

interface DnitFeat {
  coords: [number, number][]
  surficie: string
  administra: string
  brNum: string
}

function loadDnit(): DnitFeat[] {
  const path = resolve(CACHE_DIR, 'dnit-federal-highways.geojson')
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: DnitFeat[] = []
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
      surficie: (p.Superficie || '').toString().trim(),
      administra: (p.Administra || '').toString().trim(),
      brNum: (p.Codigo_BR || '').toString().trim(),
    })
  }
  return out
}

function buildGrid(features: DnitFeat[]): Map<string, DnitFeat[]> {
  const grid = new Map<string, DnitFeat[]>()
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

function nearestDnit(midLat: number, midLon: number, grid: Map<string, DnitFeat[]>, radiusM: number): DnitFeat | null {
  const reach = Math.max(1, Math.ceil(radiusM / 1000))
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
  let best: DnitFeat | null = null
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
  return best
}

function dnitAadt(feat: DnitFeat): number {
  const paved = feat.surficie === 'PAV' || feat.surficie === 'PAVI'
  if (!paved) return 3000
  const concession = feat.administra.includes('oncess')
  if (concession) return 35000
  return 25000
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1 || tier === 2) {
    return {
      light: Math.round(aadt * 0.70),
      medium: Math.round(aadt * 0.10),
      heavy: Math.round(aadt * 0.15),
      moto: Math.round(aadt * 0.05),
    }
  }
  // Rural — higher heavy share for agribusiness/mining freight
  return {
    light: Math.round(aadt * 0.60),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.25),
    moto: Math.round(aadt * 0.05),
  }
}

async function main() {
  console.log(`=== BR Roads Enrichment — DNIT + Brazilian-tuned CNOSSOS (${YEAR}) ===\n`)
  const dnit = loadDnit()
  console.log(`  DNIT loaded: ${dnit.length}`)
  const grid = buildGrid(dnit)
  console.log(`  Grid cells: ${grid.size}\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, BR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  BR-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let matchedDnit = 0, matchedClass = 0
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
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, BR_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5

      let aadt = 0
      // DNIT spatial match only for class ≤ 2
      if (cls <= 2) {
        const near = nearestDnit(midLat, midLon, grid, 400)
        if (near) {
          aadt = dnitAadt(near) * mult
          matchedDnit++
        }
      }
      if (aadt === 0) continue  // A.1: unmatched → source_id=0 → engine country-tier cascade

      const split = splitVehicles(aadt, tier)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      sourceId[i] = MY_SOURCE_ID
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
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedDnit} DNIT + ${matchedClass} class`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:        ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip):    ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by DNIT:            ${matchedDnit.toLocaleString()}`)
  console.log(`  Matched by class default:   ${matchedClass.toLocaleString()}`)
  const tot = matchedDnit + matchedClass
  console.log(`  Total enriched:             ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:              ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
