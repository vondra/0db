/**
 * Enrich PY industrial with GEM (Paraguay-flagged + cross-border hydro).
 *
 * Paraguay is **99% hydropower-generated** (~30 TWh/year) but generates
 * roughly 20-25× its own consumption — massive electricity exporter. All
 * the heavy lifting is done by two binational dams:
 *
 *   - **Itaipú** (14 GW, Paraguay/Brazil, on Río Paraná at Ciudad del Este
 *     / Foz do Iguaçu) — world's 2nd largest hydro plant. Flagged as
 *     Country_area='Brazil' in GEM but the dam straddles the border.
 *     Paraguay owns 50% of the power; consumes ~10%, exports ~90% to Brazil.
 *
 *   - **Yacyretá** (3.1 GW, Paraguay/Argentina, on Río Paraná at Encarnación
 *     / Posadas). Flagged as Country_area='Argentina' in GEM. Paraguay owns
 *     50%; consumes small share, exports most to Argentina.
 *
 *   - **Acaray** (210 MW + 48 MW expansion, Alto Paraná, 100% Paraguay)
 *
 * Other GEM Paraguay entries are tiny (Frigorífico Guaraní 1 MW, Filadelfia
 * 1 MW, Paracel 220 MW pre-construction, PASH/ERIH solar announced).
 *
 * Non-power industrial is minimal:
 *   - INC Vallemí cement (Concepción)
 *   - Cervepar Pilsen brewery (Itauguá)
 *   - Cargill/ADM soy processors (Asunción, Minga Guazú, Villeta)
 *   - No refinery (PETROPAR imports via pipeline from Brazil)
 *   - No steel, mining, chemicals
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-py.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/py`)

// Paraguay bbox
const PY_BBOX: [number, number, number, number] = [-27.7, -62.7, -19.3, -54.2]

// Don't over-exclude neighbours since Paraguay is narrow and the two
// mega-dams are exactly on the borders
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Brazil (NE) — east of -55 and north of -22
  [-22.0, -54.5, -19.3, -53.0],
  // Argentina (SW) — south of -27.5 west of -58
  [-28.0, -62.7, -27.5, -57.0],
  // Bolivia (NW Chaco) — north of -21
  [-21.0, -62.7, -19.3, -57.5],
]

// Expand bbox slightly to include Itaipú + Yacyretá border plants
function inPyOrBorder(lat: number, lon: number): boolean {
  if (lat < PY_BBOX[0] || lat > PY_BBOX[2] || lon < PY_BBOX[1] || lon > PY_BBOX[3]) return false
  // Only exclude strict exclusion zones, not Paraguay mainland
  for (const b of EXCLUDE_ZONES) {
    if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) return false
  }
  return true
}

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function flatDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

interface IndSite { lat: number; lon: number; name: string; fuel: string }

function loadPlants(file: string): IndSite[] {
  const path = resolve(CACHE_DIR, file)
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates || []
    if (lat == null || lon == null) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    const name = (p.Plant___Project_name || 'PY plant').toString()
    // For border file, explicitly include Itaipú and Yacyretá
    const isCrossBorder = /itaip|yacyret|acaray/i.test(name)
    if (!inPyOrBorder(lat, lon) && !isCrossBorder) continue
    // For false positives (Finland Savitaipale), skip
    if (!/itaip|yacyret|acaray|paraguay|asunci|paraná|paran|ciudad del este|encarnaci|alto paraná/i.test(name) && !inPyOrBorder(lat, lon)) continue
    out.push({
      lat, lon,
      name,
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== PY Industrial Enrichment — GEM + cross-border hydro (${YEAR}) ===\n`)

  const pyPlants = loadPlants('power-plants-gem-py.geojson')
  const borderPlants = loadPlants('power-plants-gem-border.geojson')

  // Merge by coordinate (Acaray may be in both)
  const seen = new Set<string>()
  const allPlants: IndSite[] = []
  for (const s of [...pyPlants, ...borderPlants]) {
    const key = `${s.lat.toFixed(4)}_${s.lon.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    allPlants.push(s)
  }
  console.log(`  GEM operating plants (PY + cross-border): ${allPlants.length}`)
  for (const p of allPlants) {
    console.log(`    ${p.fuel.padEnd(12)} ${p.name.substring(0, 50)} @ (${p.lat.toFixed(2)}, ${p.lon.toFixed(2)})`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of allPlants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('py-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, PY_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  PY-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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

          // 3 km search radius (Itaipú + Yacyretá are massive)
          const searchRadius = 3000
          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: IndSite | null = null
          let bestDist = searchRadius
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
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
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
