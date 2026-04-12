/**
 * Enrich RS industrial with GEM Global Integrated Power (Serbia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Serbia'):
 *     148 total / 44 operating / ~7.3 GW
 *     Operating fuel: coal 18 (DOMINANT), hydro 6, wind 7, solar 8, oil/gas 4, bioenergy 1
 *
 *   Top operating plants:
 *     **TENT Nikola Tesla** ~2,837 MW (lignite, 7 units, Obrenovac —
 *                            Serbia's largest, feeds from Kolubara mines)
 *     **Kostolac** 1,260 MW (lignite, 4 units, Požarevac)
 *     **Bajina Basta** 1,034 MW (pumped 614 + conventional 420,
 *                                Drina River, reversible storage)
 *     **Đerdap/Iron Gates I+II** ~1,160 MW Serbia's half
 *                                (listed under Romania in GEM, shared with RO)
 *     **Čibuk 1** 158 MW (wind — Serbia's first large wind farm)
 *
 * Non-power industrial (OSM only):
 *   - **NIS refinery Pančevo** (Gazprom Neft, 100k bpd — Russian-controlled,
 *     largest refinery in Western Balkans)
 *   - **HBIS Smederevo** (formerly US Steel, sold to Chinese HBIS 2016,
 *     ~2.2 MT/yr, Serbia's largest employer)
 *   - **RTB Bor** (state copper mine, one of Europe's largest,
 *     Bor/Majdanpek, expanded with Chinese investment)
 *   - **Vreoci/Kolubara lignite mines** (Obrenovac — Serbia's largest coal
 *     complex, feeds TENT power plant)
 *   - **Cement**: CRH Kosjerić, Lafarge Beočin (oldest cement plant in Serbia)
 *   - **Fiat Chrysler/Stellantis** Kragujevac (Tipo, Fiat 500L, ~200k units/yr)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-rs.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/rs`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Serbia bbox [minLat, minLon, maxLat, maxLon]
const RS_BBOX: [number, number, number, number] = [42.2, 18.8, 46.2, 23.1]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Hungary N — above lat 46.0
  [46.0, 18.8, 46.2, 23.1],
  // Romania NE — above lat 44.8 east of 21.5
  [44.8, 21.5, 46.2, 23.1],
  // Bulgaria SE — below lat 43.2 east of 22.3
  [42.2, 22.3, 43.2, 23.1],
  // North Macedonia S — below lat 42.4
  [42.2, 18.8, 42.4, 23.1],
  // Kosovo SW — below lat 43.0 west of 21.2 above lat 42.3
  [42.3, 18.8, 43.0, 21.2],
  // Montenegro W — west of 19.4 below lat 43.8
  [42.2, 18.8, 43.8, 19.4],
  // Bosnia W — west of 19.4 above lat 43.8
  [43.8, 18.8, 46.2, 19.4],
  // Croatia NW — above lat 45.5 west of 19.4
  [45.5, 18.8, 46.2, 19.4],
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
    if (!inBbox(lat, lon, RS_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'RS plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== RS Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in RS: ${plants.length}`)
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
      if (inBbox(lat, lon, RS_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  RS-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, RS_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace2: '35', name: best.name, source: `GEM RS (${best.fuel})` }
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
