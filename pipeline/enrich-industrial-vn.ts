/**
 * Enrich VN industrial with GEM Global Integrated Power (Vietnam subset).
 *
 * Source: services.arcgis.com/lqRTrQp2HrfnJt8U/.../Global_Integrated_Power_
 * August_2025/FeatureServer/0?where=Country_area='Vietnam'
 *
 * 1,492 Vietnam plants total, **874 operating** (59% of the catalogue —
 * highest ratio of any country enriched so far, reflecting Vietnam's recent
 * solar/wind boom since 2019):
 *   - Solar: 683 (Ninh Thuan, Dak Lak, Long An, Binh Thuan — 20+ GW installed)
 *   - Wind: 398 (Bac Lieu, Soc Trang, Ca Mau offshore, Quang Tri)
 *   - Coal: 197 (Pha Lai, Quang Ninh, Vinh Tan, Duyen Hai, Mong Duong)
 *   - Gas: 115 (Phu My complex, Nhon Trach, Ca Mau)
 *   - Hydro: 86 (Son La 2.4 GW — SE Asia's largest, Lai Chau 1.2 GW, Hoa Binh 1.92 GW, Tuyen Quang, Yaly, Tri An)
 *   - Nuclear: 8 (never operational, cancelled projects)
 *   - Bioenergy: 5
 *
 * All map to NACE 35.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-vn.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/vn`)

const VN_BBOX: [number, number, number, number] = [8.3, 102.1, 23.5, 109.5]
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  [22.5, 102.1, 23.5, 109.5],  // China border
  [13.5, 102.1, 22.5, 104.3],  // Laos
  [10.0, 102.1, 14.5, 107.0],  // Cambodia
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

function loadPlants(): IndSite[] {
  const path = resolve(CACHE_DIR, 'power-plants.geojson')
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const [lon, lat] = g.coordinates
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, VN_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (status && status !== 'operating') continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || p.Name || 'VN power plant').toString(),
      fuel: (p.Type || p.Fuel || 'unknown').toString(),
    })
  }
  return out
}

async function main() {
  console.log(`=== VN Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)
  const plants = loadPlants()
  console.log(`  Operating power plants: ${plants.length}`)

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('vn-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, VN_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  VN-bbox hexes with industrial.arrow: ${hexDirs.length}`)

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
          if (!inBbox(lat, lon, VN_BBOX) || inExcluded(lat, lon)) continue

          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: IndSite | null = null
          let bestDist = 1500
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
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

  console.log(`\n=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched to GEM:               ${matched.toLocaleString()}`)
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
