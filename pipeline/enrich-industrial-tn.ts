/**
 * Enrich TN industrial with GEM Global Integrated Power (Tunisia filter).
 *
 * Tunisian gov portals (STEG, Ministère de l'Environnement, Ministère de
 * l'Industrie) publish HTML/corporate sites only. INS (Institut National de
 * la Statistique) has socio-economic data but not facility-level. GEM is the
 * only machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Tunisia'):
 *     80 total, 39 operating
 *     Operating fuel: oil/gas 27, wind 6, solar 6
 *     — Largest operating fleet of any African country enriched so far
 *
 *   Top operating plants:
 *     **Rades II+C 930 MW** (Tunis port — Tunisia's largest thermal cluster)
 *     **Rades A+B 700 MW** (older units at same complex)
 *     **Sousse A+B+C+D 1,525 MW** (Sousse coastal thermal — 4 phases)
 *     **Ghannouch 400 MW** (Gabès industrial zone CCGT)
 *     **Mornaguia 624 MW** (combined heat+power, near Tunis)
 *     **Bir Mcherga 256 MW** (Zaghouan, peak-load turbines)
 *     **Bouchemma 250 MW** (Gabès region)
 *     **Thyna 246 MW** (Sfax industrial zone)
 *     **Sidi Daoud Wind** (Cap Bon peninsula — Tunisia's first wind farm)
 *     **Bizerte wind** (Metline)
 *     **Borj Bourguiba Solar**, **Tozeur Solar**
 *
 * **Tunisia's generation is ~94% natural gas**, mostly from STEG-owned plants.
 * Imports ~50% of gas from Algeria via Transmed pipeline + 15% royalty on
 * Algeria↔Italy gas transit.
 *
 * Non-power industrial (OSM only):
 *   - **STIR** (Société Tunisienne des Industries de Raffinage) — Bizerte,
 *     ~34k bpd, Tunisia's only oil refinery
 *   - **Gafsa phosphate corridor** — CPG (Compagnie des Phosphates de Gafsa),
 *     world's #5 phosphate producer at Metlaoui/Redeyef/Mdhilla
 *   - **GCT Gabès** (Groupe Chimique Tunisien) — phosphoric acid / DAP
 *     fertilizer complex, one of Africa's largest chemical sites (major
 *     environmental contamination concerns)
 *   - **Cement**: Ciments de Bizerte, Carthage Cement (Djebel Ressas),
 *     Ciments d'Oum El Kélil (Tajerouine), CIOK, Les Ciments de Gabès
 *   - **Steel**: El Fouladh (Menzel Bourguiba)
 *   - **Offshore oil**: Ashtart, El Bibane, Didon, Cercina, Miskar gas
 *     (BG/Shell, TOTAL)
 *   - **Tataouine gas fields** (Adam, Oued Zar, El Borma)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tn.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/tn`)

// Tunisia bbox — mainland + Djerba + Kerkennah islands
const TN_BBOX: [number, number, number, number] = [30.2, 7.5, 37.6, 11.6]

const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  // Algeria (W) — entire western edge
  [30.2, 7.5, 37.6, 8.15],
  // Libya (SE) — below Tataouine/Djerba latitude
  [30.2, 9.5, 32.0, 11.6],
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
    if (!inBbox(lat, lon, TN_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'TN plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== TN Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in TN: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_SOURCE_ID = SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TN_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TN-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0, matched = 0, newEntries = 0

  for (const hex of hexDirs) {
    const arrowPath = resolve(H3R4_DIR, hex, 'industrial.arrow')
    if (!existsSync(arrowPath)) continue
    try {
      await withArrowWrite(arrowPath, table => {
        const n = table.numRows
        if (n === 0) return table
        const osmId = table.getChild('osm_id')
        const centroidLat = table.getChild('centroid_lat') ?? table.getChild('lat')
        const centroidLon = table.getChild('centroid_lon') ?? table.getChild('lon')
        const existingNaceCol = table.getChild('nace_4digit')
        const existingDatasetIdCol = table.getChild('source_id')
        if (!osmId || !centroidLat || !centroidLon) return table
        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        const existingSourceId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          existingSourceId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
          newDatasetId[j] = existingSourceId[j]
        }
        let anyChanged = false

        for (let i = 0; i < n; i++) {
          totalOsm++
          const lat = centroidLat.get(i) as number
          const lon = centroidLon.get(i) as number
          if (lat == null || lon == null) continue
          if (!inBbox(lat, lon, TN_BBOX) || inExcluded(lat, lon)) continue

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
            const nace6 = best.fuel.includes('solar') ? 359900 : best.fuel.includes('wind') ? 351200 : 351100
            const nace4 = Math.floor(nace6 / 100)
            const existingId = existingSourceId[i]
            if (shouldOverwrite(existingId, MY_SOURCE_ID)) {
              newNace[i] = nace4
              newDatasetId[i] = MY_SOURCE_ID
              if (existingId === 0) newEntries++
              matched++
              anyChanged = true
            }
          }
        }
        if (!anyChanged) return table
        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'source_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = vectorFromArray(newNace, new Uint16())
        columns['source_id'] = vectorFromArray(newDatasetId, new Uint16())
        return makeTable(columns)
      })
    } catch {}
  }

  console.log(`=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched:                      ${matched.toLocaleString()}`)
  console.log(`  New/updated arrow rows:       ${newEntries.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
