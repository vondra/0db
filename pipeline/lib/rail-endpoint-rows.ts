/**
 * Scope-wide rail endpoint row collector — the ONE place both the R15/R16
 * continuity auditors (audit-enrichment-invariants.ts) and the rail
 * continuity metrics in enrichment-status.ts read railways.arrow rows into
 * `RailEndpointRow` records, so the two tools' numbers can never drift
 * (2026-07-15 railway continuity plan, Phase 2 — /gg review item 13).
 *
 * Reads each hex's railways.arrow ONCE, full-row (never sampled — adjacency
 * needs every segment), filtered down to heavy-rail non-service rows
 * (rail_type===0 && service===0 — the only rows a rail continuity jump/gap
 * can ever be about; trams/light_rail/narrow/funicular and yard/siding rows
 * never enter this index). Each row also carries `lengthM` — not part of the
 * `RailEndpointRow` contract the detectors in rail-graph-metrics.ts consume,
 * but `RailEndpointRowWithLength` is a structural superset of it, so the same
 * array feeds `findRailFlowJumps`/`findRailContinuityGaps` directly AND lets
 * enrichment-status compute its km metrics off the exact same rows. A hex
 * whose railways.arrow lacks trains_passenger/trains_freight entirely (never
 * rail-enriched) still contributes its rows with pax=frt=0 (2026-07-16 /gg
 * review item 8) — those are exactly the R16 continuity-gap side and
 * enrichment-status's `default_km` denominator, not damage to skip over.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { buildRailStopsIndex, type RailEndpointRow, type RailStopsIndex, type RailStopsSidecarV1 } from './rail-graph.js'

export interface RailEndpointRowWithLength extends RailEndpointRow {
  lengthM: number
}

export interface RailEndpointRowsResult {
  rows: RailEndpointRowWithLength[]
  /** One entry per hex whose railways.arrow was unreadable or missing an
   *  EXTRACT-core column this rule needs (end_lat/end_lon/usage/service, on
   *  top of the rail_type/source_id/start_lat/start_lon every railways.arrow
   *  already carries) — fail-closed: callers must treat these as damage,
   *  never a silent "no violations here" (mirrors audit-enrichment-
   *  invariants.ts's own reportIoError contract). */
  ioErrors: Array<{ hex: string; error: string }>
}

const CORE_COLUMNS = ['rail_type', 'usage', 'service', 'source_id', 'start_lat', 'start_lon', 'end_lat', 'end_lon'] as const

export function collectRailEndpointRows(h3r4Dir: string, hexes: readonly string[]): RailEndpointRowsResult {
  const rows: RailEndpointRowWithLength[] = []
  const ioErrors: Array<{ hex: string; error: string }> = []

  for (const hex of hexes) {
    let table
    try {
      table = tableFromIPC(readFileSync(resolve(h3r4Dir, hex, 'railways.arrow')))
    } catch (err) {
      ioErrors.push({ hex, error: `unreadable arrow: ${err instanceof Error ? err.message : err}` })
      continue
    }
    if (table.numRows === 0) continue

    const missing = CORE_COLUMNS.filter((c) => !table.getChild(c))
    if (missing.length > 0) {
      ioErrors.push({ hex, error: `missing extract-core column(s): ${missing.join(', ')}` })
      continue
    }
    // trains_passenger/trains_freight are chain-only (added by enrichment, not
    // the extractor) — a hex missing them was never rail-enriched at all, but
    // its rows are NOT skipped (2026-07-16 /gg review item 8): they read as
    // zero per row, exactly what the engine renders for them (class defaults)
    // and exactly the R16 continuity-gap's "gap" side / enrichment-status.ts's
    // `default_km` denominator. Silently dropping these hexes previously
    // under-counted both.
    const pax = table.getChild('trains_passenger')
    const frt = table.getChild('trains_freight')

    const rt = table.getChild('rail_type')!
    const usage = table.getChild('usage')!
    const service = table.getChild('service')!
    const src = table.getChild('source_id')!
    const sLat = table.getChild('start_lat')!
    const sLon = table.getChild('start_lon')!
    const eLat = table.getChild('end_lat')!
    const eLon = table.getChild('end_lon')!
    const osm = table.getChild('osm_id')
    const div = table.getChild('parallel_divisor') // absent = never divisor'd → default 1
    const len = table.getChild('length_m')

    for (let i = 0; i < table.numRows; i++) {
      const railType = (rt.get(i) as number) ?? 0
      const svc = (service.get(i) as number) ?? 0
      if (railType !== 0 || svc !== 0) continue // only heavy-rail, non-service rows carry a continuity jump/gap
      rows.push({
        key: `${hex}:${i}`,
        osmId: osm ? String(Number(osm.get(i))) : '',
        railType,
        usage: (usage.get(i) as number) ?? 0,
        service: svc,
        sourceId: (src.get(i) as number) ?? 0,
        pax: (pax?.get(i) as number) ?? 0,
        frt: (frt?.get(i) as number) ?? 0,
        parallelDivisor: (div?.get(i) as number) || 1,
        startLat: sLat.get(i) as number,
        startLon: sLon.get(i) as number,
        endLat: eLat.get(i) as number,
        endLon: eLon.get(i) as number,
        lengthM: (len?.get(i) as number) ?? 0,
      })
    }
  }
  return { rows, ioErrors }
}

