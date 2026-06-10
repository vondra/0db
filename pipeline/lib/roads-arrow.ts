/**
 * The ONE place road AADT is written, and the ONE way road enrichers enumerate
 * hexes. Centralizes the plumbing every `enrich-roads-{cc}.ts` used to hand-roll
 * (and where three Q2-2026 bugs lived: IT forgot medium/heavy/moto, SA forgot
 * source_id, GB used `new table.constructor`). A per-country script supplies only
 * a `match` closure; it physically cannot forget a class column or the stamp.
 *
 * The per-country LOADER stays per-country (each national census is a different
 * source/API/CRS) — only this identical write+scan plumbing is shared. See
 * `.claude/skills/_shared/noise-enrichment-contract.md`.
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Int32, Uint16, vectorFromArray, makeTable, type Table } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { shouldOverwrite, withArrowWrite } from './provenance.js'
import { inBbox } from './spatial.js'

/** AADT per CNOSSOS class + the provenance id to stamp on one matched road row.
 *  `sourceId` is per-row on purpose — DE writes Autobahn vs Bundesstraße ids in
 *  a single pass (`enrich-roads-de.ts`). */
export interface RoadAadt {
  light: number
  medium: number
  heavy: number
  moto: number
  sourceId: number
}

/** Read-only view of one road row, handed to the match callback. */
export interface RoadRow {
  ref: string | null
  roadClass: number
  /** The source_id already on the row. Let the closure fast-exit BEFORE expensive
   *  matching when a higher-priority dataset owns the row:
   *  `if (!shouldOverwrite(row.existingSourceId, MY_ID)) return null`. The writer
   *  re-applies the same gate, so this is a perf shortcut, never the safety net. */
  existingSourceId: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  midLat: number
  midLon: number
}

export interface WriteRoadResult {
  rows: number
  matched: number
  updated: boolean
  /** Rows whose `road_class` fell outside the source's `coverage` set — skipped
   *  before `match` ran, so a major-road dataset cannot stamp a minor road. */
  skipped: number
}

/**
 * Seed-from-existing → run `match` per row → apply only behind the
 * `shouldOverwrite` priority gate → rebuild the five columns (aadt_light/medium/
 * heavy/moto Int32 + source_id Uint16, all other columns copied verbatim) → atomic
 * 'file'-format write via `withArrowWrite`. Returns the original table unchanged
 * when nothing matched, so the file is left byte-identical.
 *
 * `match(row, i)` is invoked for every row WITHIN `coverage` (return `null` = no
 * match) — count per-class totals there. Rows whose `road_class` is outside
 * `coverage` are skipped before `match` (tallied in `result.skipped`), so a
 * dataset that only surveys major roads physically cannot stamp a minor one.
 * `onApplied(row, i)` fires only after the priority gate accepts a match — count
 * per-class matched there (the count must follow the gate, not precede it).
 */
