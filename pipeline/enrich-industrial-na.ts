/**
 * Enrich NA industrial with GEM Global Integrated Power (Namibia filter).
 *
 * Namibian gov portals (RA, TransNamib, NamPower, MME, MEFT) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Namibia'):
 *     77 total, 28 operating, ~672 MW
 *     Operating fuel: solar 22, coal 4, hydropower 1, wind 1
 *
 *   Top operating plants:
 *     **Ruacana 332 MW** (Kunene River, Angola border — **Namibia's largest
 *                          plant**, run-of-river hydro, 49% of total capacity.
 *                          Supply depends on Angola's upstream Matala Dam
 *                          water management.)
 *     **Van Eck 120 MW** (4×30 MW coal, Windhoek — Namibia's only coal
 *                          plant, obsolete, being decommissioned)
 *     **Mariental Solar 46 MW** (largest solar IPP)
 *     **Omburu Solar 20 MW** (Omaruru/Karibib area)
 *     **22 smaller solar plants** (8-16 MW each — rapid solar rollout)
 *     **Diaz Wind Farm** (Lüderitz area, recent)
 *
 * **Namibia imports ~60% of electricity** from South Africa (NamPower ↔
 * Eskom) + Zimbabwe + Zambia + Mozambique via SAPP (Southern African
 * Power Pool).
 *
 * Non-power industrial (OSM only):
 *   - **Rössing Uranium Mine** (Erongo, near Swakopmund) — **world's
 *     longest-running open-pit uranium mine** (1976-present, Rio Tinto).
 *     Now China General Nuclear Power (CGN) majority since 2019.
 *   - **Husab Uranium Mine** (Erongo) — **one of the world's largest
 *     uranium mines**, Swakop Uranium/CGN. Opened 2017. Together Rössing
 *     + Husab make Namibia world's #3 uranium producer.
 *   - **Skorpion Zinc Mine + Refinery** (Rosh Pinah, //Kharas) —
 *     Vedanta, **closed 2020** due to resource depletion. Was Africa's
 *     only integrated zinc mine+refinery.
 *   - **Langer Heinrich Uranium** (Erongo) — Paladin Energy, reopened 2024
 *     after 6-year care-and-maintenance (uranium price recovery).
 *   - **Tsumeb Smelter** — Dundee Precious Metals. Processes complex
 *     copper/lead/arsenic concentrates. One of the few smelters in the
 *     world that can handle high-arsenic copper ores.
 *   - **Rosh Pinah zinc mine** (//Kharas) — Trevali, zinc/lead
 *   - **B2Gold Otjikoto** — gold mine (Otjozondjupa)
 *   - **Navachab gold mine** (Karibib, QKR Corp)
 *   - **Walvis Bay** — **Namibia's only deep-water port**, fish processing
 *     capital, salt works
 *   - **Cement**: Ohorongo Cement (Otavi, Schwenk), Cheetah Cement (Otjiwarongo)
 *   - **Fishing + fish processing**: Walvis Bay, Lüderitz (one of Africa's
 *     richest fishing grounds — Benguela Current cold upwelling)
 *   - **Salt**: Walvis Bay Salt Works (one of Africa's largest)
 *   - **Diamonds**: Namdeb (De Beers/Namibia 50-50) — marine + alluvial
 *     along Skeleton Coast
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-na.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/na`)

// Namibia bbox — large and sparse (825k km²), Namib Desert on coast
const NA_BBOX: [number, number, number, number] = [-29.0, 11.7, -17.0, 25.3]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Angola (N) — north of -17.4
  [-17.4, 11.7, -17.0, 25.3],
  // Zambia (Caprivi Strip NE tip) — east of 25.0 above -18.5
  [-18.5, 25.0, -17.0, 25.3],
  // Botswana (E) — east of 21.0 below -18.5
  [-29.0, 21.0, -18.5, 25.3],
  // South Africa (S) — south of -28.5 (Orange River is border)
  [-29.0, 16.0, -28.5, 21.0],
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
    if (!inBbox(lat, lon, NA_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'NA plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== NA Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in NA: ${plants.length}`)
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
      if (inBbox(lat, lon, NA_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  NA-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, NA_BBOX) || inExcluded(lat, lon)) continue

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
