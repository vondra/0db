/**
 * Enrich TT industrial with GEM Global Integrated Power (Trinidad and Tobago filter).
 *
 * T&T has the Caribbean's most energy-intensive industrial sector.
 * The state-owned Trinidad and Tobago Electricity Commission (T&TEC) distributes
 * power generated almost entirely from natural gas (T&T is a major LNG exporter).
 * GEM is the primary open source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Trinidad and Tobago'):
 *     ~17 operating plants, ~2,057 MW total
 *
 *   Top operating plants:
 *     **Point Lisas Power** (gas — 720 MW, Point Lisas industrial complex; 10.41°N, 61.48°W)
 *     **Trinity Power** (gas — 294 MW; 10.63°N, 61.52°W)
 *     **Penal/Debe** (gas — 200+ MW)
 *     **Point Fortin** (gas — associated with Atlantic LNG; 10.17°N, 61.70°W)
 *     Small solar installations (<10 MW each, nascent sector).
 *
 * Non-power industrial (OSM only):
 *   - **Atlantic LNG** (Point Fortin) — Caribbean's ONLY LNG export terminal; ~15 Mtpa, one of world's
 *     largest. Trains 1–4 (Shell, BP, BG Group). Major global LNG supplier.
 *   - **Point Lisas Industrial Estate** — Caribbean's largest industrial complex: ammonia (7 plants,
 *     ~5 Mt/year, world's largest export cluster), methanol (4 plants), iron/steel (ArcelorMittal),
 *     urea, direct-reduced iron, plastics. The industrial heartland of the entire Caribbean.
 *   - **Petroleum refining**: Petrotrin Pointe-à-Pierre refinery (privatized post-2018 → Paria Fuel Trading)
 *   - **Asphalt**: Pitch Lake (La Brea) — world's largest natural asphalt lake; industrial export
 *   - **Rum/spirits**: Angostura bitters (Port of Spain) — world's most famous bitters; also rum
 *   - **Food/beverage**: Carib Brewery, Solo drinks
 *
 * TT is an island pair — no neighbor-border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tt.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/tt`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

const TT_BBOX: [number, number, number, number] = [10.0, -61.9, 10.9, -60.5]

function inTT(lat: number, lon: number): boolean {
  return lat >= TT_BBOX[0] && lat <= TT_BBOX[2] && lon >= TT_BBOX[1] && lon <= TT_BBOX[3]
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
    if (!inTT(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'TT plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== TT Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in TT: ${plants.length}`)
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
      if (inTT(lat, lon) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TT-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inTT(lat, lon)) continue
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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM TT (${best.fuel})` }
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
