/**
 * Enrich OM industrial with GEM Global Integrated Power (Oman filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Oman'):
 *     123 total / 52 operating / ~15.5 GW
 *     Operating fuel: oil/gas 43 (gas-dominant), solar 8, wind 1
 *
 *   Top operating plants:
 *     **Sohar III 1,740 MW** (2×870 MW CCGT, Sohar industrial port)
 *     **Ibri IPP 1,539 MW** (largest single IPP, Al Dhahirah)
 *     **Sur 1,600 MW** (2×800 MW CCGT, Sur industrial area)
 *     **Barka III + Sohar II + Barka II + Barka I + Sohar** —
 *                         massive coastal CCGT corridor (Al Batinah coast)
 *     **Al Mazyunah solar ~430 MW** + **Ibri 2 solar ~500 MW** +
 *     **Manah solar ~628 MW** — ~1,558 MW solar portfolio
 *     **Dhofar Wind 50 MW** — Oman's first utility-scale wind farm (Dhofar)
 *     **Sohar Aluminium 1,000 MW** — captive gas turbine plant
 *
 * Non-power industrial (OSM only):
 *   - **Oman LNG** (Qalhat, near Sur) — 6.6 Mtpa LNG export terminal
 *   - **Sohar Industrial Port** — mega-port complex: Oman Refinery Company
 *     (ORPIC, 198k bpd), petrochemicals (Oman Polymers/Aromatics),
 *     OHPC (HDPE/LLDPE), Sohar Aluminium 390 ktpa, steel, fertilizers
 *   - **Mina al-Fahal refinery** (Muscat, Qurum) — 106k bpd, operated by OQ
 *   - **PDO** (Petroleum Development Oman — Shell/Total/Partex partnership)
 *     — main oil/gas operator, fields across interior (Fahud, Yibal, Nimr)
 *   - **Duqm** — new $10B industrial port city (Special Economic Zone):
 *     Duqm Refinery 230k bpd (OQ + Kuwait Petroleum), petrochemicals, shipyard
 *   - **Raysut Cement** (Salalah, Dhofar) — largest cement producer in Oman
 *   - **Port of Salalah** — major transshipment hub (container + LPG)
 *
 * NOTE: NO RAILWAY. Oman Rail 2,135 km was planned but never built.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-om.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/om`)

// Oman bbox [minLat, minLon, maxLat, maxLon]
// Includes Musandam exclave (~26.2N 56.3E) separated from mainland by UAE
const OM_BBOX: [number, number, number, number] = [16.6, 51.9, 26.4, 59.9]

// UAE N exclude zone covers UAE mainland territory west of Musandam.
// Musandam exclave is at ~26.2N 56.3E — to avoid filtering it, the UAE exclude
// lon upper bound is set to 56.1 (Musandam starts east of ~56.1E).
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // UAE N — above lat 24.7 west of 56.1 (Musandam exclave at ~56.3E is intentionally preserved)
  [24.7, 51.9, 26.4, 56.1],
  // Yemen SW — below lat 18.0 west of 54.5
  [16.6, 51.9, 18.0, 54.5],
  // Yemen SE — below lat 16.8 east of 52.5
  [16.6, 52.5, 16.8, 59.9],
  // Saudi Arabia W — west of 55 above lat 18.5 below lat 23
  [18.5, 51.9, 23.0, 55.0],
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
    if (!inBbox(lat, lon, OM_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'OM plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== OM Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in OM: ${plants.length}`)
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
      if (inBbox(lat, lon, OM_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  OM-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, OM_BBOX) || inExcluded(lat, lon)) continue

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
