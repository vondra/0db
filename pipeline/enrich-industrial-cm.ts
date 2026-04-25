/**
 * Enrich CM industrial with GEM Global Integrated Power (Cameroon filter).
 *
 * Cameroonian gov portals (ENEO, SONATREL, MINEE, Ministère des Travaux
 * Publics, MINREX) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cameroon'):
 *     31 total, 13 operating, ~1.9 GW
 *     Operating fuel breakdown: hydropower 5, solar 4, oil/gas 3, wind 1
 *
 *   **Cameroon has a hydro-dominated grid** centred on the Sanaga River
 *   cascade, which provides most of the national generation.
 *
 *   Top operating plants:
 *     **Nachtigal 420 MW** (Sanaga River, **opened 2024** — Cameroon's newest
 *                           major hydro, built by EDF consortium, largest
 *                           single plant now overtakes Song Loulou)
 *     **Song Loulou 396 MW** (Sanaga River, 1988)
 *     **Edéa 276 MW** (Sanaga River, **1953 — Cameroon's oldest major hydro**,
 *                       historically dedicated to feeding Alucam aluminium smelter)
 *     **Kribi 216 MW** (CCGT gas, opened 2013 — Cameroon's main gas plant,
 *                        fed by Sanaga basin / Logbaba field gas)
 *     **Memve'ele 211 MW** (Ntem River, south, opened 2018)
 *     **Dibamba 88 MW** (oil/gas, Douala area)
 *     **Lagdo 72 MW** (Benue River, north — only major northern hydro,
 *                       1982, 50% shared with Chad/Nigeria water rights)
 *     **Ahala 60 MW** (oil/gas, Yaoundé)
 *     **Cameroon Wind 100 MW** (central Cameroon — recent)
 *     **Garoua/Guider/Maroua Solar** (small north solar farms)
 *
 * **Under construction (not counted as operating)**:
 *     **Lom Pangar hydro extension** (Sanaga River regulator dam, small)
 *     **Natchigal Aval + Njock** extensions
 *
 * Non-power industrial (OSM only):
 *   - **SONARA refinery** — Limbé (Anglophone SW), 45k bpd, **partially
 *     destroyed by fire May 2019**, non-operational since. Rehabilitation
 *     under discussion, uncertain timeline.
 *   - **Alucam (Aluminium du Cameroun)** — Edéa, ~95 ktpa aluminium smelter,
 *     historically Rio Tinto/Alcan, now majority state-owned. Uses power
 *     from Edéa hydro (dedicated generation for aluminium smelting).
 *   - **Kribi deepwater port** (opened 2018) — first Central African
 *     deepwater port, handles container + bulk
 *   - **Douala port** — Central Africa's main port for Cameroon, Chad, CAR,
 *     Gabon, Eq. Guinea, N Congo. Historically the key regional gateway.
 *   - **Hilli Episeyo Kribi FLNG** — **Africa's first operational FLNG**
 *     (2018, Golar LNG → New Fortress Energy), before Mozambique Coral
 *     South FLNG (2022)
 *   - **Logbaba onshore gas field** (Douala — Victoria Oil & Gas / Rodeo
 *     Development) — domestic gas for power and industry
 *   - **Offshore oil**: Ebome, Moudi (Addax Petroleum, CNPC → Sinopec)
 *   - **Cocoa processing**: SIC Cacaos, **Cameroon is world's #5 cocoa
 *     producer** (~280 ktpa)
 *   - **Palm oil**: SOCAPALM, CDC (Cameroon Development Corporation)
 *   - **Cement**: Cimencam (Holcim), Dangote Cement Cameroon, Cimaf
 *   - **Timber**: major exporter of tropical hardwood (mahogany, sapele,
 *     iroko) via Douala and Kribi ports
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cm.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cm`)

// Cameroon bbox
const CM_BBOX: [number, number, number, number] = [1.6, 8.4, 13.1, 16.2]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Nigeria (W) — long western border, roughly west of 9.0 below lat 12
  [4.0, 8.4, 11.0, 9.0],
  [11.0, 13.0, 13.1, 14.5],  // Nigeria NE (Lake Chad region)
  // Chad (NE) — Lake Chad basin + eastern border
  [12.0, 14.5, 13.1, 16.2],
  // CAR (E) — eastern border, roughly east of 15.5 below 8
  [2.5, 15.0, 8.0, 16.2],
  // Republic of Congo (SE)
  [1.6, 15.0, 2.5, 16.2],
  // Gabon (S) — south of 2.3
  [1.6, 9.5, 2.3, 14.5],
  // Equatorial Guinea (SW)
  [1.6, 9.5, 2.3, 11.5],
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
    if (!inBbox(lat, lon, CM_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CM plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== CM Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in CM: ${plants.length}`)
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
      if (inBbox(lat, lon, CM_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CM-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, CM_BBOX) || inExcluded(lat, lon)) continue

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
