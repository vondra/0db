/**
 * Enrich MX industrial with GEM Global Integrated Power (Mexico filter).
 *
 * CFE (Comisión Federal de Electricidad) and CENACE publish operational data
 * in proprietary formats without machine-readable coordinates.
 * GEM is the best machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mexico'):
 *     448 operating plants
 *
 *   Notable operating plants:
 *     **Laguna Verde nuclear 2×800 MW**      (nuclear — Veracruz; Mexico's only nuclear plant)
 *     **El Cajón hydro 750 MW**              (hydro — Nayarit, Santiago River)
 *     **La Yesca hydro 750 MW**              (hydro — Nayarit/Jalisco; CFE)
 *     **Chicoasén hydro 2,400 MW**           (hydro — Chiapas, Grijalva River; largest hydro)
 *     **Manzanillo CC gas 2,100 MW**         (gas — Colima coast; largest CCGT)
 *     **Altamira CC gas 1,036 MW**           (gas — Tamaulipas)
 *     **Iberdrola Hermosillo gas 277 MW**    (gas — Sonora)
 *     **Villanueva solar 754 MW**            (solar — Coahuila; one of largest in LatAm)
 *     **Don José solar 238 MW**              (solar — Guanajuato)
 *     **Eólica del Sur wind 396 MW**         (wind — Oaxaca Isthmus; largest wind farm)
 *     **La Venta wind complex ~300 MW**      (wind — Oaxaca Isthmus)
 *     **Energía Sierra Juárez wind 155 MW**  (wind — Baja California)
 *
 * Non-power industrial (OSM only):
 *   - **Oil/gas** — PEMEX: Campeche offshore (Cantarell, KMZ); Veracruz refineries
 *     (Minatitlán, Tuxpan); Salamanca (Guanajuato); Dos Bocas new refinery (Tabasco)
 *   - **Mining** — silver (Durango, Zacatecas: Fresnillo plc, largest silver producer);
 *     copper (Sonora: Buenavista del Cobre/Cananea, ASARCO); gold (Guerrero, Sonora);
 *     iron (Michoacán, Colima): Las Truchas smelter (Sicartsa)
 *   - **Automotive** — major assembly: Puebla (VW), Silao (GM), Toluca (Chrysler),
 *     Monterrey (KIA), San Luis Potosí (BMW, GM); huge auto parts belt
 *   - **Cement** — CEMEX (world's 3rd largest; HQ Monterrey); Cruz Azul, Cementos Moctezuma
 *   - **Steel** — Ternium (Monterrey, Puebla): Monterrey is Mexico's industrial capital
 *   - **Food processing** — MASECA corn flour (Gruma); Grupo Bimbo (Mexico City)
 *   - **Chemicals** — Bayer, BASF, Mexichem (Coatzacoalcos, Veracruz petrochemical cluster)
 *   - **Textiles/Maquila** — Monterrey, Juárez, Tijuana, Laredo border strip
 *
 * MX_BBOX: [minLat=14.5, minLon=-118.5, maxLat=32.7, maxLon=-86.7]
 * Excludes: lat>32.8 (US), lat<14.5 (Guatemala), lon<-118.5 (Pacific), lon>-86.5 (Caribbean)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mx.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'
import { flatDistM, inBbox } from './lib/spatial.js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/mx`)

// Mexico bbox: [minLat, minLon, maxLat, maxLon]
const MX_BBOX: [number, number, number, number] = [14.5, -118.5, 32.7, -86.7]

/**
 * Returns true if the point is clearly outside Mexico — i.e. belongs to
 * a neighbouring country that overlaps the Mexico bounding box.
 */
function isExcluded(lat: number, lon: number): boolean {
  // US north
  if (lat > 32.8) return true
  // Guatemala/Belize south
  if (lat < 14.5) return true
  // Pacific (past Baja tip)
  if (lon < -118.5) return true
  // Caribbean (past Yucatán)
  if (lon > -86.5) return true
  return false
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
    if (!inBbox(lat, lon, MX_BBOX)) continue
    if (isExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'MX plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== MX Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in MX: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

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
      if (inBbox(lat, lon, MX_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  MX-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, MX_BBOX)) continue
          if (isExcluded(lat, lon)) continue
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
