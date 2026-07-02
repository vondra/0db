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
import { makeTable, makeVector, tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

import { shouldOverwrite, withArrowWrite } from './provenance.js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './source-ids.generated.js'
import { SOURCES_BY_ID, PROVENANCE_RANK } from './sources.js'
import { bestCandidate, contestBeats, readPolygons, type MatchFacility, type MatchPolygon } from './facility-match.js'
import { inBbox } from './spatial.js'

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
  /** GEM `Type` (lowercased) → NACE-4 classifier, or `null` to SKIP the row.
   *  Default maps to the engine's nace_profile (industrial.rs): solar→3599 (55 dB),
   *  hydro→3512 (90 dB), thermal/nuclear/fossil/etc→3511 (97 dB); wind and blank-fuel
   *  return null. */
  fuelToNace?: (fuel: string) => number | null
}

// Source of truth for power-plant noise class. Wind is SKIPPED: turbines are already
// modelled as source_type=10 (their own rotating-source profile), so stamping a
// nearby OSM site NACE 3512 would give it a wrong 90 dB hydro profile. Blank fuel is
// SKIPPED rather than guessed as thermal (97 dB).
export const DEFAULT_FUEL_TO_NACE = (fuel: string): number | null => {
  if (!fuel || fuel === 'unknown') return null // skip — no fuel signal
  if (fuel.includes('wind')) return null        // skip — already source_type=10
  if (fuel.includes('solar')) return 3599
  if (fuel.includes('hydro')) return 3512
  return 3511 // thermal / nuclear / coal / gas / oil / biomass / geothermal
}

