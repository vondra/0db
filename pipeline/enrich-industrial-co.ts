/**
 * Enrich CO industrial with GEM + ANM Mining Titles + ANH Oil/Gas Blocks.
 *
 * Sources:
 *   - **GEM Global Integrated Power v1** (Country_area='Colombia'):
 *       services.arcgis.com/P3ePLMYs2RVChkJx/.../Global_Integrated_Power_v1/FeatureServer/0
 *     937 plants total, **251 operating**
 *     Top: Guavio 1250 MW, San Carlos 1240 MW, Hidroituango 1200 MW,
 *     Chivor 1000 MW, Sogamoso 820 MW, Termobarranquilla 791 MW
 *     Fuel breakdown (operating): hydro 49, oil/gas 43, coal 23, solar 705
 *     (mostly pre-construction), wind 114, bioenergy 2
 *     → NACE 35
 *
 *   - **ANM Títulos Mineros 2023**: 7,541 polygons of mining concessions
 *       services9.arcgis.com/pZylgd2zhNey2qXF/.../Titulos_mineros_vigentes__2023__Colombia
 *     5,758 in `Explotación` (active), 1,145 `Exploración`, 329 `Construcción`
 *     Mineral types (top): MINERALES DE ORO (985), ANHIDRITA/CARBÓN (821),
 *     ARENAS/GRAVAS (740), CARBÓN METALÚRGICO (584), ARENAS DE RIO (409),
 *     ARCILLAS (316), MINERALES DE COBRE (298), ANTRACITA/CARBÓN (284)
 *     Mapped to NACE codes:
 *       - Coal/anthracite/coking coal → **NACE 05**
 *       - Metals (gold/copper/silver/iron) → **NACE 07**
 *       - Sand/gravel/clay/quarry → **NACE 08**
 *
 *   - **ANH Hidrocarburos 2023**: 445 oil/gas production blocks
 *       services9.arcgis.com/pZylgd2zhNey2qXF/.../Explotacion_de_hidrocarburos_2023__ANH_
 *     236 in PRODUCCION (active), 202 EXPLORACION
 *     Operators: Ecopetrol, Occidental, Parex, GeoPark, Frontera Energy
 *     Cuencas: Llanos (Cusiana/Cupiagua), VMM, Catatumbo (Caño Limón),
 *              Putumayo, Caguán-Putumayo
 *     → **NACE 06** (Extraction of crude petroleum and natural gas)
 *
 * Polygon-based matching: for ANM titles and ANH blocks, we check whether
 * the OSM industrial centroid falls inside the polygon (point-in-polygon).
 * For point-based GEM plants, we use the nearest-neighbour 2km lookup.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-co.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/co`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

const CO_BBOX: [number, number, number, number] = [-4.3, -82.0, 13.5, -66.8]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  [0.6, -72.5, 12.5, -59.0],   // Venezuela
  [-4.3, -70.0, -1.0, -66.5],  // Brazil
  [-18.4, -82.0, -1.5, -69.0], // Peru
  [-5.0, -82.0, 1.5, -75.0],   // Ecuador
  [7.2, -83.0, 9.7, -77.2],    // Panama
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

// Point-in-polygon (ray casting)
function pointInRing(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

interface Site {
  lat: number; lon: number; name: string; nace: string; source: string
}

interface PolySite {
  rings: [number, number][][]  // [outer, hole1, hole2, ...] but we treat all as outer
  bbox: [number, number, number, number]  // minLat, minLon, maxLat, maxLon
  name: string
  nace: string
  source: string
}

function loadGemPlants(): Site[] {
  const path = resolve(CACHE_DIR, 'power-plants-gem.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: Site[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, CO_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    const fuel = (p.Type || 'unknown').toString().toLowerCase()
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CO plant').toString(),
      nace: '351100',
      source: `GEM CO (${fuel})`,
    })
  }
  return out
}

function classifyMineral(minerales: string): string {
  const m = minerales.toUpperCase()
  // Coal classifications → NACE 05
  if (/CARBÓN|CARBON|ANTRACITA|HULLA|LIGNITO|TURBA/.test(m)) return '05'
  // Metal ores → NACE 07
  if (/ORO|COBRE|HIERRO|PLATA|ZINC|PLOMO|NIQUEL|PLATIN|MOLIBDENO|MANGANESO|COBALTO|ESTAÑO|TUNGSTENO|MERCURIO|EMERALDA|ESMERALDA/.test(m)) return '07'
  // Stone, sand, clay → NACE 08
  if (/ARENA|GRAVA|ARCILLA|CALIZA|MARMOL|GRANITO|YESO|FELDESPATO|CAOLIN|RECEBO|ROCA|CANTERA|BENTONITA|DOLOMITA|ANHIDRITA|FOSFORICA/.test(m)) return '08'
  // Default to metal mining
  return '07'
}

function loadMiningPolys(): PolySite[] {
  const path = resolve(CACHE_DIR, 'mining-titles.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: PolySite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g) continue
    let polys: [number, number][][][] = []
    if (g.type === 'Polygon') polys = [g.coordinates]
    else if (g.type === 'MultiPolygon') polys = g.coordinates
    else continue
    const p = f.properties || {}
    const etapa = (p.ETAPA || '').toString()
    // Only enrich active mines (Explotación + Construcción)
    if (!/Explotaci|Construcci/i.test(etapa)) continue
    const minerales = (p.MINERALES || '').toString()
    const nace = classifyMineral(minerales)
    const name = `Mina ${(p.MUNICIPIOS || '').toString().split(',')[0]} (${minerales.slice(0, 30)})`
    for (const poly of polys) {
      if (!poly || poly.length === 0) continue
      const ring = poly[0]  // outer ring
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat
        if (lon < minLon) minLon = lon
        if (lat > maxLat) maxLat = lat
        if (lon > maxLon) maxLon = lon
      }
      // Skip if entire polygon is outside CO bbox
      if (maxLat < CO_BBOX[0] || minLat > CO_BBOX[2] || maxLon < CO_BBOX[1] || minLon > CO_BBOX[3]) continue
      out.push({
        rings: poly,
        bbox: [minLat, minLon, maxLat, maxLon],
        name,
        nace,
        source: `ANM CO mining (${minerales.slice(0, 20)})`,
      })
    }
  }
  return out
}

function loadOilGasBlocks(): PolySite[] {
  const path = resolve(CACHE_DIR, 'oil-gas-blocks.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: PolySite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g) continue
    let polys: [number, number][][][] = []
    if (g.type === 'Polygon') polys = [g.coordinates]
    else if (g.type === 'MultiPolygon') polys = g.coordinates
    else continue
    const p = f.properties || {}
    const estado = (p.ESTAD_AREA || '').toString().toUpperCase()
    if (!estado.includes('PRODUC')) continue  // Only producing blocks
    const operador = (p.OPERADOR || '').toString()
    const cuenca = (p.CUENCA_SED || '').toString()
    const name = `${p.AREA_NOMBR || 'Bloque'} (${operador}, ${cuenca})`
    for (const poly of polys) {
      if (!poly || poly.length === 0) continue
      const ring = poly[0]
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat
        if (lon < minLon) minLon = lon
        if (lat > maxLat) maxLat = lat
        if (lon > maxLon) maxLon = lon
      }
      if (maxLat < CO_BBOX[0] || minLat > CO_BBOX[2] || maxLon < CO_BBOX[1] || minLon > CO_BBOX[3]) continue
      out.push({
        rings: poly,
        bbox: [minLat, minLon, maxLat, maxLon],
        name,
        nace: '06',  // Extraction of crude petroleum and natural gas
        source: `ANH CO oil/gas (${cuenca})`,
      })
    }
  }
  return out
}

async function main() {
  console.log(`=== CO Industrial Enrichment — GEM + ANM Mining + ANH Oil/Gas (${YEAR}) ===\n`)

  const gemPlants = loadGemPlants()
  console.log(`  GEM operating plants:    ${gemPlants.length}`)

  const miningPolys = loadMiningPolys()
  console.log(`  ANM active mining titles: ${miningPolys.length}`)

  const oilGasPolys = loadOilGasBlocks()
  console.log(`  ANH producing oil/gas blocks: ${oilGasPolys.length}`)

  // Spatial grid for points (GEM)
  const pointGrid = new Map<string, Site[]>()
  for (const s of gemPlants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!pointGrid.has(key)) pointGrid.set(key, [])
    pointGrid.get(key)!.push(s)
  }

  // Spatial grid for polygon bboxes (ANM mining + ANH oil/gas)
  // Each polygon is registered in all 0.5° cells it overlaps
  const polyGrid = new Map<string, PolySite[]>()
  function registerPoly(p: PolySite) {
    const startLat = Math.floor(p.bbox[0] * 2)
    const endLat = Math.floor(p.bbox[2] * 2)
    const startLon = Math.floor(p.bbox[1] * 2)
    const endLon = Math.floor(p.bbox[3] * 2)
    for (let y = startLat; y <= endLat; y++) {
      for (let x = startLon; x <= endLon; x++) {
        const key = `${y}_${x}`
        if (!polyGrid.has(key)) polyGrid.set(key, [])
        polyGrid.get(key)!.push(p)
      }
    }
  }
  for (const p of miningPolys) registerPoly(p)
  for (const p of oilGasPolys) registerPoly(p)
  console.log(`  Polygon grid cells: ${polyGrid.size}`)

  let existing: Record<string, any> = {}
  if (existsSync(NACE_LOOKUP_PATH)) {
    try { existing = JSON.parse(readFileSync(NACE_LOOKUP_PATH, 'utf-8')) } catch {}
  }
  console.log(`  Existing nace-lookup entries: ${Object.keys(existing).length}`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, CO_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CO-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0, matched = 0, newEntries = 0
  const bySource: Record<string, number> = {}
  const lookup: Record<string, any> = { ...existing }

  for (const hex of hexDirs) {
    try {
      const buf = readFileSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))
      const table = tableFromIPC(buf)
      const n = table.numRows
      if (n === 0) continue
      const osmId = table.getChild('osm_id')
      const centroidLat = table.getChild('centroid_lat') ?? table.getChild('lat')
      const centroidLon = table.getChild('centroid_lon') ?? table.getChild('lon')
      if (!osmId || !centroidLat || !centroidLon) continue

      for (let i = 0; i < n; i++) {
        totalOsm++
        const lat = centroidLat.get(i) as number
        const lon = centroidLon.get(i) as number
        if (lat == null || lon == null) continue
        if (!inBbox(lat, lon, CO_BBOX) || inExcluded(lat, lon)) continue

        let chosen: { nace: string; name: string; source: string } | null = null

        // 1. Point-in-polygon for ANM mining + ANH oil/gas
        const polyKey = `${Math.floor(lat * 2)}_${Math.floor(lon * 2)}`
        const cell = polyGrid.get(polyKey)
        if (cell) {
          for (const p of cell) {
            if (lat < p.bbox[0] || lat > p.bbox[2] || lon < p.bbox[1] || lon > p.bbox[3]) continue
            // Test against outer ring of first polygon
            if (pointInRing(lat, lon, p.rings[0])) {
              chosen = { nace: p.nace, name: p.name, source: p.source }
              break
            }
          }
        }

        // 2. Nearest GEM power plant within 2 km
        if (!chosen) {
          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: Site | null = null
          let bestDist = 2000
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const c = pointGrid.get(`${baseLat + dy}_${baseLon + dx}`)
              if (!c) continue
              for (const s of c) {
                const d = flatDistM(lat, lon, s.lat, s.lon)
                if (d < bestDist) { bestDist = d; best = s }
              }
            }
          }
          if (best) {
            chosen = { nace: best.nace, name: best.name, source: best.source }
          }
        }

        if (chosen) {
          const id = String(osmId.get(i))
          if (!lookup[id]) newEntries++
          lookup[id] = chosen
          matched++
          const family = chosen.source.split(' ')[0]
          bySource[family] = (bySource[family] || 0) + 1
        }
      }
    } catch {}
  }

  writeFileSync(NACE_LOOKUP_PATH, JSON.stringify(lookup, null, 2))
  console.log(`=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched:                      ${matched.toLocaleString()}`)
  console.log(`  By source:`)
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`)
  }
  console.log(`  New nace-lookup entries:      ${newEntries.toLocaleString()}`)
  console.log(`  Total nace-lookup entries:    ${Object.keys(lookup).length.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
