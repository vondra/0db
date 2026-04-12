/**
 * Enrich KP industrial with GEM Global Integrated Power (North Korea filter).
 *
 * North Korea publishes no open energy data. GEM is the only machine-readable
 * source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='North Korea'):
 *     62 operating plants, ~6,482 MW total
 *
 *   Notable operating plants:
 *     **Supung hydro 800 MW**           (hydro — Yalu River, shared with China; largest in KP)
 *     **Bukchang thermal 1,600 MW**     (coal — South Pyongan, major Soviet-era plant)
 *     **Pyongyang thermal 500 MW**      (coal — capital district supply)
 *     **Sunchon thermal 400 MW**        (coal — South Pyongan, near Bukchang)
 *     **Huichon hydro cascade 300 MW**  (hydro — Chongchon River, Kim Jong-un priority)
 *     **Thaechon hydro 188 MW**         (hydro — Pyongbuk, Chinese-aided)
 *     **Wonsan thermal 200 MW**         (coal — east coast)
 *     **Ungi thermal 200 MW**           (coal — Rason SEZ, NE corner)
 *     **Chongjin steelworks CHP**       (coal CHP — Kim Chaek Iron & Steel, NE industrial hub)
 *     **Nampo smelter CHP**             (coal CHP — West Sea Barrage port)
 *
 * Non-power industrial (OSM only):
 *   - **Steel** — Kim Chaek Iron & Steel (Chongjin), Hwanghae Iron & Steel (Songnim);
 *     historically significant but severely underutilized due to sanctions
 *   - **Mining** — coal (Sunchon, Anju, Tokchon basins), magnesite (world's
 *     largest reserves at Tanchon), zinc/lead (Komdok Mine, largest in Asia),
 *     gold, iron ore; mineral exports primary hard-currency earner
 *   - **Chemical** — Hungnam Chemical Complex (fertilizers, explosives), Namhung
 *     Youth Chemical Plant; Soviet-era complex
 *   - **Cement** — Sungan Cement, Pyongyang Cement; major construction focus
 *     under Kim Jong-un "construction revolution"
 *   - **Military-industrial** — munitions factories throughout; not in OSM
 *   - **Textiles** — Pyongyang textile mills, Korean silk; domestic consumption
 *   - **Seafood processing** — Wonsan, Chongjin; fish/seafood export to China
 *
 * KP_BBOX: [minLat=37.6, minLon=124.2, maxLat=43.0, maxLon=130.7]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-kp.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/kp`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// North Korea bbox: [minLat, minLon, maxLat, maxLon]
const KP_BBOX: [number, number, number, number] = [37.6, 124.2, 43.0, 130.7]

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
    if (!inBbox(lat, lon, KP_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'KP plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== KP Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in KP: ${plants.length}`)
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
      if (inBbox(lat, lon, KP_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  KP-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, KP_BBOX)) continue
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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM KP (${best.fuel})` }
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
