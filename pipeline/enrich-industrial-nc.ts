/**
 * Enrich NC industrial with GEM Global Integrated Power (New Caledonia filter).
 *
 * All NC government portals (Gouvernement de la Nouvelle-Calédonie, DIMENC) publish
 * corporate HTML only. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='New Caledonia'):
 *     39 operating plants, ~970 MW total
 *
 *   Top operating plants (nickel smelter power dominates):
 *     **Doniambo 340 MW**         (fuel oil — SLN/Eramet, Nouméa; 2×170 MW, since 1910)
 *     **Koniambo 270 MW**         (fuel oil — Glencore/SMSP, North Province; 2×135 MW, 2013)
 *     **Goro 100 MW**             (fuel oil — Prony Resources (ex-Vale), South Province; 2×50 MW)
 *     **Yaté hydro 68 MW**        (hydro — Yaté River, Grand Lac)
 *     **Jacques Lekawe 55 MW**    (diesel — Nouméa, ENERCAL)
 *     **Wind farms ~39 MW**       (wind — Col de Prony, Kafeate, Negandi)
 *     **Solar ~90 MW**            (~20 projects across main island and Loyalty Islands)
 *
 * Non-power industrial (OSM only):
 *   - **Nickel**: NC holds ~25% of world's known nickel reserves; world's #4 producer
 *   - **SLN/Eramet** (Doniambo pyrometallurgical smelter, Nouméa) — oldest continuously
 *     operating nickel smelter in the world (since 1910)
 *   - **Koniambo Nickel** (Glencore/SMSP — North Province, pyrometallurgical, 2013)
 *     one of the world's largest greenfield nickel projects (~$6B investment)
 *   - **Prony Resources** (formerly Vale NC/Goro — hydrometallurgical, South Province)
 *     $9B investment; unique high-pressure acid leach (HPAL) technology; troubled
 *     history including spills, COVID shutdowns, and 2021 ownership change
 *   - All three smelters have dedicated captive power plants — nickel smelting is
 *     extremely energy-intensive (~8–12 MWh per tonne of refined nickel)
 *   - **Chrome/cobalt/manganese** — by-products of nickel ore processing
 *   - **World's largest lagoon** (UNESCO World Heritage, 2nd largest coral reef system
 *     after the Great Barrier Reef) — major tourism and fisheries resource
 *   - **2024 political crisis** — riots over electoral reform (dégel du corps électoral),
 *     Kanak independence movement (FLNKS); significant damage to industrial facilities
 *
 * Bbox note:
 *   NC territory is an island chain with no land neighbours.
 *   NC_BBOX: minLat=-23.0, minLon=163.5, maxLat=-19.5, maxLon=168.5
 *   No antimeridian handling needed; no neighbour excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-nc.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/nc`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// New Caledonia — island chain, simple bbox, no antimeridian issues, no neighbour excludes.
const NC_BBOX = { minLat: -23.0, minLon: 163.5, maxLat: -19.5, maxLon: 168.5 }

function inBbox(lat: number, lon: number, bbox: typeof NC_BBOX): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat &&
         lon >= bbox.minLon && lon <= bbox.maxLon
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
    if (!inBbox(lat, lon, NC_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'NC plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== NC Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in NC: ${plants.length}`)
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
      if (inBbox(lat, lon, NC_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  NC-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, NC_BBOX)) continue
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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM NC (${best.fuel})` }
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