export async function writeRoadAadt(
  arrowPath: string,
  match: (row: RoadRow, i: number) => RoadAadt | null,
  onApplied?: (row: RoadRow, i: number, applied: RoadAadt) => void,
  coverage?: ReadonlySet<number>,
): Promise<WriteRoadResult> {
  let rows = 0
  let matched = 0
  let skipped = 0
  let updated = false

  await withArrowWrite(arrowPath, (table: Table): Table => {
    const n = table.numRows
    rows = n
    if (n === 0) return table

    const refCol = table.getChild('ref')
    const sLat = table.getChild('start_lat')
    const sLon = table.getChild('start_lon')
    const eLat = table.getChild('end_lat')
    const eLon = table.getChild('end_lon')
    const clsCol = table.getChild('road_class')
    if (!sLat || !sLon) return table // malformed hex — never touch

    const exL = table.getChild('aadt_light')
    const exM = table.getChild('aadt_medium')
    const exH = table.getChild('aadt_heavy')
    const exMo = table.getChild('aadt_moto')
    const exSrc = table.getChild('source_id')

    const light = new Int32Array(n)
    const medium = new Int32Array(n)
    const heavy = new Int32Array(n)
    const moto = new Int32Array(n)
    const src = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      light[i] = (exL?.get(i) as number) ?? 0
      medium[i] = (exM?.get(i) as number) ?? 0
      heavy[i] = (exH?.get(i) as number) ?? 0
      moto[i] = (exMo?.get(i) as number) ?? 0
      src[i] = (exSrc?.get(i) as number) ?? 0
    }

    let any = false
    for (let i = 0; i < n; i++) {
      const startLat = sLat.get(i) as number
      const startLon = sLon.get(i) as number
      const endLat = (eLat?.get(i) as number) ?? startLat
      const endLon = (eLon?.get(i) as number) ?? startLon
      const row: RoadRow = {
        ref: (refCol?.get(i) as string | null) ?? null,
        roadClass: (clsCol?.get(i) as number) ?? 5,
        existingSourceId: src[i],
        startLat,
        startLon,
        endLat,
        endLon,
        midLat: (startLat + endLat) / 2,
        midLon: (startLon + endLon) / 2,
      }
      // Class gate (centralized so no enricher can forget it): a source whose
      // `coverage` set omits this row's `road_class` never reaches `match`, so a
      // major-road dataset can't bleed onto a residential/service street — the
      // Knoxville "Papermill Pointe Way" = 211,587 AADT bug. road_class codes:
      // 0 motorway..4 tertiary, 5 residential, 6 living_street, 7 service,
      // 8 track, 9 unclassified, 10/11/12 links (engine inputs.rs).
      if (coverage && !coverage.has(row.roadClass)) { skipped++; continue }
      const m = match(row, i)
      if (!m) continue
      // Fail loud on a malformed match (missing/NaN column, or a 0/unknown source_id):
      // TypedArrays silently coerce undefined/NaN to 0, which is exactly how the
      // IT/SA "wrote zeros" bugs slipped through. A migration typo aborts here.
      if (
        !Number.isFinite(m.light) || !Number.isFinite(m.medium) ||
        !Number.isFinite(m.heavy) || !Number.isFinite(m.moto) ||
        !Number.isInteger(m.sourceId) || m.sourceId <= 0
      ) {
        throw new Error(`writeRoadAadt: invalid match at row ${i} in ${arrowPath}: ${JSON.stringify(m)}`)
      }
      if (!shouldOverwrite(src[i], m.sourceId)) continue // priority gate OWNED here
      light[i] = m.light
      medium[i] = m.medium
      heavy[i] = m.heavy
      moto[i] = m.moto
      src[i] = m.sourceId
      matched++
      any = true
      onApplied?.(row, i, m)
    }
    if (!any) return table // no change → withArrowWrite leaves bytes untouched
    updated = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- apache-arrow's
    // makeTable/vectorFromArray overloads don't model TypedArray cleanly; the 31
    // enrichers all use `any` here and it's correct at runtime (tsx, no typecheck gate).
    const cols: Record<string, any> = {}
    for (const f of table.schema.fields) {
      if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(f.name)) continue
      cols[f.name] = table.getChild(f.name)!
    }
    cols['aadt_light'] = vectorFromArray(light, new Int32())
    cols['aadt_medium'] = vectorFromArray(medium, new Int32())
    cols['aadt_heavy'] = vectorFromArray(heavy, new Int32())
    cols['aadt_moto'] = vectorFromArray(moto, new Int32())
    cols['source_id'] = vectorFromArray(src, new Uint16())
    return makeTable(cols)
  })

  return { rows, matched, updated, skipped }
}

/**
 * Hex ids whose H3 centroid is inside `bbox = [minLat, minLon, maxLat, maxLon]`
 * AND that contain `layerFile`. The bbox is MANDATORY: there is no "scan every
 * hex" entry point, so the CZ/europe full-planet scan (121k hexes, ~40 min)
 * cannot be written again. Replaces the bespoke readdir+cellToLatLng loop that
 * 9+ country enrichers each re-implemented.
 */
export function iterateCountryHexes(
  h3r4Dir: string,
  bbox: readonly [number, number, number, number],
  layerFile = 'roads.arrow',
): string[] {
  if (!existsSync(h3r4Dir)) return []
  const out: string[] = []
  for (const d of readdirSync(h3r4Dir)) {
    if (d.length !== 15 || !d.endsWith('ffffffff')) continue
    try {
      const [lat, lon] = cellToLatLng(d)
      if (inBbox(lat, lon, bbox) && existsSync(resolve(h3r4Dir, d, layerFile))) out.push(d)
    } catch {
      /* invalid h3 id */
    }
  }
  return out
}
