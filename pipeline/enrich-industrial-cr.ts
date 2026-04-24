/**
 * Enrich CR industrial with GEM Global Integrated Power (Costa Rica filter).
 *
 * ICE (Instituto Costarricense de Electricidad) publishes some plant data but
 * not as open machine-readable geospatial. GEM is the most complete source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Costa Rica'):
 *     45 operating plants, ~2,514 MW total
 *
 *   Notable operating plants:
 *     **Reventazón hydro 305 MW**       (hydro — Río Reventazón, Limón; largest hydro)
 *     **Arenal hydro 157 MW**           (hydro — Lake Arenal, Guanacaste; iconic reservoir)
 *     **Angostura hydro 177 MW**        (hydro — Río Reventazón, Turrialba)
 *     **Cachí hydro 100 MW**            (hydro — Río Reventazón, Cartago)
 *     **Miravalles geothermal 166 MW**  (geothermal — Guanacaste; ICE; operating since 1994)
 *     **Rincón de la Vieja geothermal 42 MW** (geothermal — Guanacaste; ICE)
 *     **Los Santos wind 50 MW**         (wind — San José highlands; Vientos de la Muerte pass)
 *     **Tejona wind 20 MW**             (wind — Guanacaste; ICE; first CR wind farm)
 *     **PEG Valle Central wind 50 MW**  (wind — Cartago highlands; highest CR wind)
 *     **Colpachi solar ~25 MW**         (solar — Guanacaste, Pacific lowlands)
 *     **Costa Norte gas 381 MW**        (gas — Caribbean, Moín; reserve capacity only)
 *
 * Non-power industrial (OSM only):
 *   - **Pineapple** — CR is the world's #1 pineapple exporter (~50% global market);
 *     Puntarenas, Alajuela (Peñas Blancas), San Carlos; Dole and Del Monte operate
 *   - **Banana** — Limón province (Caribbean); Chiquita, Dole; major port at Moín
 *   - **Coffee** — Central Valley (Tarrazú, Tres Ríos, Naranjo); "Café de Costa Rica"
 *     has geographic indication; specialty Arabica; ~100k tons/year
 *   - **Medical devices** — Coyol Free Zone (Alajuela, near SJO airport); Boston Scientific,
 *     Abbott, Medtronic, Baxter; ~60% of exports by value
 *   - **Semiconductors/Tech** — Zona Franca La Lima (Cartago); Intel historical;
 *     now diversified advanced manufacturing and services
 *   - **Cement** — CONCRETERA NACIONAL and HOLCIM CR (Cartago, Grecia)
 *   - **Tourism** — Pura Vida; eco-tourism infrastructure (lodges, zip lines)
 *     scattered across cloud forest, beach, and volcano areas
 *   - **Sugar** — Guanacaste (CATSA/Taboga); production for local use + ethanol
 *   - **Cattle/Dairy** — Guanacaste cattle ranching; Los Santos dairy (Cartago, San José)
 *
 * CR_BBOX: [minLat=8.0, minLon=-86.0, maxLat=11.2, maxLon=-82.5]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cr.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cr`)

// Costa Rica bbox: [minLat, minLon, maxLat, maxLon]
const CR_BBOX: [number, number, number, number] = [8.0, -86.0, 11.2, -82.5]

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
    if (!inBbox(lat, lon, CR_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CR plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== CR Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in CR: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('cr-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, CR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CR-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, CR_BBOX)) continue
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
