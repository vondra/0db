/**
 * Enrich UG industrial with GEM Global Integrated Power (Uganda filter).
 *
 * All Ugandan gov portals (UNRA, URC, UEGCL, UETCL, Ministry of Energy and
 * Mineral Development, PAU) publish corporate HTML only. GEM is the only
 * machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Uganda'):
 *     49 total, 19 operating, ~1.75 GW
 *     Operating fuel breakdown: solar 10, hydropower 5, oil/gas 3, bioenergy 1
 *
 *   **Uganda is almost entirely hydro-powered** from the White Nile cascade
 *   between Lake Victoria and Karuma. **Nile hydro = ~1,413 MW = 81% of capacity.**
 *
 *   Top operating plants:
 *     **Karuma 600 MW** (Nile River, opened 2024 — Uganda's largest, built
 *                         by Sinohydro with Chinese financing, delayed from
 *                         original 2018 plan due to technical disputes)
 *     **Bujagali 250 MW** (Nile, 2012 — Bujagali Falls below Jinja, private
 *                           IPP built by SG Bujagali Holdings)
 *     **Kiira 200 MW** (Nile at Owen Falls Dam extension, 2000 — twin to
 *                        Nalubaale sharing the same dam)
 *     **Isimba 183 MW** (Nile, 2019)
 *     **Nalubaale (formerly Owen Falls) 180 MW** (Nile at Jinja, 1954 —
 *                                                  **Uganda's oldest major hydro**,
 *                                                  at the source of the White Nile)
 *     **Tororo 89 MW** (oil/gas, east — emergency thermal, Aggreko-era plant)
 *     **Mutundwe 50 MW + Namanve 50 MW** (oil/gas, Kampala area)
 *     **Kakira Sugar 30 MW** (bioenergy — sugarcane bagasse cogeneration,
 *                              Madhvani Group's Kakira sugar estate)
 *     **Kabulasoke, Nkonge, Tororo II, Rakai, Bufulubi, Soroti, Tororo I
 *      Solar** — 10 small solar plants (4-24 MW each)
 *
 * Non-power industrial (OSM only):
 *   - **Lake Albert oil fields** — **Tilenga** (TotalEnergies operated, Area 1
 *     + Area 2) + **Kingfisher** (CNOOC operated). ~6.5 Bbbl resources.
 *     **First oil production target ~2025/2026**.
 *   - **EACOP (East African Crude Oil Pipeline)** — 1,443 km, Hoima ↔ Tanga
 *     (Tanzania), **under construction 2023-2026**. **World's longest
 *     heated crude oil pipeline**. Highly controversial due to climate +
 *     environmental + community displacement concerns.
 *   - **Uganda Refinery Hoima** — planned 60k bpd, not yet built
 *   - **Roofings Group** (Kampala, Namanve industrial park) — **East Africa's
 *     largest steel manufacturer**, integrated steel mill + galvanizing
 *   - **Cement**: **Hima Cement** (Holcim → Bamburi, near Kasese),
 *     **Tororo Cement** (Tororo), **Simba Cement** (Tororo)
 *   - **Sugar**: Kakira (Madhvani), Kinyara, SCOUL (Lugazi)
 *   - **Tea**: major plantations in Fort Portal/Kyenjojo area
 *   - **Coffee**: **Uganda is Africa's #2 coffee producer** after Ethiopia
 *     (~5 Mbags/year)
 *   - **Copper + Cobalt**: **Kilembe mine** (Kasese) — historically major,
 *     rehabilitation under discussion since 2013
 *   - **Fishing**: Lake Victoria Nile perch industry
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ug.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ug`)

// Uganda bbox
const UG_BBOX: [number, number, number, number] = [-1.5, 29.5, 4.3, 35.05]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // South Sudan (N) — north of 4.0
  [4.0, 29.5, 4.3, 35.05],
  // Kenya (E) — east of 34.8
  [-1.5, 34.8, 4.3, 35.05],
  // Tanzania (S) — south of -1.0
  [-1.5, 29.5, -1.0, 35.05],
  // Rwanda (SW)
  [-1.5, 29.5, -1.0, 30.9],
  // DRC W (Ituri + Virunga) — west of 29.8 above lat 0
  [0.0, 29.5, 3.8, 29.8],
  // DRC W (Lake Albert/Edward west bank)
  [-1.5, 29.5, 0.0, 29.9],
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
    if (!inBbox(lat, lon, UG_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'UG plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== UG Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in UG: ${plants.length}`)
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
      if (inBbox(lat, lon, UG_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  UG-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, UG_BBOX) || inExcluded(lat, lon)) continue

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
