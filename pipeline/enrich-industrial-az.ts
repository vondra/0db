/**
 * Enrich AZ industrial with GEM Global Integrated Power (Azerbaijan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Azerbaijan'):
 *     68 total / 44 operating / ~7.42 GW
 *     Operating fuel: gas/oil 23, solar 13, hydro 6, wind 1
 *
 *   Top operating plants:
 *     **Azerbaijan TPS / Mingachevir Thermal** ~1,800 MW (6×300 MW,
 *                            Kür River, Azerbaijan's largest thermal station)
 *     **Shimal 800 MW** (north of Baku, combined-cycle gas)
 *     **Janub 780 MW** (south of Baku, combined-cycle gas)
 *     **Sumgayit 525 MW** (Soviet-era industrial satellite of Baku)
 *     **Gobu 384 MW** (Garadagh district, Baku)
 *     **Sangachal 308 MW** (Caspian terminal gas turbine, BP-operated)
 *     **Mingachevir Hydro 424 MW** (Kür River dam, Azerbaijan's main hydro)
 *     **Shamkir Hydro 380 MW** (Kür River cascade, west Azerbaijan)
 *     **Baku Wind 240 MW** (Absheron Peninsula, near Baku)
 *
 * Non-power industrial (OSM only):
 *   - **SOCAR** (State Oil Company of Azerbaijan Republic) — one of the
 *     Caspian's largest oil & gas companies; Baku headquarters, global ops
 *   - **ACG (Azeri-Chirag-Gunashli)** offshore — BP-operated, "Contract
 *     of the Century" 1994, backbone of AZ oil output (~600k bpd peak)
 *   - **Shah Deniz gas field** (BP, world-class, feeds SCP/TANAP/TAP)
 *   - **BTC pipeline** (Baku-Tbilisi-Ceyhan, 1,768 km, 1 Mbpd capacity)
 *   - **SCP / TANAP / TAP gas pipelines** (Southern Gas Corridor,
 *     Caspian→Turkey→Europe, 3,500 km total)
 *   - **Baku / Heydar Aliyev refinery** (~200k bpd, SOCAR)
 *   - **Sumgayit Chemical Industrial Park** (Soviet-era, formerly one of
 *     the most polluted cities on Earth; petrochemicals, chlorine, PVC)
 *   - **ArcelorMittal Baku** (Baku Steel Company) — electric arc steel
 *   - COP29 host 2024 (Baku National Stadium)
 *
 * Nakhchivan exclave note: The AZ bbox covers both mainland and
 * Nakhchivan (38.8-39.8 N, 44.7-46.0 E). EXCLUDE_ZONES remove Armenia
 * (between mainland and exclave), Georgia (W), Russia (N), and Iran (S).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-az.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/az`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Azerbaijan bbox [minLat, minLon, maxLat, maxLon] — covers mainland + Nakhchivan exclave
const AZ_BBOX: [number, number, number, number] = [38.3, 44.7, 42.0, 50.6]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Russia N — above lat 41.8 west of 48.5
  [41.8, 44.7, 42.0, 48.5],
  // Georgia W — west of 45.5 above lat 41.0
  [41.0, 44.7, 42.0, 45.5],
  // Armenia (between mainland AZ and Nakhchivan) —
  //   lat 39.0-41.0, lon 43.5-46.5 is mostly Armenia territory;
  //   keep AZ mainland east of 46.0 and Nakhchivan west of 46.0 below lat 39.6
  [39.6, 44.7, 41.0, 46.0],
  // Iran S — below lat 38.8
  [38.3, 44.7, 38.8, 50.6],
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
    if (!inBbox(lat, lon, AZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'AZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== AZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in AZ: ${plants.length}`)
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
      if (inBbox(lat, lon, AZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  AZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, AZ_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM AZ (${best.fuel})` }
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