// ── Rail-stops sidecar (R15/R16 stop exemption) ─────────────────────────────

export const RAIL_STOPS_UNAVAILABLE_WARNING =
  'stop exemption unavailable — no rail-stops sidecar; walk-based sources not yet run in this tree'

/** Loads every `data/prepared/{YEAR}/rail-stops/*.json` sidecar (written by
 *  the graph-walk matcher's `rail-walk-enrich.ts::writeStopsSidecarIfAny`,
 *  the ONE writer, as a `RailStopsSidecarV1` envelope) into one combined
 *  index. `h3r4Dir` is `data/prepared/{YEAR}/h3r4`; the sidecar directory is
 *  its sibling. Exactly one writer exists, so there is no bare-array legacy
 *  shape to tolerate — a file failing the `version === 1` gate, or an
 *  unparsable file, degrades to "fewer known stops", never a crash (the
 *  exemption narrows false positives, it is not a correctness requirement).
 *  Returns null when the sidecar directory is absent, empty, or yields zero
 *  usable stops — callers must then run R15/R16 junction-only exemption and
 *  print `RAIL_STOPS_UNAVAILABLE_WARNING`. Logs each loaded file with its
 *  scope+extractFingerprint+stop count (2026-07-16 /gg review item 12,
 *  partial fix — sidecar VISIBILITY; the driver-side stale-sidecar warning is
 *  `rail-walk-enrich.ts::warnIfStaleSidecarRemains`) so an operator can see
 *  which sidecars are actually in force for a given R15/R16 run without
 *  reading the filesystem by hand. */
export function loadRailStopsIndex(h3r4Dir: string): RailStopsIndex | null {
  const stopsDir = resolve(dirname(h3r4Dir), 'rail-stops')
  if (!existsSync(stopsDir)) return null
  const files = readdirSync(stopsDir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) return null
  const stops: Array<{ lat: number; lon: number }> = []
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(stopsDir, f), 'utf8')) as Partial<RailStopsSidecarV1>
      if (parsed.version !== 1 || !Array.isArray(parsed.stops)) continue // malformed/unversioned — skip, not fatal
      console.log(`rail-stops sidecar loaded: ${f} (scope=${parsed.scope}, extractFingerprint=${parsed.extractFingerprint}, stops=${parsed.stops.length})`)
      for (const s of parsed.stops) {
        const lat = (s as { lat?: unknown })?.lat
        const lon = (s as { lon?: unknown })?.lon
        if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
          stops.push({ lat, lon })
        }
      }
    } catch {
      /* malformed sidecar file — skip it, not fatal (see doc above) */
    }
  }
  return stops.length > 0 ? buildRailStopsIndex(stops) : null
}
