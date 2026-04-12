/**
 * Enrich ZW industrial with GEM Global Integrated Power (Zimbabwe filter).
 *
 * All Zimbabwean gov portals (ZINARA, NRZ, ZESA, ZPC, ZETDC, Ministry of
 * Energy and Power Development) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Zimbabwe')
 *   - Plus supplementary Kariba Dam entry (GEM lists the dam under Zambia
 *     but the 1,050 MW Kariba South Power Station is Zimbabwean).
 *
 *   Operating fleet: 34 plants, ~2.96 GW
 *   Fuel breakdown: solar 21, coal 10, bioenergy 2, hydropower 1
 *
 *   Top operating plants:
 *     **Kariba South 1,050 MW** (Zambezi River at Kariba Dam — Zimbabwe's
 *                                 largest, shared with Zambia/Kariba North
 *                                 on the opposite bank. Kariba was the
 *                                 world's largest dam when built 1959.
 *                                 Combined Kariba Dam capacity = 2,130 MW.
 *                                 Supply severely constrained by drought
 *                                 2022-2024.)
 *     **Hwange Thermal 1,590 MW total** (6 units ×335+×220+×120 MW coal,
 *                                         Hwange coalfield, **Zimbabwe's
 *                                         main coal plant**, Sinohydro
 *                                         extension Units 7+8 added 600 MW 2023)
 *     **Harare 30 MW** (coal, small)
 *     **Munyati + Bulawayo thermal** (coal, small)
 *     **ZhongXin 50 MW** (coal IPP, Hwange)
 *     **Hippo Valley Estate 39 MW + Triangle 35 MW** (bioenergy — sugarcane
 *                                                      bagasse cogeneration,
 *                                                      Lowveld sugar plantations)
 *     **Vungu, Nyabira, Blanket Mine, Masvingo, Guruve Solar** (small solar
 *                                                                 plants, 5-30 MW)
 *
 * Non-power industrial (OSM only):
 *   - **Zimplats (Zimbabwe Platinum Mines)** — Ngezi/Selous, world-class
 *     platinum reserves on the Great Dyke. **World's #3 platinum reserves
 *     area** (after Bushveld RSA and Great Dyke). Implats subsidiary.
 *   - **Unki Mine** (Shurugwi) — Anglo American Platinum
 *   - **Mimosa Mine** (Zvishavane) — Sibanye-Stillwater + Implats JV
 *   - **Bikita Minerals** — **world's oldest and largest lithium mine**
 *     (operating since 1953, being expanded by Sinomine post-2022 lithium
 *     boom)
 *   - **Arcadia Lithium** (Goromonzi, near Harare) — Prospect Resources →
 *     Huayou Cobalt (Chinese, 2022 acquisition)
 *   - **Zulu Lithium** (Premier African Minerals, near Bulawayo)
 *   - **ZISCO (Zimbabwe Iron and Steel Company)** — Redcliff, Kwekwe.
 *     Historically Africa's largest integrated steel mill, **defunct since
 *     ~2008** economic collapse. Under discussion for revival.
 *   - **Hwange Colliery** — Zimbabwe's only major coal mine
 *   - **Gold mines**: numerous, including Freda Rebecca (Bindura), Blanket
 *     (Gwanda), How Mine (Bulawayo), Mazowe, Bulawayo mines
 *   - **Marange Diamonds** (controversial, MMCZ/ZCDC)
 *   - **Chisumbanje Bio-ethanol** (Green Fuel, sugarcane-based)
 *   - **Tobacco processing**: Kutsaga + numerous Mashonaland tobacco belt
 *   - **Hippo Valley + Triangle sugar estates** (Lowveld)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-zw.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/zw`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Zimbabwe bbox
const ZW_BBOX: [number, number, number, number] = [-22.42, 25.2, -15.6, 33.1]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Zambia (N) — across Zambezi, north of -15.9
  // Also exclude Lake Kariba south shore north of -16.65 for Kariba proper
  [-16.15, 25.2, -15.6, 33.1],
  // Mozambique (E) — east of 32.5
  [-22.42, 32.6, -15.6, 33.1],
  // South Africa (S) — south of -22.1 (Limpopo River border)
  [-22.42, 25.2, -22.1, 32.6],
  // Botswana (SW) — west of 27.5
  [-22.42, 25.2, -20.0, 27.5],
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
    // Don't apply exclude zones to Kariba (straddles border)
    const name = (f.properties?.Plant___Project_name || '').toString()
    const isKariba = name.toLowerCase().includes('kariba')
    if (!inBbox(lat, lon, ZW_BBOX)) continue
    if (!isKariba && inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'ZW plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== ZW Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in ZW: ${plants.length}`)
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
      if (inBbox(lat, lon, ZW_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ZW-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, ZW_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM ZW (${best.fuel})` }
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
