/**
 * Shared driver for the 108-ish "enrich-industrial-{cc}" scripts that wrap
 * GEM Global Integrated Power for a single country.
 *
 * Each per-country file used to be ~190 lines of near-identical boilerplate:
 *   load GEM `power-plants-gem.geojson` → grid → iterate per-hex →
 *   `withArrowWrite` → spatial nearest match → write `nace_4digit + source_id`.
 *
 * Here we keep the loop and reduce each per-country file to ~30 lines —
 * country-specific docstring + bbox + (optional) finer filter + a single
 * `enrichGemIndustrial({...})` call. NACE-4 mapping defaults to the
 * solar/wind/other split we used everywhere; pass `fuelToNace` to override.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

import { shouldOverwrite, withArrowWrite } from './provenance.js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './source-ids.generated.js'
import { flatDistM, inBbox } from './spatial.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface GemSite {
  lat: number
  lon: number
  name: string
  fuel: string
}

export interface EnrichGemArgs {
  /** Lowercase ISO code — used for `data/enrichment/<year>/<code>` cache dir
   *  and as the upper-cased prefix in log lines. */
  countryCode: string
  /** Display name (for the docstring's "Foo Industrial Enrichment" log line). */
  countryName: string
  /** `[minLat, minLon, maxLat, maxLon]`. Drives the hex-shortlist filter and
   *  is the default `isInside` test if none supplied. */
  bbox: readonly [number, number, number, number]
  /** Finer filter than bbox alone — e.g. exclude-zones, lat/lon cuts for
   *  inland borders. Receives lat, lon and returns true when the point is
   *  inside the country. Defaults to `inBbox(lat, lon, bbox)`. */
  isInside?: (lat: number, lon: number) => boolean
  /** Spatial search radius for nearest-plant match (metres). Default 2000.
   *  PY uses 3000 due to sparser GEM coverage. */
  searchRadiusM?: number
  /** GEM `Type` (lowercased) → NACE-4 classifier. Default:
   *  solar→3599, wind→3512, anything else→3511 (electric power gen). */
  fuelToNace?: (fuel: string) => number
}

const DEFAULT_FUEL_TO_NACE = (fuel: string): number => {
  if (fuel.includes('solar')) return 3599
  if (fuel.includes('wind')) return 3512
  return 3511
}

export async function enrichGemIndustrial(args: EnrichGemArgs): Promise<void> {
  const YEAR = process.env.DATA_YEAR || '2025'
  const H3R4_DIR = resolve(__dirname, `../../data/prepared/${YEAR}/h3r4`)
  const CACHE_DIR = resolve(__dirname, `../../data/enrichment/${YEAR}/${args.countryCode}`)
  const isInside = args.isInside ?? ((lat: number, lon: number) => inBbox(lat, lon, args.bbox))
  const fuelToNace = args.fuelToNace ?? DEFAULT_FUEL_TO_NACE
  const searchRadiusM = args.searchRadiusM ?? 2000
  const upper = args.countryCode.toUpperCase()
  const MY_SOURCE_ID = SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX

  console.log(`=== ${upper} Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants: GemSite[] = []
  const gemPath = resolve(CACHE_DIR, 'power-plants-gem.geojson')
  if (existsSync(gemPath)) {
    const fc = JSON.parse(readFileSync(gemPath, 'utf-8'))
    for (const f of fc.features ?? []) {
      const g = f.geometry
      if (!g || g.type !== 'Point') continue
      const [lon, lat] = g.coordinates ?? []
      if (lat == null || lon == null) continue
      if (!isInside(lat, lon)) continue
      const p = f.properties ?? {}
      const status = (p.Status ?? '').toString().toLowerCase()
      if (!status.includes('operating')) continue
      plants.push({
        lat,
        lon,
        name: (p.Plant___Project_name ?? `${upper} plant`).toString(),
        fuel: (p.Type ?? 'unknown').toString().toLowerCase(),
      })
    }
  }

  const fuelCounts: Record<string, number> = {}
  for (const p of plants) fuelCounts[p.fuel] = (fuelCounts[p.fuel] ?? 0) + 1
  console.log(`  GEM operating plants in ${upper}: ${plants.length}`)
  for (const [f, c] of Object.entries(fuelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(15)} ${c}`)
  }

  const grid = new Map<string, GemSite[]>()
  for (const s of plants) {
    const key = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }

  if (!existsSync(H3R4_DIR)) {
    console.log(`  ${H3R4_DIR} does not exist — nothing to enrich.`)
    return
  }
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (isInside(lat, lon) && existsSync(resolve(H3R4_DIR, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ${upper}-bbox hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0
  let matched = 0
  let newEntries = 0

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
          if (!isInside(lat, lon)) continue

          const baseLat = Math.floor(lat * 10)
          const baseLon = Math.floor(lon * 10)
          let best: GemSite | null = null
          let bestDist = searchRadiusM
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
          if (!best) continue
          const existingId = existingSourceId[i]
          if (!shouldOverwrite(existingId, MY_SOURCE_ID)) continue
          newNace[i] = fuelToNace(best.fuel)
          newDatasetId[i] = MY_SOURCE_ID
          if (existingId === 0) newEntries++
          matched++
          anyChanged = true
        }
        if (!anyChanged) return table

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
