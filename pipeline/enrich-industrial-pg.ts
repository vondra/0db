/**
 * Enrich PG industrial with GEM Global Integrated Power (Papua New Guinea filter).
 *
 * All PNG government portals publish corporate HTML only. GEM is the only
 * machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Papua New Guinea'):
 *     6 operating plants, ~277 MW total
 *
 *   Top operating plants:
 *     **Ramu 1 hydro 77 MW**      (hydro — Ramu River, Madang Province)
 *     **Kanudi 58 MW**            (gas/LNG — Port Moresby)
 *     **Ok Menga hydro 57 MW**    (hydro — Western Province)
 *     **Edevu hydro 54 MW**       (hydro — Central Province)
 *     **Lihir geothermal 30 MW**  (geothermal — Lihir Island, New Ireland)
 *     **Daru solar 1 MW**         (solar — Daru, Western Province)
 *
 * Non-power industrial (OSM only):
 *   - **PNG LNG** (ExxonMobil, 2014) — one of world's newest major LNG projects,
 *     ~8.3 Mtpa capacity, Hides gas field (Southern Highlands) → Caution Bay LNG terminal
 *   - **Papua LNG** (TotalEnergies) — under development, Elk-Antelope gas fields
 *   - **Ok Tedi copper/gold** (Western Province) — one of world's most controversial
 *     mines; tailings discharged into Fly River caused major ecological disaster
 *   - **Porgera gold** (Enga Province) — Barrick/Zijin JV, one of world's top-10
 *     gold mines by production
 *   - **Lihir gold** (New Ireland) — Newcrest/Newmont; one of world's largest gold
 *     mines, built inside active volcanic caldera on Lihir Island
 *   - **Ramu NiCo** (MCC China) — nickel/cobalt laterite mine + refinery,
 *     Kurumbukari (Madang Province)
 *   - **Palm oil**: West New Britain, New Ireland (Hargy Oil Palms, New Britain
 *     Palm Oil / Kulim group)
 *   - **Coffee**: Highlands provinces — PNG is world's ~#17 coffee producer;
 *     high-quality Arabica (Sigri, Kimel, Blue Mountain style)
 *   - **Tuna**: major Pacific tuna fishing nation; canneries in Madang & Wewak
 *   - ~840 living languages — most linguistically diverse country on Earth
 *
 * Bbox note:
 *   PNG territory lies entirely within 140–160°E — no antimeridian handling needed.
 *   A small longitudinal exclusion (lon < 141.0) filters out the Indonesian side
 *   of the New Guinea island (West Papua / Papua provinces, border ~141°E meridian).
 *   PG_BBOX: minLat=-11.7, minLon=140.8, maxLat=-1.0, maxLon=160.0
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-pg.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/pg`)

// Papua New Guinea — standard bbox, no antimeridian issues.
// lon < 141.0 guard excludes the Indonesian side of New Guinea island.
const PG_BBOX = { minLat: -11.7, minLon: 140.8, maxLat: -1.0, maxLon: 160.0 }

function inBbox(lat: number, lon: number, bbox: typeof PG_BBOX): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat &&
         lon >= bbox.minLon && lon <= bbox.maxLon
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
    if (!inBbox(lat, lon, PG_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'PG plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== PG Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in PG: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_SOURCE_ID = SOURCES_BY_KEY.get('global-industrial-national-mix')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, PG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  PG-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, PG_BBOX)) continue
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
