/**
 * Enrich BR industrial with SIGACONTROL ArcGIS Online layers (ANEEL-derived).
 *
 * Source: services5.arcgis.com/qaWxR4XTuVOZEXZ9/arcgis/rest/services/
 *
 * Layers downloaded:
 *   - Aerogeradores_Brasil: **11,182 individual wind turbines** with POT_MW,
 *     ALT_TOTAL, ALT_ROTOR (hub height), DIAM_ROTOR — the richest wind turbine
 *     dataset in our entire pipeline
 *   - UsinaTermoeletrica: 3,226 thermal plants (coal/gas/oil/biomass)
 *   - Aproveitamento_Hidroletrico: 1,138 hydro plants (including Itaipu,
 *     Belo Monte, Tucuruí, Furnas, Itumbiara)
 *   - UsinaFotovoltaica: 322 solar PV plants
 *   - UsinaTermonuclear: 3 nuclear plants (Angra I, II, III)
 *
 * All map to NACE 35 (Electricity generation).
 *
 * Note: status filter — prefer 'OPERACAO=SIM' for operational turbines and
 * 'Operação' for other plant types. GEM-style status field is not in SIGA
 * data; use OPERACAO field instead.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-br.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/br`)
const NACE_LOOKUP_PATH = resolve(import.meta.dirname, `../data/prepared/nace-lookup.json`)

const BR_BBOX: [number, number, number, number] = [-34.0, -74.0, 5.3, -34.8]
const EXCLUDE_ZONES: Array<[number, number, number, number]> = [
  [-56.0, -74.0, -22.0, -53.7],
  [-35.0, -58.5, -30.1, -53.1],
  [-27.7, -62.7, -19.3, -54.2],
  [-23.0, -69.7, -9.7, -57.5],
  [-18.4, -82.0, -0.0, -68.5],
  [-4.2, -79.1, 13.0, -66.8],
  [0.6, -73.4, 13.0, -59.8],
  [1.2, -61.4, 8.7, -56.5],
  [1.8, -58.1, 6.1, -53.9],
  [2.1, -54.6, 5.8, -51.6],
  [-56.0, -76.0, -17.5, -66.4],
  [-5.0, -81.0, 1.5, -75.2],
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

function loadPoints(path: string, fuel: string, nameField: string, statusField: string, statusOK: string[]): IndSite[] {
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: IndSite[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g || (g.type !== 'Point' && g.type !== 'MultiPoint')) continue
    const coords = g.type === 'Point' ? g.coordinates : g.coordinates[0]
    if (!coords) continue
    const [lon, lat] = coords
    if (lat == null || lon == null) continue
    if (!inBbox(lat, lon, BR_BBOX) || inExcluded(lat, lon)) continue
    const p = f.properties || {}
    const status = (p[statusField] || '').toString().toLowerCase()
    if (status && !statusOK.some(s => status.includes(s))) continue
    out.push({
      lat, lon,
      name: (p[nameField] || p.NOME || 'BR plant').toString(),
      fuel,
    })
  }
  return out
}

async function main() {
  console.log(`=== BR Industrial Enrichment — SIGACONTROL ANEEL layers (${YEAR}) ===\n`)

  // Wind turbines — use POT_MW >= 0.5 MW (ignore tiny test turbines)
  const wind = loadPoints(
    resolve(CACHE_DIR, 'wind-turbines.geojson'),
    'wind-turbine',
    'NOME_EOL', 'OPERACAO', ['sim', 'true', 'operacional']
  )
  const thermal = loadPoints(
    resolve(CACHE_DIR, 'thermal-plants.geojson'),
    'thermal', 'NOME', 'ESTAGIO', ['opera', 'sim']
  )
  const hydro = loadPoints(
    resolve(CACHE_DIR, 'hydro-plants.geojson'),
    'hydro', 'NOME', 'ESTAGIO', ['opera', 'sim']
  )
  const solar = loadPoints(
    resolve(CACHE_DIR, 'solar-plants.geojson'),
    'solar', 'NOME', 'ESTAGIO', ['opera', 'sim']
  )
  const nuclear = loadPoints(
    resolve(CACHE_DIR, 'nuclear-plants.geojson'),
    'nuclear', 'NOME', 'ESTAGIO', ['opera', 'sim']
  )

  console.log(`  Wind turbines (operating): ${wind.length}`)
  console.log(`  Thermal plants:            ${thermal.length}`)
  console.log(`  Hydro plants:              ${hydro.length}`)
  console.log(`  Solar plants:              ${solar.length}`)
  console.log(`  Nuclear plants:            ${nuclear.length}`)

  // Priority: thermal > hydro > nuclear > wind > solar (loudest first)
  const allSites: IndSite[] = [...thermal, ...hydro, ...nuclear, ...wind, ...solar]

  const grid = new Map<string, IndSite[]>()
  for (const s of allSites) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  let existing: Record<string, any> = {}
  if (existsSync(NACE_LOOKUP_PATH)) {
    try { existing = JSON.parse(readFileSync(NACE_LOOKUP_PATH, 'utf-8')) } catch {}
  }
  console.log(`  Existing nace-lookup entries: ${Object.keys(existing).length}`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, BR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  BR-bbox hexes with industrial.arrow: ${hexDirs.length}`)

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
        if (!inBbox(lat, lon, BR_BBOX) || inExcluded(lat, lon)) continue

        // Wind farms have larger buffers (2km) since OSM points may be park centroids
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
          lookup[id] = { nace2: '35', name: best.name, source: `SIGACONTROL BR (${best.fuel})` }
          matched++
        }
      }
    } catch {}
  }

  writeFileSync(NACE_LOOKUP_PATH, JSON.stringify(lookup, null, 2))
  console.log(`\n=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Matched:                      ${matched.toLocaleString()}`)
  console.log(`  New nace-lookup entries:      ${newEntries.toLocaleString()}`)
  console.log(`  Total nace-lookup entries:    ${Object.keys(lookup).length.toLocaleString()}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
