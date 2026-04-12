/**
 * Enrich MZ industrial with GEM Global Integrated Power (Mozambique filter).
 *
 * All Mozambican gov portals (EDM, Ministério dos Recursos Minerais e
 * Energia, ENH, INP) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mozambique'):
 *     78 total, 12 operating, ~2.94 GW
 *     Operating fuel breakdown: oil/gas 5, solar 4, hydropower 3
 *
 *   Top operating plants:
 *     **Cahora Bassa 2,075 MW** (Zambezi River — one of Africa's largest
 *                                 hydropower, built 1969-1979 by Portuguese
 *                                 colonial government, **dominates MZ fleet**.
 *                                 Exports majority of power to South Africa
 *                                 via Apollo HVDC link — one of the world's
 *                                 earliest major HVDC transmission systems)
 *     **Ressano Garcia 175 MW** (Matola gas — Sasol-linked, supplies Maputo)
 *     **Karpowership "Mehmet Bey" 125 MW** (Turkish floating powership,
 *                                            anchored off Nacala, Cabo Delgado)
 *     **Maputo 121 MW** (oil/gas, Maputo thermal)
 *     **Gigawatt Park 119 MW** + **Gigawatt Mozambique 117 MW** (gas IPPs)
 *     **Mavuzi 52 MW** + **Chicamba 44 MW** (smaller Zambezi hydros)
 *     **Metoro Solar 41 MW**, **Mocuba Solar 40 MW**, **Cuamba Solar 19 MW**
 *     **Balama Graphite Mine Solar 11 MW** (Syrah Resources mine)
 *
 * **Under construction (not counted as operating)**:
 *     **Mphanda Nkuwa ~1,500 MW** (Zambezi, planned next mega-dam)
 *
 * Non-power industrial (OSM only):
 *   - **Mozal Aluminium Smelter** (Matola, Maputo) — **Africa's largest
 *     aluminium smelter**, ~580 ktpa. Started 2000 by BHP Billiton (now
 *     South32). Paradoxically uses power from South Africa grid (reverse of
 *     Cahora Bassa export flow to SA)
 *   - **Moatize Coal Basin** (Tete Province) — **world-class coking coal**,
 *     Vale operated 2011-2021, now Vulcan International (Jindal). Massive
 *     open-pit mines connect to Nacala Corridor rail for export
 *   - **Mozambique LNG / Area 1 / Golfinho-Atum** (TotalEnergies, offshore
 *     Rovuma basin, Cabo Delgado) — **~$20B project**, paused since 2021
 *     due to Cabo Delgado insurgency, resuming 2024/2025
 *   - **Coral South FLNG** (ENI, offshore Rovuma) — **first LNG operation
 *     2022** (floating liquefaction, only the 2nd FLNG in Africa after
 *     Cameroon's Kribi)
 *   - **Sasol Temane gas** (Inhambane province) — supplies gas to Sasol's
 *     Secunda (South Africa) via 900 km pipeline + Ressano Garcia/Maputo
 *     gas plants via CTRG pipeline
 *   - **Kenmare Resources Moma** (Nampula coast) — **world-class heavy
 *     mineral sands** (ilmenite/zircon/rutile for titanium)
 *   - **Beira Port** — hinterland for Zimbabwe/Zambia/Malawi
 *   - **Nacala Port** — deep-water, Malawi corridor terminus
 *   - **Cement**: Cimentos de Moçambique (Matola), Cinac (Nacala),
 *     Dugongo Cement (Dondo)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/mz`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Mozambique bbox — elongated coastal shape, ~2,500 km coastline
const MZ_BBOX: [number, number, number, number] = [-26.95, 30.2, -10.5, 40.9]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // South Africa (SW) — west of ~31.9 below -25.8
  [-26.95, 30.2, -25.8, 31.9],
  // Eswatini (small, SW corner)
  [-26.95, 31.0, -25.7, 32.1],
  // Zimbabwe (W) — mid-west narrow strip east of the border
  [-22.5, 30.2, -16.4, 33.0],
  // Zambia (NW narrow strip) — west of Tete province, Zambezi north of -15.5
  [-15.6, 30.2, -13.5, 30.5],
  // Malawi (center — Lake Malawi + salient intrudes into MZ between Tete & Nampula)
  [-15.8, 34.2, -11.3, 35.9],
  // Tanzania (N) — north of -10.6
  [-10.6, 34.5, -10.5, 40.9],
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
    if (!inBbox(lat, lon, MZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'MZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== MZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in MZ: ${plants.length}`)
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
      if (inBbox(lat, lon, MZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  MZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, MZ_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace2: '35', name: best.name, source: `GEM MZ (${best.fuel})` }
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
