/**
 * Enrich DZ industrial with GEM Global Integrated Power (Algeria filter).
 *
 * Algerian gov portals (Ministère de l'Énergie, Sonelgaz, Sonatrach,
 * Ministère de l'Environnement) publish corporate HTML only. GEM is the only
 * machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Algeria'):
 *     208 total, 144 operating, ~24.6 GW installed
 *     Operating fuel breakdown: oil/gas 107, solar 34, hydropower 2, wind 1
 *
 *   Algeria has Africa's 2nd-largest thermal fleet after Egypt, overwhelmingly
 *   natural gas from domestic Hassi R'Mel and Hassi Messaoud fields.
 *
 *   Top operating plants (per-unit GEM entries, actual site capacity = sum):
 *     **Bellara 699 MW ×2 = 1,398 MW** (Jijel, El-Milia coastal CCGT)
 *     **Naama 582 MW ×2 = 1,164 MW** (Sud-Ouest, single-cycle turbines)
 *     **Oumache 500 MW ×2 = 1,000 MW** (Biskra, gas CCGT)
 *     **Hadjret En Nouss 409 MW ×3 = 1,227 MW** (Tipaza coastal — one of
 *                                                 Algeria's largest power stations)
 *     **Koudiet Eddraouch 400 MW ×3 = 1,200 MW** (El Taref, near Tunisian border)
 *     **Ras Djinet 400 MW ×3 = 1,200 MW** (Boumerdes coastal)
 *     **Terga 400 MW ×3 = 1,200 MW** (Aïn Témouchent, far west)
 *     **Ain Arnet 338 MW ×3 = 1,014 MW** (Sétif, interior north)
 *     **Mostaganem 450 MW**, **Skikda CCGT 440 MW ×2**, **Boufarik 2 250 MW**
 *     Multiple 250-300 MW peakers at F'kirina, Labreg, Msila, Hassi Ameur
 *     Hydropower: **Beni Haroun pumped storage** (Mila, 423 MW), Erraguene
 *     Solar: **Tihamam**, **Hassi R'Mel Solar (ISCC)**, **Boughezoul**, 30+ CPV
 *     Wind: **Kabertène** (Adrar, Algeria's first wind farm, 2014)
 *
 * Non-power industrial (OSM only):
 *   - **Sonatrach** — one of Africa's largest companies, operates all major
 *     oil/gas upstream and downstream:
 *     - **Hassi Messaoud oil field** — Algeria's main oil field (since 1956),
 *       over 80% of crude production
 *     - **Hassi R'Mel gas field** — **one of the world's largest gas fields**,
 *       Algeria's main gas hub (since 1956)
 *     - **In Salah gas** (BP/Statoil-Sonatrach, 2004)
 *     - **In Amenas gas** (BP/Statoil-Sonatrach, site of 2013 terrorist attack)
 *     - **Skikda** refinery (355k bpd) + **LNG** trains (since 1972)
 *     - **Arzew** refinery + **LNG** (since 1964 — **world's first
 *       industrial-scale LNG export plant**) + petrochemicals + fertilizers
 *     - **Béjaïa refinery**, **Algiers refinery**, **Adrar refinery**
 *   - **El Hadjar steel complex** (Annaba) — **Africa's largest steel complex**
 *     (historic ArcelorMittal, now state-owned Imetal), ~2 Mtpa
 *   - **Cement**: LafargeHolcim (M'Sila, Oggaz), GICA (state), Biskria,
 *     many regional plants
 *   - **Phosphates**: Djebel Onk (Tébessa), not as large as Morocco
 *   - **Ports**: Algiers, Oran, Annaba, Arzew, Skikda, Béjaïa
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-dz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/dz`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

// Algeria bbox — enormous (Africa's largest country by area)
const DZ_BBOX: [number, number, number, number] = [18.9, -8.7, 37.1, 12.0]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Morocco (W) — western border incl. Moroccan Sahara boundary
  [27.0, -8.7, 37.1, -2.0],
  // Western Sahara (SW) — we include mid-Algeria's west edge below 27N
  [22.0, -8.7, 27.0, -3.0],
  // Mauritania (SW far corner)
  [18.9, -8.7, 22.0, -4.5],
  // Mali (S)
  [18.9, -4.5, 25.0, 4.2],
  // Niger (SE)
  [18.9, 4.2, 23.5, 12.0],
  // Libya (E)
  [18.9, 10.0, 33.0, 12.0],
  // Tunisia (NE)
  [33.0, 8.3, 37.1, 12.0],
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
    if (!inBbox(lat, lon, DZ_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'DZ plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== DZ Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in DZ: ${plants.length}`)
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
      if (inBbox(lat, lon, DZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  DZ-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        if (!inBbox(lat, lon, DZ_BBOX) || inExcluded(lat, lon)) continue

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
          lookup[id] = { nace2: '35', name: best.name, source: `GEM DZ (${best.fuel})` }
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
