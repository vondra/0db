/**
 * Enrich ZM industrial with GEM Global Integrated Power (Zambia filter).
 *
 * All Zambian gov portals (RDA, ZRL, ZESCO, CEC, Ministry of Energy, Ministry
 * of Mines) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Zambia'):
 *     82 total, 15 operating, ~4.76 GW — **one of Africa's largest hydro fleets**
 *     Operating fuel: hydropower 5, solar 5, coal 3, oil/gas 1, bioenergy 1
 *
 *   Top operating plants:
 *     **Kariba Dam 2,130 MW** (Zambezi at Kariba — GEM lists whole dam
 *                               under Zambia; **world's largest dam when
 *                               built 1959**, shared with Zimbabwe/Kariba
 *                               South on opposite bank. Kariba North Bank
 *                               was upgraded 2014 from 720 MW to ~1,080 MW
 *                               by Sinohydro. **Severely drought-constrained
 *                               2022-2024**.)
 *     **Kafue Gorge Upper 990 MW** (Kafue River, 1971 — Zambia's second-
 *                                    largest plant, ZESCO-owned)
 *     **Kafue Gorge Lower 750 MW** (Kafue River, **opened 2024** — Zambia's
 *                                    newest major hydro, Sinohydro-built,
 *                                    downstream of Upper)
 *     **Maamba Coal 300 MW** (2×150 MW — **Zambia's only coal plant**,
 *                              SE Zambia at Maamba Collieries)
 *     **Itezhi-Tezhi 120 MW** (Kafue River regulator dam, 2016)
 *     **Victoria Falls Power Station 108 MW** (old colonial-era 3 plants)
 *     **Ndola Energy HFO 105 MW** (oil/gas — Copperbelt emergency)
 *     **Itimpi + Bangweulu + Ngonye + Riverside Solar** (~185 MW total)
 *     **Nakambala 40 MW bioenergy** (sugarcane bagasse cogeneration —
 *                                     Zambia Sugar Company Mazabuka)
 *     **Ndola Cement 30 MW coal** (captive for cement plant)
 *
 * Non-power industrial (OSM only):
 *   - **Copperbelt Province** — Zambia's industrial heartland
 *   - **Konkola Copper Mines (KCM)** — Chingola/Chililabombwe, Vedanta
 *     (struggling, state dispute 2019+)
 *   - **Mopani Copper Mines** — Mufulira/Kitwe (formerly Glencore, now
 *     ZCCM-IH majority state-owned after 2021 sale)
 *   - **First Quantum Minerals (FQM)** — **Kansanshi (Solwezi)** + **Sentinel
 *     (Kalumbila)**, NW Province. **Kansanshi is Africa's largest copper
 *     mine by production**. Both open pit.
 *   - **Barrick Lumwana** — Solwezi NW, open-pit copper
 *   - **Copper refining**: Nkana Refinery (Kitwe), Ndola Copper Refinery,
 *     Mufulira Smelter (Mopani), Nchanga Smelter (KCM)
 *   - **Kafue Steel** (Kafue) — moderate steel production
 *   - **Cement**: Lafarge Zambia (Chilanga), Dangote Cement (Masaiti),
 *     Mpande, Ndola Cement Plant
 *   - **INDENI Petroleum Refinery** (Ndola) — **closed 2019**, converted
 *     to fuel storage
 *   - **Emeralds**: **Kagem** (Lufwanyama Copperbelt) — **world's largest
 *     emerald mine**, Gemfields operated (75% state)
 *   - **Manganese**: Serenje area
 *   - **Chilanga Cement** (Lusaka area, Lafarge)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-zm.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/zm`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Zambia bbox
const ZM_BBOX: [number, number, number, number] = [-18.1, 21.9, -8.2, 33.7]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // DRC (N) — DRC Katanga border is roughly at lat -11.7 to -11.8
  // (Lubumbashi at -11.67). Zambian Copperbelt cities (Ndola at -12.97,
  //  Kitwe at -12.82) are south of this.
  [-11.7, 22.0, -8.2, 30.5],
  // Tanzania (NE) — north of -8.8 + east of 31
  [-9.2, 31.0, -8.2, 33.7],
  // Malawi (E) — mostly east of 33.0
  [-16.0, 33.0, -9.0, 33.7],
  // Mozambique (SE) — far SE corner, south of -15.5 + east of 32
  [-17.5, 32.0, -15.5, 33.7],
  // Zimbabwe (S) — narrow strip just south of the Kariba Lake (Zambezi border).
  // Zambezi is at roughly lat -16.0 here; Zimbabwean territory is south of it.
  // Kafue Gorge (Zambia) is at -15.81 to -15.90, Nakambala at -15.83 — all
  // need to be OUTSIDE this zone. Kariba exception handles Kariba dam.
  [-17.0, 27.5, -16.0, 31.5],
  // Botswana (short S, around Kazungula)
  [-18.1, 25.0, -17.75, 25.5],
  // Namibia Caprivi (SW)
  [-18.1, 21.9, -17.45, 25.3],
  // Angola (W) — west of 23.5 above -15
  [-15.5, 21.9, -8.2, 23.5],
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
    // Don't exclude Kariba (straddles border with Zimbabwe)
    const name = (f.properties?.Plant___Project_name || '').toString()
    const isKariba = name.toLowerCase().includes('kariba')
    if (!inBbox(lat, lon, ZM_BBOX)) continue
    if (!isKariba && inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'ZM plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== ZM Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in ZM: ${plants.length}`)
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
      if (inBbox(lat, lon, ZM_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ZM-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, ZM_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace: naceCode, name: best.name, source: `GEM ZM (${best.fuel})` }
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
