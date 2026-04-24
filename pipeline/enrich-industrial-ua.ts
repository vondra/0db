/**
 * Enrich UA industrial with GEM Global Integrated Power (Ukraine filter).
 *
 * NOTE: Ukraine has been under Russian invasion since February 2022.
 * This enrichment represents **pre-war baseline** data from GEM.
 * Actual noise conditions in occupied/frontline areas are drastically different.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ukraine'):
 *     811 total / 615 operating / ~34.1 GW
 *     MASSIVE solar buildout: 522 solar plants.
 *     Nuclear 15 (13,000 MW — Europe's 3rd largest nuclear fleet):
 *       Zaporizhzhia 6,000 MW — RUSSIAN-OCCUPIED since March 2022,
 *         Europe's largest nuclear plant, world's most dangerous nuclear situation.
 *       Khmelnitski 2,000 MW
 *       Rivne 2,000 MW
 *       South Ukraine 3,000 MW
 *     Coal 25, gas 25, wind 18.
 *     Hydro 10 (Dnipro cascade):
 *       Dnister pumped-storage 1,296 MW
 *       Dnipro-2 888 MW
 *       Kremenchuk 700 MW
 *       Kaniv 493 MW
 *       NOTE: Kakhovka Dam DESTROYED June 2023 by Russia — catastrophic flooding.
 *     ONGOING WAR — many plants damaged, destroyed, or occupied.
 *
 *   Non-power industrial (OSM only):
 *     - ArcelorMittal Kryvyi Rih (steel)
 *     - Metinvest Mariupol — Azovstal DESTROYED in 2022 siege
 *     - Zaporizhstal (steel, frontline city)
 *     - Naftogaz / UKRNAFTA (oil/gas)
 *     - Energoatom (nuclear operator)
 *     - Kremenchuk refinery — DESTROYED by Russian strikes
 *     - Lysychansk refinery — DESTROYED
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ua.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ua`)

// Ukraine bbox [minLat, minLon, maxLat, maxLon]
const UA_BBOX: [number, number, number, number] = [44.3, 22.1, 52.4, 40.3]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Russia N/E — above lat 52.0 east of 40.0
  [52.0, 40.0, 52.4, 40.3],
  // Belarus N — above lat 51.5 west of 34
  [51.5, 22.1, 52.4, 34.0],
  // Poland W — west of 23.5 above lat 49
  [49.0, 22.1, 52.4, 23.5],
  // Slovakia SW — west of 22.5 below lat 49
  [44.3, 22.1, 49.0, 22.5],
  // Hungary SW — west of 22.5 below lat 48.5
  [44.3, 22.1, 48.5, 22.5],
  // Romania SW — west of 23.5 below lat 48
  [44.3, 22.1, 48.0, 23.5],
  // Moldova SW — west of 27.5 below lat 46.5 above lat 45.5
  [45.5, 22.1, 46.5, 27.5],
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
    if (!inBbox(lat, lon, UA_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'UA plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== UA Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)
  console.log(`  NOTE: Pre-war baseline. Occupied/frontline areas drastically different.\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in UA: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('ua-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, UA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UA-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, UA_BBOX) || inExcluded(lat, lon)) continue

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
