/**
 * Enrich GH industrial with GEM Global Integrated Power (Ghana filter).
 *
 * Ghana's gov data portal (data.gov.gh) — first sub-Saharan African open
 * data initiative (2012) — has been dormant since ~2015. VRA, BPA, ECG,
 * GRIDCo all publish WordPress corporate sites only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ghana'):
 *     98 total, 33 operating
 *     Fuel breakdown: oil/gas 15, solar 15, hydropower 3
 *
 *   Top operating plants:
 *     Akosombo 1,020 MW (hydro, Africa's largest by reservoir area — Lake
 *                        Volta 8,502 km², built 1965 by VRA, funded by
 *                        US + UK + World Bank)
 *     Karpowership Osman Khan 450 MW (oil/gas, floating powership)
 *     Bui 400 MW (hydro, BPA, opened 2013 on Black Volta)
 *     Aksa Ghana HFO 370 MW (heavy fuel oil, Turkish IPP)
 *     Sunon Asogli 360 + 200 MW (oil/gas, Shenzhen Energy)
 *     Kpone IPP (KIPP) 350 MW (oil/gas)
 *     Takoradi TAPCO 330 MW (oil/gas, VRA + CMS)
 *     Takoradi TICO 320 MW (oil/gas)
 *     Amandi 203 MW (oil/gas)
 *     Kpong 160 MW (hydro, VRA, downstream of Akosombo)
 *
 * Non-power industrial (OSM only):
 *   - **Tema Oil Refinery (TOR)** — 45k bpd, mostly non-operational
 *   - **VALCO Tema** — aluminum smelter (200 ktpa capacity, mostly idle)
 *   - **Gold mines**: AngloGold Ashanti **Obuasi**, Newmont **Ahafo** +
 *     **Akyem**, Goldfields **Tarkwa** + **Damang**, Asanko Gold
 *   - **Nsuta manganese mine** (Ghana Manganese Company)
 *   - **Awaso bauxite mine** (Ghana Bauxite Company)
 *   - **Cocoa processing** (Cocobod + private: Barry Callebaut, Cargill,
 *     Niche Cocoa) — Ghana is world's 2nd largest cocoa producer after CI
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-gh.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/gh`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Ghana bbox
const GH_BBOX: [number, number, number, number] = [4.6, -3.3, 11.2, 1.2]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Côte d'Ivoire (W)
  [4.6, -3.3, 11.2, -2.8],
  // Burkina Faso (N)
  [11.0, -3.3, 11.2, 1.2],
  // Togo (E)
  [6.0, 1.0, 11.2, 1.2],
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
    if (!inBbox(lat, lon, GH_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'GH plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== GH Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in GH: ${plants.length}`)
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
      if (inBbox(lat, lon, GH_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  GH-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, GH_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace2: '35', name: best.name, source: `GEM GH (${best.fuel})` }
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
