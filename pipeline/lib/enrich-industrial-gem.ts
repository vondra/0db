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
import { makeCountryGate } from './country-polygon.js'
import { DATA_YEAR as YEAR } from './data-year.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Contest identity of the national-mix source (id 330) — shared by the GEM driver and
 *  every bespoke national enricher so rank/year can't drift per country. Spread into a
 *  MatchFacility: `{ lat, lon, nace4, ...NATIONAL_MIX }`. */
export const NATIONAL_MIX: { id: number; rank: number; year: number } = {
  id: SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX,
  rank: PROVENANCE_RANK[SOURCES_BY_ID.get(SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX)?.provenance ?? 'none'],
  year: SOURCES_BY_ID.get(SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX)?.year ?? 0,
}

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
  /** National-ownership gate override. Defaults to
   *  `makeCountryGate(countryCode)`; pass explicitly only when the code has no
   *  CGAZ polygon (makeCountryGate throws — fail loud beats a silent
   *  all-false gate). See StampOneWinnerArgs.countryGate. */
  countryGate?: (lat: number, lon: number) => boolean
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


/** Arguments for the shared one-winner stamping core. */
export interface StampOneWinnerArgs {
  /** Prepared registry sites (nace4/id/rank/year set). EMPTY → hard no-op: a run that
   *  cannot re-stamp must never reset (the Argentina lesson — /gg consensus CRITICAL). */
  facilities: MatchFacility[]
  /** Area membership test — gates candidate polygons AND the reset. */
  isInside: (lat: number, lon: number) => boolean
  /** Hex-shortlist gate (H3 cell CENTRE test). Defaults to isInside — override with a
   *  BROADER test (plain bbox) when isInside is a polygon/exclude-zone gate: a border hex
   *  centred just outside still holds in-area rows whose old stamps must be swept
   *  (/gg Codex — VN coastal hexes were skipped entirely under the strict gate). */
  hexGate?: (lat: number, lon: number) => boolean
  searchRadiusM: number
  /** OUR source ids: rows carrying one of these inside isInside AND inside
   *  `countryGate` are reset before stamping. */
  resetSourceIds: readonly number[]
  /** National-ownership gate — this pass's own COUNTRY polygon
   *  (`makeCountryGate(iso)`). `source_id` 330 is SHARED by every generic
   *  country pass, so BOTH destructive arms are scoped by it: the reset may
   *  clear and the winner write may stamp only rows inside the pass's own
   *  country. The old bbox-wide blanket reset deleted a NEIGHBOUR's winners
   *  wherever hand bboxes overlap (ML's bbox blankets BF — 6 BF winner rows
   *  zeroed on every ML run; #31.1 CRITICAL); a geometry-proximity scope (the
   *  first fix attempt) broke CO's two-tier sweep and stayed ambiguous within
   *  `searchRadiusM` of a border. The polygon is the unambiguous ownership
   *  signal, sweeps DELETED sites' stale stamps too, and is the same medicine
   *  as the rail writers' #26C/#31.7 countryGate. Per-ROW test, never a
   *  hex-centre gate — coastal sites keep working (the VN lesson was about
   *  hex-centre gating, not point tests). Known residue: a legacy stamp whose
   *  polygon sits in NO country (offshore / CGAZ gap) is unreachable by every
   *  pass — the one-off orphan sweep is a chain-level audit+heal follow-up
   *  (#31 remainder), not a per-pass concern. */
  countryGate: (lat: number, lon: number) => boolean
  /** True when the source dataset PARSED non-empty (any status/fuel, before
   *  the operating/fuel filters). Allows a sweep-only run when `facilities`
   *  filtered down to zero — a country whose last plant retired heals its
   *  stale stamps instead of freezing them forever. With the dataset
   *  missing/empty this stays false and the pass is a hard no-op (a run that
   *  cannot re-stamp must never reset — the Argentina lesson). */
  datasetNonEmpty?: boolean
  /** Log prefix, e.g. "ZA". */
  label: string
  /** data/prepared/<year>/h3r4 root. */
  h3r4Dir: string
}

