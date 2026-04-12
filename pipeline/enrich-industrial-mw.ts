/**
 * Enrich MW industrial with GEM Global Integrated Power (Malawi filter).
 *
 * Malawian gov portals (Roads Authority, Ministry of Transport, ESCOM,
 * Ministry of Energy, EGENCO) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Malawi'):
 *     38 total, 7 operating, **only ~453 MW** — one of Africa's smallest
 *     power fleets. Reflects Malawi's ~14% electrification rate (lowest
 *     in Africa).
 *     Operating fuel: solar 4, hydropower 3
 *
 *   Top operating plants:
 *     **Kapichira 130 MW** (Shire River, 2000 with extension — Malawi's
 *                            largest single plant. **Damaged by Cyclone Ana
 *                            January 2022**, causing severe supply crisis
 *                            2022-2024)
 *     **Tedzani Falls 121 MW** (Shire River cascade, 4 stages I-IV)
 *     **Nkula B 100 MW** (Shire River — oldest major Malawian hydro)
 *     **Salima Solar 60 MW** (Malawi's largest solar farm)
 *     **Nkhotakota Solar 21 MW**
 *     **Golomoti Solar 20 MW**
 *     **Lilongwe Solar 1.1 MW**
 *
 * **Under construction / planned (not counted)**:
 *     **Kammwamba coal 300 MW** (NW Malawi) — Chinese-financed, delayed
 *     **Mpatamanga 350 MW hydro** (Shire River) — under development
 *     **Songwe River hydro 340 MW** — Tanzania border, joint project
 *
 * Non-power industrial (OSM only):
 *   - **Kayelekera Uranium Mine** (Karonga N) — Paladin Energy. **Closed
 *     2014** due to low uranium prices. Rehabilitation/restart discussed
 *     2023+ with uranium price recovery.
 *   - **Emerging lithium**: Mangochi/Liwonde area — Sovereign Metals
 *     (rutile+graphite) + Globe Metals (niobium)
 *   - **Tobacco processing**: **Auction Holdings** at Limbe + Kanengo —
 *     **Malawi's dominant export** (tobacco is historically 60%+ of
 *     Malawi's export earnings)
 *   - **Tea plantations**: Mulanje + Thyolo (south) — Satemwa, Eastern
 *     Produce Malawi, Makandi
 *   - **Sugar**: Illovo Sugar at Dwangwa (central coast Lake Malawi) and
 *     Nchalo (Lower Shire)
 *   - **Cement**: Shayona Cement, Cement Products Limited (Lafarge)
 *   - **Fishing**: Lake Malawi chambo (cichlid) — major domestic sector
 *   - **No oil/gas industry** — Malawi has no hydrocarbons
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mw.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/mw`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Malawi bbox — narrow N-S strip along Lake Malawi
const MW_BBOX: [number, number, number, number] = [-17.1, 32.7, -9.4, 35.95]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Tanzania (NE) — north of -9.6 east of 33.5
  [-9.6, 33.5, -9.4, 35.95],
  // Mozambique (S + SE + W) — Malawi is mostly surrounded by MZ. Narrow strips:
  // Mozambique E — east of 35.5 (Lake Malawi east shore is MZ/TZ border)
  [-14.0, 35.5, -11.5, 35.95],
  // Mozambique S — south of -16.0 (Lower Shire valley below Malawi border)
  [-17.1, 34.6, -16.0, 35.9],
  // Mozambique W Tete (salient extending east into MW space)
  [-17.1, 32.7, -14.3, 34.0],
  // Zambia (NW) — west of 33.2 above -11.5 (Chipata area)
  [-12.0, 32.7, -9.4, 33.2],
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
    if (!inBbox(lat, lon, MW_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'MW plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== MW Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in MW: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  let existing: Record<string, any> = {}
  if (existsSync(NACE_LOOKUP_PATH)) {
    try { existing = JSON.parse(readFileSync(NACE_LOOKUP_PATH, 'utf-8')) } catch {}
  }
  console.log(`\n  Existing nace-lookup entries: ${Object.keys(existing).length}`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, MW_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  MW-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0, matched = 0, newEntries = 0
  const lookup: Record<string, any> = { ...existing }

  for (const hex of hexDirs) {
    try {
      const buf = readFileSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))
      const table = tableFromIPC(buf)
      const n = table.numRows
      if (n === 0) continue
      const osmId = table.getChild('osm_id')
      const centroidLat = table.getChild('centroid_lat') ?? table.getChild('lat')
      const centroidLon = table.getChild('centroid_lon') ?? table.getChild('lon')
      if (!osmId || !centroidLat || !centroidLon) continue

      for (let i = 0; i < n; i++) {
        totalOsm++
        const lat = centroidLat.get(i) as number
        const lon = centroidLon.get(i) as number
        if (lat == null || lon == null) continue
        if (!inBbox(lat, lon, MW_BBOX) || inExcluded(lat, lon)) continue

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
          const id = String(osmId.get(i))
          if (!lookup[id]) newEntries++
          lookup[id] = { nace2: '35', name: best.name, source: `GEM MW (${best.fuel})` }
          matched++
        }
      }
    } catch {}
  }

  writeFileSync(NACE_LOOKUP_PATH, JSON.stringify(lookup, null, 2))
  console.log(`=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched:                      ${matched.toLocaleString()}`)
  console.log(`  New nace-lookup entries:      ${newEntries.toLocaleString()}`)
  console.log(`  Total nace-lookup entries:    ${Object.keys(lookup).length.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
