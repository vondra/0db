/**
 * Enrich TZ industrial with GEM Global Integrated Power (Tanzania filter).
 *
 * All Tanzanian gov portals publish WordPress/HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Tanzania'):
 *     87 total, 14 operating
 *     Fuel: hydropower 6, oil/gas 4, solar 4
 *
 *   Top operating plants:
 *     **Julius Nyerere Hydroelectric 2,115 MW** — opened 2024, on Rufiji
 *     River at Stiegler's Gorge, Nyerere National Park. One of Africa's
 *     largest new mega-dams. Controversial for impact on Selous Game
 *     Reserve (UNESCO World Heritage). Built 2019-2024 by Arab Contractors
 *     and Elsewedy Electric (Egyptian consortium).
 *     Kinyerezi II 240 MW (Dar es Salaam, gas, 2016)
 *     **Kidatu 200 MW** (hydropower, Great Ruaha River)
 *     **Kihansi 180 MW** (Kihansi Gorge, Iringa)
 *     Tegeta 100 MW (diesel, Dar es Salaam)
 *     Kishapu Solar 100 MW
 *     **Mtera 80 MW** (hydro, Great Ruaha River, upstream of Kidatu)
 *     **Rusumo 80 MW** (hydro, binational with Rwanda/Burundi on Akagera R.)
 *     **Pangani Falls 68 MW** (hydro)
 *     **Dodoma 55 MW** (gas, capital)
 *
 * Non-power industrial (OSM only):
 *   - **Gold mines**: Geita (AngloGold Ashanti), Bulyanhulu (Barrick),
 *     Buzwagi (Barrick), North Mara (Barrick), Nyanzaga (OreCorp)
 *   - **Diamonds**: Williamson/Mwadui (world's oldest continuously
 *     operating diamond mine since 1940)
 *   - **Tanzanite** (unique to Tanzania, Mererani)
 *   - **Songo Songo gas field** + Mtwara-Dar pipeline
 *   - Cement: Tanga Cement, Dangote Cement Tanzania, Twiga Cement, Mbeya
 *   - TIPER Tanzania-Italian Petroleum Refinery (Dar, closed 1999)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/tz`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Tanzania bbox (incl. Zanzibar + Pemba archipelago)
const TZ_BBOX: [number, number, number, number] = [-11.8, 29.3, -0.9, 40.5]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Kenya (N)
  [-1.6, 33.9, -0.9, 41.9],
  // Uganda (NW)
  [-1.5, 29.5, -0.9, 35.0],
  // Rwanda (W)
  [-2.9, 28.8, -1.0, 30.9],
  // Burundi (W)
  [-4.5, 29.0, -2.3, 30.9],
  // DRC (W)
  [-11.8, 29.0, -2.0, 29.4],
  // Zambia (SW)
  [-11.8, 29.0, -8.2, 33.0],
  // Malawi (S)
  [-11.8, 32.7, -9.4, 34.6],
  // Mozambique (S)
  [-11.8, 34.6, -10.2, 40.5],
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
    if (!inBbox(lat, lon, TZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'TZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== TZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in TZ: ${plants.length}`)
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
      if (inBbox(lat, lon, TZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, TZ_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace2: '35', name: best.name, source: `GEM TZ (${best.fuel})` }
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
