/**
 * Enrich BD industrial with GEM Global Integrated Power (Bangladesh filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Bangladesh'):
 *     360 total / 152 operating / ~27.4 GW
 *     Operating fuel: oil/gas 120 (overwhelmingly gas-dependent), coal 12,
 *     solar 17, hydro 1
 *
 *   Top operating plants:
 *     **Payra 1,320 MW** (coal, Patuakhali — CPEC/Chinese S-Kexin, 2×660 MW)
 *     **Rampal 1,320 MW** (coal, Bagerhat — India-BD joint venture BIFPCL)
 *     **Banshkhali 1,320 MW** (coal, Chittagong coast — SS Power I)
 *     **Matarbari 1,200 MW** (coal, Cox's Bazar — JICA Japanese-funded ultra-supercritical)
 *     **Kaptai 230 MW** (hydro, Rangamati — Bangladesh's ONLY hydro plant,
 *                        on Karnaphuli River, built 1962, massive reservoir)
 *     **Bibiyana CCPP ~800 MW** (gas, Habiganj — largest gas field, Chevron)
 *     **Ghorasal CCPP ~990 MW** (gas, Narsingdi — oldest gas plant, rehabilitated)
 *     **Ashuganj CCPP ~600 MW** (gas, B.Baria — east-bank power hub)
 *
 * Non-power industrial (OSM only):
 *   - **RMG (Ready-Made Garments)**: Dhaka/Gazipur/Narayanganj —
 *     world's #2 garment exporter after China, ~$45B/year, 4,500+ factories,
 *     employs ~4M workers (mostly women). BGMEA member factories.
 *   - **Eastern Refinery** (Chittagong/Patenga) — Bangladesh's only oil
 *     refinery, ~1.5 MT/yr, Bangladesh Petroleum Corporation.
 *   - **Cement**: Shah Cement (Munsiganj), Bashundhara Cement, LafargeHolcim
 *     (Chhatak, Sylhet — uses Indian limestone via conveyor).
 *   - **Ship-breaking** (Sitakunda, Chittagong) — world's #2 after Alang India;
 *     200+ breaking yards, ~6M LDT/yr, notorious for labour/environmental issues.
 *   - **Chittagong Port** (Chattogram Port) — Bangladesh's main seaport,
 *     handles ~92% of national trade, ~3M TEU/yr.
 *   - **Mongla Port** (Khulna division) — second seaport, handles Indian
 *     transit cargo.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bd.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/bd`)

// Bangladesh bbox [minLat, minLon, maxLat, maxLon]
const BD_BBOX: [number, number, number, number] = [20.6, 88.0, 26.65, 92.7]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // India W — west of 88.4 above lat 24
  [24.0, 88.0, 26.65, 88.4],
  // India NW — north of 25.5 west of 90
  [25.5, 88.0, 26.65, 90.0],
  // India NE — northeast of lat 25 east of 91.5
  [25.0, 91.5, 26.65, 92.7],
  // Myanmar SE — east of 92.3 below lat 21.5
  [20.6, 92.3, 21.5, 92.7],
]

function inExcluded(lat: number, lon: number): boolean {
  for (const b of EXCLUDE_ZONES) if (inBbox(lat, lon, b)) return true
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
    if (!inBbox(lat, lon, BD_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'BD plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== BD Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in BD: ${plants.length}`)
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
      if (inBbox(lat, lon, BD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  BD-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, BD_BBOX) || inExcluded(lat, lon)) continue

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
