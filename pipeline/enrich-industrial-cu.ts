/**
 * Enrich CU industrial with GEM Global Integrated Power (Cuba filter).
 *
 * Cuba's power sector is almost entirely state-owned (Unión Eléctrica de Cuba).
 * Soviet-era thermoelectric plants dominate — aging oil-fired steam turbines.
 * GEM is the only machine-readable open source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cuba'):
 *     ~38 operating plants, ~2,891 MW total
 *
 *   Top operating plants:
 *     **Mariel** (oil — 500 MW, Artemisa province; 22.98°N, 82.74°W)
 *     **Felton** (oil — 500 MW, Holguín province; 20.71°N, 75.31°W)
 *     **Antonio Guiteras** (oil — 500 MW, Matanzas; 23.09°N, 81.57°W)
 *     **Máximo Gómez** (oil — 235 MW, Mariel area; 22.97°N, 82.78°W)
 *     **Ernesto Guevara** (oil — 160 MW, Santa Clara; 22.44°N, 79.96°W)
 *     **Carlos Manuel de Céspedes** (oil — 300 MW, Cienfuegos; 22.13°N, 80.42°W)
 *     Scattered small solar (<10 MW each) and wind (Gibara, ~50 MW).
 *
 * Non-power industrial (OSM only):
 *   - **Sugar**: historically world's largest exporter; ~10 active mills remain
 *   - **Nickel**: Moa (Sherritt International joint venture) — top Cuban export
 *   - **Tobacco**: Cohiba, Montecristo cigars; Las Villas and Vuelta Abajo leaf
 *   - **Rum**: Havana Club (Pernod Ricard / Cuba Ron S.A.), Santiago de Cuba rum
 *   - **Cement**: Cienfuegos, Mariel cement plants
 *   - **Pharmaceuticals**: Cuba's biotech sector (Centro de Ingeniería Genética)
 *
 * CU is an island — no neighbor-border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cu.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cu`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

const CU_BBOX: [number, number, number, number] = [19.8, -85.0, 23.3, -74.1]

function inCuba(lat: number, lon: number): boolean {
  return lat >= CU_BBOX[0] && lat <= CU_BBOX[2] && lon >= CU_BBOX[1] && lon <= CU_BBOX[3]
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
    if (!inCuba(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'CU plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== CU Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in CU: ${plants.length}`)
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
      if (inCuba(lat, lon) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  CU-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inCuba(lat, lon)) continue
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
          const naceCode = best.fuel.includes('solar') ? '359900' : best.fuel.includes('wind') ? '351200' : '351100'
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM CU (${best.fuel})` }
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
