/**
 * Enrich SV industrial with GEM Global Integrated Power (El Salvador filter).
 *
 * CEL (Comisión Ejecutiva Hidroeléctrica del Río Lempa) and SIGET publish
 * no open machine-readable plant data. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='El Salvador'):
 *     60 operating plants, ~2,563 MW total
 *
 *   Notable operating plants:
 *     **Cerrón Grande hydro 170 MW**     (hydro — Río Lempa, Chalatenango; largest hydro)
 *     **15 de Septiembre hydro 156 MW**  (hydro — Río Lempa, Cuscatlán/San Vicente)
 *     **5 de Noviembre hydro 81 MW**     (hydro — Río Lempa, Cabañas)
 *     **Ahuachapán geothermal 95 MW**    (geothermal — Ahuachapán; operating since 1975)
 *     **Berlín geothermal 109 MW**       (geothermal — Usulután; LAGEO/ENEL JV)
 *     **Acajutla thermal 239 MW**        (gas/HFO — Acajutla port, Sonsonate)
 *     **Duke Energy Nejapa thermal**     (gas/diesel — Nejapa, San Salvador metro)
 *     **Ingenio El Ángel bagasse**       (bagasse CHP — Ahuachapán; sugar harvest season)
 *     **Ingenio Chaparrastique bagasse** (bagasse CHP — San Miguel)
 *     **Monte Rosa bagasse ~60 MW**      (bagasse CHP — Izalco, Sonsonate)
 *     **Providencia solar ~30 MW**       (solar — Ahuachapán)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar** — Pacific coastal plain (Sonsonate, La Libertad, Ahuachapán);
 *     SV has ~8 major ingenios; DIZUCAR cooperative; bagasse cogeneration
 *   - **Coffee** — Apaneca-Ilamatepec (volcanic highlands), Santa Ana, Chalatenango;
 *     world-class SHB Arabica; protected denomination "Café de El Salvador"
 *   - **Textiles/Maquila** — San Marcos, Soyapango, Santa Tecla free zones;
 *     US apparel brands; ~88,000 maquila workers
 *   - **Food processing** — Soyapango industrial zone (largest in Central America
 *     by density); beverages (SAB Miller/Industrias La Constancia), baked goods
 *   - **Cement** — CESSA (Cementos de El Salvador) plant in Metapán, Santa Ana;
 *     only domestic producer
 *   - **Chemical/Plastics** — Soyapango and Santa Ana industrial parks
 *   - **Fishing** — La Unión (Gulf of Fonseca) and Acajutla; tuna and shrimp export
 *   - **Geothermal** — SV is world #9 geothermal electricity producer; LaGeo
 *     operates Ahuachapán and Berlín fields; ~25% of national electricity
 *
 * SV_BBOX: [minLat=13.1, minLon=-90.2, maxLat=14.5, maxLon=-87.7]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-sv.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/sv`)

// El Salvador bbox: [minLat, minLon, maxLat, maxLon]
const SV_BBOX: [number, number, number, number] = [13.1, -90.2, 14.5, -87.7]

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
    if (!inBbox(lat, lon, SV_BBOX)) continue
    const p = f.properties || {}
    const status = (p.Status || '').toString().toLowerCase()
    if (!status.includes('operating')) continue
    out.push({
      lat, lon,
      name: (p.Plant___Project_name || 'SV plant').toString(),
      fuel: (p.Type || 'unknown').toString().toLowerCase(),
    })
  }
  return out
}

async function main() {
  console.log(`=== SV Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants = loadGemPlants()
  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] || 0) + 1
  console.log(`  GEM operating plants in SV: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, IndSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  const MY_DATASET_ID = DATASETS_BY_KEY.get('sv-industrial')!.id

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, SV_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  SV-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

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
        const existingDatasetIdCol = table.getChild('industrial_dataset_id')
        if (!osmId || !centroidLat || !centroidLon) return table
        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        const existingDatasetId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          existingDatasetId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
          newDatasetId[j] = existingDatasetId[j]
        }
        let anyChanged = false
        for (let i = 0; i < n; i++) {
          totalOsm++
          const lat = centroidLat.get(i) as number
          const lon = centroidLon.get(i) as number
          if (lat == null || lon == null) continue
          if (!inBbox(lat, lon, SV_BBOX)) continue
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
            const existingId = existingDatasetId[i]
            if (shouldOverwrite(existingId, MY_DATASET_ID)) {
              newNace[i] = nace4
              newDatasetId[i] = MY_DATASET_ID
              if (existingId === 0) newEntries++
              matched++
              anyChanged = true
            }
          }
        }
        if (!anyChanged) return table
        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'industrial_dataset_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = vectorFromArray(Array.from(newNace), new Uint16())
        columns['industrial_dataset_id'] = vectorFromArray(Array.from(newDatasetId), new Uint16())
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
