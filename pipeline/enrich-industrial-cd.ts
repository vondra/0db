/**
 * Enrich CD industrial with GEM Global Integrated Power (DR Congo filter).
 *
 * All DRC government portals (SNEL, Ministère de l'Énergie et des Ressources
 * Hydrauliques) publish corporate HTML only. GEM is the only machine-readable
 * source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='DR Congo'):
 *     11 operating plants, ~2,753 MW total
 *     Operating fuel: hydro 9, solar 2
 *
 *   Top operating plants:
 *     **Inga II 1,424 MW** (hydro — Congo River, Kongo Central, SNEL flagship)
 *     **Inga I 351 MW** (hydro — Congo River, Kongo Central, severely underperforming)
 *     **N'Seke 260 MW** (hydro — Inkisi River, Kongo Central)
 *     **Busanga 240 MW** (hydro — Lualaba River, Lualaba province, commissioned 2024)
 *     **Zongo II 150 MW** (hydro — Congo River tributary, Kongo Central)
 *     **N'Zilo I 108 MW** (hydro — Lualaba River, Lualaba province)
 *     **Mwadingusha 78 MW** (hydro — Lufira River, Haut-Katanga, Glencore-rehabilitated)
 *     **Zongo I 75 MW** (hydro — Inkisi River, Kongo Central)
 *     **Katende 64 MW** (hydro — Kasaï River, Kasaï-Central)
 *     **2 × small solar** (~2.6 MW total — off-grid rural IPPs)
 *
 * Non-power industrial (OSM only):
 *   - **Cobalt**: DRC produces ~70% of world's cobalt (critical EV battery supply
 *       chain). Major mines: Glencore Mutanda (suspended 2019, restarted 2022),
 *       CMOC Tenke Fungurume (Lualaba), Kamoa-Kakula (Ivanhoe/Zijin — world's
 *       fastest-growing copper mine), ERG BOSS Mining (Kolwezi area)
 *   - **Copper**: Katanga/Haut-Katanga — major global producer; Kolwezi,
 *       Likasi, Lubumbashi smelters and concentrators
 *   - **Gold**: Kibali mine (Barrick/AngloGold, one of Africa's largest,
 *       Haut-Uele province, ~800 koz/yr); eastern DRC artisanal gold
 *   - **Tin**: Bisie mine (Alphamin, world's highest-grade tin deposit,
 *       Walikale, North Kivu)
 *   - **Coltan/Tantalum**: eastern DRC (Kivu provinces — 3TG conflict minerals)
 *   - **Diamonds**: Kasaï region (MIBA — Société Minière de Bakwanga,
 *       Mbuji-Mayi); Tshikapa artisanal alluvial
 *   - **Cement**: PPC Barnet DRC (Lukala, Kongo Central),
 *       CILU (Kimpese, Kongo Central)
 *   - **SNEL** (Société Nationale d'Électricité) — state utility operating
 *       all major hydro plants; chronic underfunding, ~30% generation capacity
 *       factor vs nameplate at Inga I/II
 *   - **Grand Inga potential**: Congo River at Inga has world's largest
 *       undeveloped hydro potential (~40,000 MW). Grand Inga 3 repeatedly
 *       delayed; currently at ~1% of theoretical potential
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cd.ts
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
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cd`)

// DR Congo bbox: [south lat, west lon, north lat, east lon]
const CD_BBOX: [number, number, number, number] = [-13.5, 12.0, 5.5, 31.5]

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
    if (!inBbox(lat, lon, CD_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CD plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== CD Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in CD: ${plants.length}`)
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
      if (inBbox(lat, lon, CD_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CD-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
          if (!inBbox(lat, lon, CD_BBOX)) continue
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
