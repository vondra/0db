/**
 * The ONE place railway train counts are written — the rail twin of
 * `writeRoadAadt` in `roads-arrow.ts`. Centralizes the read→seed→gate→write
 * plumbing every `enrich-railway-{cc}.ts` hand-rolled, and the two correctness
 * invariants that the class-blind enrichers kept getting wrong:
 *
 *   1. SERVICE-SKIP — sidings/yards/spurs (`service > 0`) carry ~no through
 *      traffic and must never inherit a mainline count. (CZ stamped 94,928 of
 *      them before the fix; this skip is now unforgettable.)
 *   2. PRIORITY GATE — `shouldOverwrite` decides per row, so a national feed
 *      can't clobber a higher-rank neighbour's cross-border rows.
 *
 * The FAMILY routing (rail↔rail_type 0, tram↔1/2) + the CNOSSOS class-default
 * fallback (owner-confirmed L2: fill by type, no silent track) live in the
 * per-feed `match` closure — each national GTFS classifies its own route_types,
 * so that stays per-country (see `enrich-railway-th.ts` for the reference shape).
 */

import { makeVector, makeTable, type Table } from 'apache-arrow'
import { shouldOverwrite, withArrowWrite } from './provenance.js'

/** Train counts per day + the provenance id to stamp on one matched railway row. */
export interface RailTrains {
  pax: number
  frt: number
  sourceId: number
}

/** Read-only view of one railway row, handed to the match callback. */
export interface RailRow {
  /** 0=rail 1=tram 2=light_rail 3=narrow_gauge 4=funicular (engine inputs.rs). */
  railType: number
  /** 0=main 1=branch 2=industrial. */
  usage: number
  /** The source_id already on the row. Fast-exit BEFORE expensive matching when a
   *  higher-priority dataset owns it: `if (!shouldOverwrite(row.existingSourceId, MY_ID)) return null`.
   *  The writer re-applies the same gate, so this is a perf shortcut, never the safety net. */
  existingSourceId: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  midLat: number
  midLon: number
  /** OSM `name` ('' when absent) — lets an enricher disambiguate named corridors
   *  (e.g. ET routes EDR vs AKR on the shared Addis–Awash trunk by line name). */
  name: string
}

export interface WriteRailResult {
  rows: number
  matched: number
  updated: boolean
  /** Rows skipped because `service > 0` (sidings/yards) — never offered to `match`. */
  skippedService: number
}

/**
 * Seed-from-existing → skip service tracks → run `match` per non-service row
 * behind the `shouldOverwrite` priority gate → rebuild trains_passenger/
 * trains_freight (Int32) + source_id (Uint16), all other columns copied verbatim
 * (so a hex's `parallel_divisor` survives) → atomic 'file'-format write via
 * `withArrowWrite`. Returns the original table unchanged when nothing matched, so
 * the file stays byte-identical.
 *
 * `match(row, i)` is invoked for every NON-SERVICE row (return `null` = leave the
 * row as-is). Do the family routing + class-default fallback inside it; for L2
 * (fill by type) it should rarely return null. `onApplied` fires only after the
 * priority gate accepts a match — count matched there, not before the gate.
 */
export async function writeRailTrains(
  arrowPath: string,
  match: (row: RailRow, i: number) => RailTrains | null,
  onApplied?: (row: RailRow, i: number, applied: RailTrains) => void,
): Promise<WriteRailResult> {
  let rows = 0
  let matched = 0
  let skippedService = 0
  let updated = false

  await withArrowWrite(arrowPath, (table: Table): Table => {
    const n = table.numRows
    rows = n
    if (n === 0) return table

    const sLat = table.getChild('start_lat')
    const sLon = table.getChild('start_lon')
    const eLat = table.getChild('end_lat')
    const eLon = table.getChild('end_lon')
    const rtCol = table.getChild('rail_type')
    const usCol = table.getChild('usage')
    const nmCol = table.getChild('name')
    const svcCol = table.getChild('service')
    if (!sLat || !sLon) return table // malformed hex — never touch

    const exPax = table.getChild('trains_passenger')
    const exFrt = table.getChild('trains_freight')
    const exSrc = table.getChild('source_id')

    const pax = new Int32Array(n)
    const frt = new Int32Array(n)
    const src = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      pax[i] = (exPax?.get(i) as number) ?? 0
      frt[i] = (exFrt?.get(i) as number) ?? 0
      src[i] = (exSrc?.get(i) as number) ?? 0
    }

    let any = false
    for (let i = 0; i < n; i++) {
      // Service tracks (yards/sidings/spurs) never inherit a count — centralized
      // here so no enricher can forget it (the CZ 94,928-siding bug).
      if (((svcCol?.get(i) as number) ?? 0) > 0) { skippedService++; continue }

      const startLat = sLat.get(i) as number
      const startLon = sLon.get(i) as number
      const endLat = (eLat?.get(i) as number) ?? startLat
      const endLon = (eLon?.get(i) as number) ?? startLon
      const row: RailRow = {
        railType: (rtCol?.get(i) as number) ?? 0,
        usage: (usCol?.get(i) as number) ?? 0,
        existingSourceId: src[i],
        startLat,
        startLon,
        endLat,
        endLon,
        midLat: (startLat + endLat) / 2,
        midLon: (startLon + endLon) / 2,
        name: (nmCol?.get(i) as string) ?? '',
      }
      const m = match(row, i)
      if (!m) continue
      // Fail loud on a malformed match — TypedArrays silently coerce/truncate a bad
      // value (NaN→0, 70000→4464, -1→huge), exactly how the road "wrote zeros" bugs
      // slipped through. Train counts are non-negative ints; source_id fits Uint16.
      if (
        !Number.isInteger(m.pax) || m.pax < 0 ||
        !Number.isInteger(m.frt) || m.frt < 0 ||
        !Number.isInteger(m.sourceId) || m.sourceId <= 0 || m.sourceId > 0xffff
      ) {
        throw new Error(`writeRailTrains: invalid match at row ${i} in ${arrowPath}: ${JSON.stringify(m)}`)
      }
      if (!shouldOverwrite(src[i], m.sourceId)) continue // priority gate OWNED here
      pax[i] = m.pax
      frt[i] = m.frt
      src[i] = m.sourceId
      matched++
      any = true
      onApplied?.(row, i, m)
    }
    if (!any) return table // no change → withArrowWrite leaves bytes untouched
    updated = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixed Vector/makeVector
    // record vs makeTable's TypedArray-only typing (see roads-arrow.ts).
    const cols: Record<string, any> = {}
    for (const f of table.schema.fields) {
      if (['trains_passenger', 'trains_freight', 'source_id'].includes(f.name)) continue
      cols[f.name] = table.getChild(f.name)!
    }
    cols['trains_passenger'] = makeVector(pax)
    cols['trains_freight'] = makeVector(frt)
    cols['source_id'] = makeVector(src)
    return makeTable(cols)
  })

  return { rows, matched, updated, skippedService }
}
