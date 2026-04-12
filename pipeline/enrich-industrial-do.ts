/**
 * Enrich DO industrial with GEM Global Integrated Power (Dominican Republic filter).
 *
 * Dominican Republic has the largest power generation fleet in the Caribbean.
 * The sector is privatized (EGE Haina, AES, CESPM, etc.) with significant
 * installed capacity. GEM provides good coverage. GEM is the primary source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Dominican Republic'):
 *     ~73 operating plants, ~6,132 MW total
 *
 *   Top operating plants:
 *     **Quisqueya I + II** (gas — 880 MW total, San Pedro de Macorís; 18.43°N, 69.29°W)
 *     **AES Andrés** (gas — 320 MW, LNG terminal, Andrés; 18.43°N, 69.62°W)
 *     **CESPM** (gas/oil — 300 MW, Punta Caucedo; 18.42°N, 69.62°W)
 *     **EGE Haina** (oil — 200 MW, San Cristóbal; 18.43°N, 70.00°W)
 *     **Los Cocos wind** (wind — 85 MW, Pedernales; 17.91°N, 71.44°W)
 *     **Monte Plata Solar** (solar — 60 MW; 18.81°N, 69.78°W)
 *     **Tavera / Bao / López-Angostura** (hydro — Cibao Valley; ~300 MW combined)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar**: Central Romana (Gulf+Western legacy), Casa de Campo area; DR top agricultural product
 *   - **Cigars**: second only to Cuba globally. Santiago/Cibao Valley — La Aurora, Davidoff, Arturo Fuente
 *   - **Free trade zones (FTZ)**: ~550 companies, garments, tobacco, footwear; Santiago, La Romana, San Pedro
 *   - **Tourism**: Punta Cana (fastest growing in world), Santo Domingo colonial zone (UNESCO)
 *   - **Gold/silver**: Barrick Pueblo Viejo mine (San Juan province) — Caribbean's largest gold mine
 *   - **Ferronickel**: Falcondo mine (Bonao) — major export
 *
 * Bbox note:
 *   Shares Hispaniola with Haiti. Exclude lon < -72.0 && lat > 18.0 (Haiti territory).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-do.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/do`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

const DO_BBOX: [number, number, number, number] = [17.5, -72.0, 20.0, -68.3]

function inDR(lat: number, lon: number): boolean {
  if (lat < DO_BBOX[0] || lat > DO_BBOX[2]) return false
  if (lon < DO_BBOX[1] || lon > DO_BBOX[3]) return false
  // Exclude Haiti west of border: lon < -72.0 && lat > 18.0
  if (lon < -72.0 && lat > 18.0) return false
  return true
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
    if (!inDR(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'DO plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== DO Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in DO: ${plants.length}`)
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
      if (inDR(lat, lon) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  DO-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inDR(lat, lon)) continue
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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM DO (${best.fuel})` }
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