/**
 * THE industrial one-winner stamping core — shared by the GEM driver (106 countries) and
 * every bespoke national enricher (za/cn/ve/…), so the ONE-site-ONE-polygon contract can't
 * drift per country. Pass 1 (read-only) elects each site's best polygon across the whole
 * area via lib/facility-match; a polygon claimed twice goes to contestBeats (identical
 * rank/year/id ⇒ the nearer site). Pass 2 resets `resetSourceIds` rows inside
 * `isInside ∧ countryGate` (the pass's own country — never a sibling's, see
 * `countryGate`), then writes the winners through shouldOverwrite, also
 * countryGate-scoped.
 */
export async function stampOneWinner(a: StampOneWinnerArgs): Promise<void> {
  if (a.facilities.length === 0 && !a.datasetNonEmpty) {
    console.log('  No stampable sites and no parsed dataset — leaving existing stamps untouched (no-op).')
    return
  }
  if (a.facilities.length === 0) {
    console.log('  0 stampable sites but the dataset parsed non-empty — sweep-only run (stale stamps heal, nothing stamped).')
  }
  if (!existsSync(a.h3r4Dir)) {
    console.log(`  ${a.h3r4Dir} does not exist — nothing to enrich.`)
    return
  }
  const hexGate = a.hexGate ?? a.isInside
  const hexDirs: string[] = []
  for (const hex of readdirSync(a.h3r4Dir).filter(d => d.length === 15 && d.endsWith('ffffffff'))) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (hexGate(lat, lon) && existsSync(resolve(a.h3r4Dir, hex, 'industrial.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  ${a.label}-area hexes with industrial.arrow: ${hexDirs.length}\n`)

  let totalOsm = 0
  let matched = 0
  let totalReset = 0

  // pass 1: best polygon per site, reduced across every hex in the area
  const bestByFac = new Map<MatchFacility, { hex: string; row: number; edge: number }>()
  const polysByHex = new Map<string, MatchPolygon[]>()
  for (const hex of hexDirs) {
    const arrowPath = resolve(a.h3r4Dir, hex, 'industrial.arrow')
    let polygons: MatchPolygon[]
    try {
      polygons = readPolygons(tableFromIPC(readFileSync(arrowPath)))
    } catch { continue }
    polysByHex.set(hex, polygons)
    totalOsm += polygons.length
    // Border hexes (H3 centre in-area) can hold OUT-of-area/foreign polygons; a winner
    // there isn't ours to stamp (countryGate re-checks at write). Mask them by
    // teleporting to an impossible coordinate — indexes must stay aligned with the
    // arrow rows, so filtering the array is not an option (/gg Codex).
    const gated = polygons.map((p) => (a.isInside(p.lat, p.lon) && a.countryGate(p.lat, p.lon) ? p : { ...p, lat: 90, lon: 180 }))
    for (const fac of a.facilities) {
      const cand = bestCandidate(fac, gated, a.searchRadiusM)
      if (!cand) continue
      const prev = bestByFac.get(fac)
      if (!prev || cand.edge < prev.edge) bestByFac.set(fac, { hex, row: cand.row, edge: cand.edge })
    }
  }

  // contested polygon → shouldOverwrite order, nearer site last (facility-match.contestBeats)
  const winnersByHex = new Map<string, Map<number, { fac: MatchFacility; edge: number }>>()
  for (const [fac, w] of bestByFac) {
    const rows = winnersByHex.get(w.hex) ?? new Map<number, { fac: MatchFacility; edge: number }>()
    winnersByHex.set(w.hex, rows)
    const cur = rows.get(w.row)
    if (!cur || contestBeats({ rank: fac.rank, year: fac.year, id: fac.id, edge: w.edge },
      { rank: cur.fac.rank, year: cur.fac.year, id: cur.fac.id, edge: cur.edge })) rows.set(w.row, { fac, edge: w.edge })
  }

  // pass 2: reset our old stamps inside OUR OWN COUNTRY (never a sibling's —
  // the shared id's other territory belongs to its pass), then stamp the winners
  const resetIds = new Set(a.resetSourceIds)
  for (const hex of hexDirs) {
    const winners = winnersByHex.get(hex)
    const polygons = polysByHex.get(hex)
    if (!polygons) continue
    const arrowPath = resolve(a.h3r4Dir, hex, 'industrial.arrow')
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
          if (!resetIds.has(newDatasetId[i])) continue
          const p = polygons[i]
          if (!p || !a.isInside(p.lat, p.lon)) continue
          if (!a.countryGate(p.lat, p.lon)) continue // sibling country's row — not ours to clear (#31.1)
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
  console.log(`  Sites with a polygon:         ${bestByFac.size.toLocaleString()} of ${a.facilities.length.toLocaleString()}`)
  console.log(`  Polygons stamped:             ${matched.toLocaleString()} (max 1 per site)`)
}

export async function enrichGemIndustrial(args: EnrichGemArgs): Promise<void> {
  const H3R4_DIR = resolve(__dirname, `../../data/prepared/${YEAR}/h3r4`)
  const CACHE_DIR = resolve(__dirname, `../../data/enrichment/${YEAR}/${args.countryCode}`)
  const isInside = args.isInside ?? ((lat: number, lon: number) => inBbox(lat, lon, args.bbox))
  const fuelToNace = args.fuelToNace ?? DEFAULT_FUEL_TO_NACE
  const searchRadiusM = args.searchRadiusM ?? 2000
  const upper = args.countryCode.toUpperCase()
  const MY_SOURCE_ID = NATIONAL_MIX.id

  console.log(`=== ${upper} Industrial Enrichment — GEM Global Integrated Power (${YEAR}) ===\n`)

  const plants: GemSite[] = []
  // Parsed-count BEFORE the status/fuel filters: proves the feed loaded, which
  // is what authorizes a sweep-only run when every plant retired (see
  // `datasetNonEmpty` on stampOneWinner).
  let parsedSites = 0
  const gemPath = resolve(CACHE_DIR, 'power-plants-gem.geojson')
  if (existsSync(gemPath)) {
    const fc = JSON.parse(readFileSync(gemPath, 'utf-8'))
    for (const f of fc.features ?? []) {
      const g = f.geometry
      if (!g || g.type !== 'Point') continue
      const [lon, lat] = g.coordinates ?? []
      if (lat == null || lon == null) continue
      if (!isInside(lat, lon)) continue
      parsedSites++
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

  // ONE plant, ONE polygon — the shared core owns the two passes + all safety rails
  // (empty-set no-op, border gating, area-scoped reset; see stampOneWinner above).
  const prepared: MatchFacility[] = []
  for (const p of plants) {
    const nace = fuelToNace(p.fuel)
    if (nace == null) continue // wind / blank-fuel — never stamps
    prepared.push({ lat: p.lat, lon: p.lon, nace4: nace, ...NATIONAL_MIX })
  }
  await stampOneWinner({
    facilities: prepared,
    isInside,
    // The documented shortlist contract: bbox drives WHICH HEXES are visited,
    // isInside only gates rows. Without this, a custom polygon/exclude-zone
    // isInside also became the hex-CENTRE test and border hexes vanished from
    // match AND sweep (the VN coastal lesson; #31 round-2 Codex).
    hexGate: (lat, lon) => inBbox(lat, lon, args.bbox),
    searchRadiusM,
    resetSourceIds: [MY_SOURCE_ID],
    countryGate: args.countryGate ?? makeCountryGate(args.countryCode),
    datasetNonEmpty: parsedSites > 0,
    label: upper,
    h3r4Dir: H3R4_DIR,
  })
}
