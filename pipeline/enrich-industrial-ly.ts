/**
 * Enrich LY industrial with GEM Global Integrated Power (Libya filter).
 *
 * Libya's National Oil Corporation (NOC) and GECOL publish no open GIS data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Libya'):
 *     72 operating plants, ~14,417 MW total — massive oil/gas generation fleet,
 *     Africa's 4th largest installed capacity.
 *
 *   Notable operating plants:
 *     **West Tripoli CCGT ~2,100 MW**   (gas — largest single plant, Janzour)
 *     **Khoms CCGT ~1,200 MW**          (gas — Mediterranean coast, east of Tripoli)
 *     **Zawiya Power Station ~960 MW**  (gas/oil — Zawiya refinery complex)
 *     **Benghazi North ~800 MW**        (gas — North Benghazi, GECOL)
 *     **Tobruk Power ~480 MW**          (gas/diesel — eastern Libya)
 *     **Derna ~120 MW**                 (gas/diesel — eastern city, badly damaged 2023 floods)
 *     **Sebha ~180 MW**                 (gas — Fezzan, isolated grid)
 *     **Kufra diesel ~30 MW**           (diesel — deep south, off-grid)
 *
 * Non-power industrial (OSM only):
 *   - **Oil production** — Africa's LARGEST proven oil reserves (~48 Gbbl);
 *     Sirte Basin (main fields: El Sharara 300k bbl/day, El Feel/Elephant,
 *     Sarir, Nasser, Waha, Amal); NOC state-owned with IOC partnerships
 *     (ENI, BP, TotalEnergies, ConocoPhillips — many suspended post-2011)
 *   - **LNG export** — Marsa el Brega (Esso/ENI JV; oldest LNG plant 1971,
 *     now erratic); Mellitah Gas Complex (ENI/NOC, piped to Sicily via
 *     Greenstream Pipeline ~520 km)
 *   - **Oil refineries** — Zawiya (120k bbl/day), Ras Lanuf (220k bbl/day),
 *     Tobruk (30k bbl/day), Sarir/Ajdabiya; most running at reduced capacity
 *   - **Petrochemical** — Marsa el Brega fertiliser plant (urea/ammonia; NOC)
 *   - **Cement** — Libya Cement Company (Souk al Khamis, Khoms);
 *     Ahlia Cement (Benghazi); capacity ~12 Mt/year pre-conflict
 *   - **Steel** — Libya Iron and Steel Company (LISCO, Misrata);
 *     ~2 Mt capacity, one of Africa's largest steel plants; severely damaged
 *     in 2011 conflict, partially rebuilt
 *   - **Salt** — Gulf of Sirte coastal evaporation works
 *
 * Civil war since 2011 (Gaddafi fall); split Government of National Unity
 * (Tripoli, UN-recognised) vs Libya National Army (Benghazi, Haftar).
 *
 * LY_BBOX: [minLat=19.5, minLon=9.3, maxLat=33.2, maxLon=25.2]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ly.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ly`)

// Libya bbox: [minLat, minLon, maxLat, maxLon]
const LY_BBOX: [number, number, number, number] = [19.5, 9.3, 33.2, 25.2]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

/**
 * Returns true if the point is clearly outside Libya.
 */
function isExcluded(lat: number, lon: number): boolean {
  if (lat > 33.2) return true          // Mediterranean N
  if (lat < 19.5) return true          // Chad / Niger S
  if (lon < 9.3) return true           // Tunisia / Algeria W
  if (lon > 25.2) return true          // Egypt E
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
    if (!inBbox(lat, lon, LY_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'LY plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== LY Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in LY: ${plants.length}`)
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
      if (inBbox(lat, lon, LY_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  LY-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, LY_BBOX)) continue
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
