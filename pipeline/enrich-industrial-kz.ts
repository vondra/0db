/**
 * Enrich KZ industrial with GEM Global Integrated Power (Kazakhstan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Kazakhstan'):
 *     356 total / 201 operating / ~22.6 GW
 *     Operating fuel: coal 97 (DOMINANT — Soviet legacy: Ekibastuz-1 4,000 MW
 *                              8×500 = one of world's largest coal-fired plants
 *                              + Ekibastuz-2 1,000 MW + Aksu 1,935 MW),
 *                     oil/gas 36 (Atyrau/Mangystau Caspian corridor),
 *                     solar 35, wind 27 (recent renewables growth),
 *                     hydro 6 (Irtysh cascade: Shulbi 702 + Bukhtarma 675 +
 *                              Kapshagay 364 + Oskemen 331)
 *
 * Non-power industrial (OSM only):
 *   - **Tengiz oil** (Chevron/ExxonMobil — one of world's deepest super-giant
 *     oil fields, Atyrau region)
 *   - **Kashagan oil** (Caspian offshore — one of world's largest oil
 *     discoveries since 1960s, $55B development — world's most expensive
 *     oil project)
 *   - **Karachaganak gas** (Shell/ENI, Aksai)
 *   - **CPC pipeline** (Tengiz→Novorossiysk Russia)
 *   - **ArcelorMittal Temirtau** — integrated steel, formerly Karaganda
 *     Metallurgical Combine, one of the largest in CIS
 *   - **ENRC Kazchrome** — world's largest chromium producer (Aktobe/Khromtau)
 *   - **Uranium mining** — world's #1 producer: Kazatomprom ~43% of global
 *     supply (southern Kazakhstan in-situ leach operations)
 *   - **Baikonur Cosmodrome** — leased to Russia, world's first and largest
 *     space launch facility
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-kz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/kz`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Kazakhstan bbox [minLat, minLon, maxLat, maxLon]
const KZ_BBOX: [number, number, number, number] = [40.5, 46.4, 55.5, 87.4]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Russia N — above lat 54.5 west of 70, above lat 53.5 east of 70
  [54.5, 46.4, 55.5, 70.0],
  [53.5, 70.0, 55.5, 87.4],
  // China E — east of 81 below lat 47
  [40.5, 81.0, 47.0, 87.4],
  // Kyrgyzstan SE — east of 72 below lat 43
  [40.5, 72.0, 43.0, 87.4],
  // Uzbekistan S — below lat 41.5 west of 69
  [40.5, 46.4, 41.5, 69.0],
  // Turkmenistan SW — below lat 42 west of 53
  [40.5, 46.4, 42.0, 53.0],
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
    if (!inBbox(lat, lon, KZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'KZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== KZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in KZ: ${plants.length}`)
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
      if (inBbox(lat, lon, KZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  KZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, KZ_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM KZ (${best.fuel})` }
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