export async function enrichGemIndustrial(args: EnrichGemArgs): Promise<void> {
  const YEAR = process.env.DATA_YEAR || '2026'
  const H3R4_DIR = resolve(__dirname, `../../data/prepared/${YEAR}/h3r4`)
  const CACHE_DIR = resolve(__dirname, `../../data/enrichment/${YEAR}/${args.countryCode}`)
  const isInside = args.isInside ?? ((lat: number, lon: number) => inBbox(lat, lon, args.bbox))
  const fuelToNace = args.fuelToNace ?? DEFAULT_FUEL_TO_NACE
  const searchRadiusM = args.searchRadiusM ?? 2000
  const upper = args.countryCode.toUpperCase()
  const MY_SOURCE_ID = SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX
  const MY_RANK = PROVENANCE_RANK[SOURCES_BY_ID.get(MY_SOURCE_ID)?.provenance ?? 'none']
  const MY_YEAR = SOURCES_BY_ID.get(MY_SOURCE_ID)?.year ?? 0

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

  // ONE plant, ONE polygon — same contract as enrich-global-industrial.ts (the old
  // inverse loop stamped every polygon within radius of a plant; see dda746a1). Pass 1
  // (read-only) elects each plant's best polygon country-wide via lib/facility-match;
  // a polygon claimed twice goes to the nearer plant. Pass 2 resets THIS country's old
  // id-330 stamps (only inside isInside — other countries' stamps are not ours) and
  // writes the winners. plants==0 (missing/empty GEM cache) → no-op, never a wipe.
  const prepared: MatchFacility[] = []
  for (const p of plants) {
    const nace = fuelToNace(p.fuel)
    if (nace == null) continue // wind / blank-fuel — never stamps
    prepared.push({ lat: p.lat, lon: p.lon, nace4: nace, id: MY_SOURCE_ID, rank: MY_RANK, year: MY_YEAR })
  }
  if (prepared.length === 0) {
    // No stampable plants (missing/empty GEM cache, or wind-only country): a run that cannot
    // re-stamp must not touch the arrows — the reset would silently wipe this country's old
    // stamps with nothing to replace them (/gg consensus CRITICAL; Argentina lost 25 rows to
    // exactly this before the guard existed).
    console.log('  No stampable plants — leaving existing stamps untouched (no-op).')
    return
  }

  let totalOsm = 0
  let matched = 0
  let totalReset = 0

  // pass 1: best polygon per plant, reduced across every hex in the country
  const bestByPlant = new Map<MatchFacility, { hex: string; row: number; edge: number }>()
  const polysByHex = new Map<string, MatchPolygon[]>()
  for (const hex of hexDirs) {
    const arrowPath = resolve(H3R4_DIR, hex, 'industrial.arrow')
    let polygons: MatchPolygon[]
    try {
      polygons = readPolygons(tableFromIPC(readFileSync(arrowPath)))
    } catch { continue }
    polysByHex.set(hex, polygons)
    totalOsm += polygons.length
    // Border hexes (H3 centre in-country) can hold OUT-of-country polygons; a winner across
    // the border couldn't be reset by us later (the reset is isInside-gated) and isn't ours
    // to stamp. Mask them out by teleporting to an impossible coordinate — indexes must stay
    // aligned with the arrow rows, so filtering the array is not an option (/gg Codex).
    const gated = polygons.map((p) => (isInside(p.lat, p.lon) ? p : { ...p, lat: 90, lon: 180 }))
    for (const fac of prepared) {
      const cand = bestCandidate(fac, gated, searchRadiusM)
      if (!cand) continue
      const prev = bestByPlant.get(fac)
      if (!prev || cand.edge < prev.edge) bestByPlant.set(fac, { hex, row: cand.row, edge: cand.edge })
    }
  }

  // contested polygon → nearer plant (all candidates share id/rank/year here)
  const winnersByHex = new Map<string, Map<number, { fac: MatchFacility; edge: number }>>()
  for (const [fac, w] of bestByPlant) {
    const rows = winnersByHex.get(w.hex) ?? new Map<number, { fac: MatchFacility; edge: number }>()
    winnersByHex.set(w.hex, rows)
    const cur = rows.get(w.row)
    if (!cur || contestBeats({ rank: fac.rank, year: fac.year, id: fac.id, edge: w.edge },
      { rank: cur.fac.rank, year: cur.fac.year, id: cur.fac.id, edge: cur.edge })) rows.set(w.row, { fac, edge: w.edge })
  }

  // pass 2: reset our old country-scoped stamps, then stamp the winners
  for (const hex of hexDirs) {
    const winners = winnersByHex.get(hex)
    const polygons = polysByHex.get(hex)
    if (!polygons) continue
    const arrowPath = resolve(H3R4_DIR, hex, 'industrial.arrow')
    try {
      await withArrowWrite(arrowPath, table => {
        const n = table.numRows
        if (n === 0) return table
        const existingNaceCol = table.getChild('nace_4digit')
        const existingDatasetIdCol = table.getChild('source_id')
        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          newDatasetId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
        }
        let anyChanged = false
        for (let i = 0; i < n; i++) {
          if (newDatasetId[i] !== MY_SOURCE_ID) continue
          if (!isInside(polygons[i]?.lat ?? 0, polygons[i]?.lon ?? 0)) continue
          newNace[i] = 0
          newDatasetId[i] = 0
          totalReset++
          anyChanged = true
        }
        if (winners) {
          for (const [row, w] of winners) {
            if (row >= n) continue
            if (!shouldOverwrite(newDatasetId[row], w.fac.id)) continue
            newNace[row] = w.fac.nace4
            newDatasetId[row] = w.fac.id
            matched++
            anyChanged = true
          }
        }
        if (!anyChanged) return table

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'source_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = makeVector(newNace)
        columns['source_id'] = makeVector(newDatasetId)
        return makeTable(columns)
      })
    } catch {}
  }

  console.log(`=== Results ===`)
  console.log(`  OSM industrial sites scanned: ${totalOsm.toLocaleString()}`)
  console.log(`  Old stamps reset:             ${totalReset.toLocaleString()}`)
  console.log(`  Plants with a polygon:        ${bestByPlant.size.toLocaleString()} of ${prepared.length.toLocaleString()}`)
  console.log(`  Polygons stamped:             ${matched.toLocaleString()} (max 1 per plant)`)
}
