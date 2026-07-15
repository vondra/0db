/**
 * Rail graph-walk enrichment DRIVER — the I/O half of the rail-walk matcher
 * (2026-07-15 railway enrichment fix, `pro-e-sd-zaj-m-wobbly-liskov` plan
 * §Phase 1). `rail-graph.ts` + `rail-graph-metrics.ts` are the pure
 * topology/routing SSOT (no file I/O); this module owns everything they
 * deliberately don't: enumerating hexes, reading `railways.arrow`, building
 * the ONE cross-hex graph for a scope, running `writeRailTrains` per hex
 * behind the shared walk result, and the rail-stops sidecar the R15/R16
 * stop exemption reads.
 *
 * Per-component evidence (plan point 8): the silent residual and the
 * destructive retract arm are gated on `RailWalkResult.failedComponents`,
 * never on a global %-walked figure — a failed/ambiguous pair anywhere in a
 * graph component withholds both for that WHOLE component, so one bad GTFS
 * pair elsewhere in the same run can never make this driver quietly disown
 * or silence a cleanly-walked corridor. The one exception: `unlocalizedPairs`
 * (neither end of a pair snapped onto the graph) can't be attributed to any
 * component at all, so it suppresses the silent residual GLOBALLY instead —
 * see `enrichRailwaysByGraphWalk`'s doc (2026-07-16 /gg review item 4).
 *
 * `enableDestructive` gates `retract` (in full, including the country-bleed
 * sub-arm below) AND the silent residual — divisors ride with every accepted
 * `match` (walk-stamped or silent) in EVERY mode, since `RailTrains.divisor`
 * is part of the atomic counts+divisor write `writeRailTrains` itself now
 * owns (railways-arrow.ts module doc invariant 3). In stamp-only
 * (`enableDestructive=false`), NO `RailRetract` object is even constructed —
 * country-bleed healing there is deferred to `heal-rail-country-bleed.ts` or
 * the next destructive run of this same driver (2026-07-16 /gg review item
 * 3): the old design ran the bleed + the always-on service-arm auto-heal
 * regardless of `enableDestructive`, silently mutating data in a mode
 * documented as inspection-safe.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { iterateCountryHexes } from './roads-arrow.js'
import { coordKey4dp } from './spatial.js'
import {
  buildRailGraph, snapToNearestRailGraphNode,
  type RailGraph, type RailGraphSegmentInput, type RailStationPairCount, type RailWalkResult,
  type RailStopsSidecarV1,
} from './rail-graph.js'
import { walkRailStationPairs } from './rail-graph-metrics.js'
import { writeRailTrains, type RailRow, type RailTrains } from './railways-arrow.js'
import { segmentWhollyOutside } from './country-polygon.js'

export interface RailWalkEnrichOptions {
  h3r4Dir: string
  /** [minLat, minLon, maxLat, maxLon] hex prefilter; hexes enumerated via
   *  `iterateCountryHexes(h3r4Dir, bbox, 'railways.arrow')`. */
  bbox: readonly [number, number, number, number]
  pairs: RailStationPairCount[]
  sourceId: number
  /** Passed straight to `writeRailTrains` (the #31.7 national-ownership gate). */
  countryGate?: (lat: number, lon: number) => boolean
  /** Per-hex extra match arm (tram stop-join etc.) — consulted only for rows
   *  the walk did not stamp. Same shape as a `writeRailTrains` match closure. */
  extraMatch?: (row: RailRow, i: number, hexId: string) => RailTrains | null
  /** CZ option-b residual. Applied ONLY when destructive ops are enabled AND
   *  the row's graph component has zero failed/ambiguous pairs AND the walk
   *  as a whole has zero unlocalized pairs (see module doc). The divisor
   *  actually stamped rides from `walk.divisorBySegmentKey`, not from this
   *  option — a quiet double-track must render at its true (2+1)/2, never
   *  the undivided (2+1)/1. */
  silentResidual?: { sourceId: number; pax: number; frt: number }
  /** Ids this driver may disown. Retract (incl. the country-bleed sub-arm)
   *  fires ONLY when `enableDestructive` is true — see module doc; in
   *  stamp-only NO retract object is even built. Within a destructive run:
   *  ordinary rows need `retractSafe` AND a failure-free component; the
   *  country-bleed arm (row wholly outside `countryGate`) bypasses BOTH of
   *  those (but still requires `enableDestructive`) — geometry is its own
   *  evidence a national dataset never owned that row (/gg finding). */
  retract?: { sourceIds: readonly number[] }
  /** Caller's input-completeness verdict (feeds loaded non-empty etc.). */
  retractSafe: boolean
  /** Phase-3 Step A: stamp-only proof mode — when false, NO retract object is
   *  constructed at all (no country-bleed heal, no per-component reclaim
   *  check, no always-on service-arm auto-heal either) and NO silent residual
   *  fires. Walk-stamped rows still land with their FULL atomic write
   *  (pax/frt/sourceId AND divisor) in every mode — stamp-only only means
   *  "no retract, no silent", not "no divisor". */
  enableDestructive: boolean
  /** Sidecar provenance: scope slug (filename), extract fingerprint, feed list. */
  sidecar: { scope: string; extractFingerprint: string; feeds: string[] }
}

export interface RailWalkEnrichStats {
  hexes: number
  rows: number
  /** Rows the WALK itself stamped (a train count landed via `pairs` + the graph). */
  stamped: number
  /** Rows disowned this run — country-bleed arm + per-component destructive retract, combined. */
  retracted: number
  /** Rows stamped by the CZ option-b silent residual (never the walk, never `extraMatch`). */
  silentStamped: number
  skippedService: number
  skippedForeign: number
  walk: {
    failures: RailWalkResult['failures']
    failedComponentCount: number
    /** Pairs where NEITHER end snapped onto the graph — see module doc; a
     *  nonzero count suppresses the silent residual for THIS ENTIRE run. */
    unlocalizedPairs: number
    pairsWalked: number
    pairsTotal: number
  }
  /** Track-km of stampable (heavy-rail, non-traversal) rows sitting in a
   *  graph component the walk marked failed — the "how much is still stuck"
   *  figure, computed from the same segments the graph was built from. */
  perComponentFailedKm: number
  /** '' when nothing was written this run (never-cache-empty; see
   *  `writeStopsSidecarIfAny`) — a caller must not treat this as a path. */
  sidecarPath: string
}

/** `${hexId}:${rowIndex}` — the SAME key format `RailGraphSegmentInput.key`
 *  uses, so a stamp/component lookup from the graph or the walk result maps
 *  back to exactly one row across the whole scope with no separate index. */
function segmentKey(hexId: string, rowIndex: number): string {
  return `${hexId}:${rowIndex}`
}

/** Phase 1 (graph inputs): reads every hex's `railways.arrow` ONCE and keeps
 *  only what `buildRailGraph` needs. Per the plan: rows with
 *  `railType===0 && service===0` are stampable graph edges; `service===4`
 *  crossovers enter traversal-only (connect topology, never stamped); every
 *  other family/service combination never enters the graph at all — a tram
 *  can neither carry nor bridge a heavy-rail count. */
function collectGraphSegments(h3r4Dir: string, hexIds: readonly string[]): RailGraphSegmentInput[] {
  const segments: RailGraphSegmentInput[] = []
  for (const hexId of hexIds) {
    const path = resolve(h3r4Dir, hexId, 'railways.arrow')
    const table = tableFromIPC(readFileSync(path))
    const n = table.numRows
    const sLat = table.getChild('start_lat')
    const sLon = table.getChild('start_lon')
    if (!sLat || !sLon) continue // malformed hex — mirrors writeRailTrains's own guard
    const eLat = table.getChild('end_lat')
    const eLon = table.getChild('end_lon')
    const lenCol = table.getChild('length_m')
    const rtCol = table.getChild('rail_type')
    const usCol = table.getChild('usage')
    const svcCol = table.getChild('service')
    const nmCol = table.getChild('name')
    const refCol = table.getChild('ref')
    const osmIdCol = table.getChild('osm_id')

    for (let i = 0; i < n; i++) {
      const railType = (rtCol?.get(i) as number) ?? 0
      const service = (svcCol?.get(i) as number) ?? 0
      const isTraversalOnly = service === 4
      if (!isTraversalOnly && !(railType === 0 && service === 0)) continue // never in the graph

      const startLat = sLat.get(i) as number
      const startLon = sLon.get(i) as number
      const endLat = (eLat?.get(i) as number) ?? startLat
      const endLon = (eLon?.get(i) as number) ?? startLon
      const ref = (refCol?.get(i) as string | null) ?? ''
      const name = (nmCol?.get(i) as string | null) ?? ''
      segments.push({
        key: segmentKey(hexId, i),
        osmId: String(osmIdCol?.get(i) ?? ''),
        railType,
        usage: (usCol?.get(i) as number) ?? 0,
        isTraversalOnly,
        corridorToken: ref || name || '',
        startLat, startLon, endLat, endLon,
        lengthM: (lenCol?.get(i) as number) ?? 0,
      })
    }
  }
  return segments
}

/** Track-km of stampable rows (railType 0, non-traversal — the graph's own
 *  candidates for a walk stamp) whose component the walk marked failed. */
function computePerComponentFailedKm(
  graph: RailGraph,
  segments: readonly RailGraphSegmentInput[],
  failedComponents: ReadonlySet<number>,
): number {
  let m = 0
  for (const seg of segments) {
    if (seg.isTraversalOnly) continue
    const component = graph.componentOfSegmentKey.get(seg.key)
    if (component !== undefined && failedComponents.has(component)) m += seg.lengthM
  }
  return m / 1000
}

/** Deduped (4dp) GPS of every `pairs` endpoint that resolves onto the graph —
 *  the rail-stops sidecar (R15/R16 stop exemption). Snap success is checked
 *  per ENDPOINT, independent of whether that endpoint's own OD pair's walk
 *  succeeded: a real platform a rider boards at is evidence for the
 *  auditor's stop exemption whether or not the far end of one particular
 *  trip snapped too — this is exactly why `snapToNearestRailGraphNode` is
 *  public API here, not only something `walkRailStationPairs` calls
 *  internally. */
function collectSnappedStops(graph: RailGraph, pairs: readonly RailStationPairCount[]): Array<{ lat: number; lon: number }> {
  const seen = new Map<string, { lat: number; lon: number }>()
  const consider = (lat: number, lon: number): void => {
    if (snapToNearestRailGraphNode(graph, lat, lon) === -1) return
    // Dedup key via the shared 4dp station-identity helper (spatial.ts); the
    // emitted {lat, lon} still derives from a toFixed(4) parse, same rounding
    // the key itself uses, so the two never disagree.
    const lat4 = Number(lat.toFixed(4))
    const lon4 = Number(lon.toFixed(4))
    seen.set(coordKey4dp(lat4, lon4), { lat: lat4, lon: lon4 })
  }
  for (const p of pairs) {
    consider(p.fromLat, p.fromLon)
    consider(p.toLat, p.toLon)
  }
  return [...seen.values()]
}

/** `data/prepared/{year}/rail-stops/{scope}.json` sidecar path — shared by
 *  `writeStopsSidecarIfAny` and `warnIfStaleSidecarRemains` so the two can
 *  never disagree on where a scope's sidecar lives. */
function sidecarPathFor(h3r4Dir: string, scope: string): string {
  return resolve(h3r4Dir, '..', 'rail-stops', `${scope}.json`)
}

/** Sidecar visibility (2026-07-16 /gg review item 12, partial fix — full
 *  extract-identity invalidation is deferred, see TODO below): when THIS run
 *  snapped zero stop endpoints onto the graph, `writeStopsSidecarIfAny` below
 *  writes nothing — but if a sidecar file for this scope already exists from
 *  an EARLIER run, it silently remains in force for the R15/R16 stop
 *  exemption, potentially describing a graph/extract that no longer matches.
 *  Never deleted here (a sidecar is additive evidence, not a claim of "no
 *  stations exist" — the never-cache-empty rule cuts both ways), but a
 *  zero-stops run must say so loudly rather than let staleness go unnoticed.
 *
 *  TODO(2026-07-16): hard extract-identity invalidation (compare the
 *  sidecar's `extractFingerprint` against the CURRENT run's and expire a
 *  mismatch) lands with the osm-extract stations layer (planned for the next
 *  Planet re-extract) — see the `pro-e-sd-zaj-m-wobbly-liskov` plan's later
 *  phase. Until then this is a loud warning, not an automatic fix. */
function warnIfStaleSidecarRemains(h3r4Dir: string, scope: string): void {
  const path = sidecarPathFor(h3r4Dir, scope)
  if (!existsSync(path)) return
  console.error(
    `\n!!! rail-stops sidecar STALE: zero stop endpoints snapped onto the graph this run, but ` +
    `${path} still exists from an earlier run — R15/R16's stop exemption keeps using it as-is ` +
    `(not deleted; see warnIfStaleSidecarRemains's doc for why). Verify the extract/pairs this run ` +
    `actually used before trusting that exemption.`,
  )
}

/** See `warnIfStaleSidecarRemains`'s doc for why a zero-stop run intentionally
 *  never writes here (never-cache-empty). Returns '' when nothing was
 *  written. */
function writeStopsSidecarIfAny(
  h3r4Dir: string,
  sidecar: RailWalkEnrichOptions['sidecar'],
  stops: ReadonlyArray<{ lat: number; lon: number }>,
): string {
  if (stops.length === 0) return ''
  const preparedRoot = resolve(h3r4Dir, '..')
  const year = basename(preparedRoot)
  const dir = resolve(preparedRoot, 'rail-stops')
  mkdirSync(dir, { recursive: true })
  const path = sidecarPathFor(h3r4Dir, sidecar.scope)
  const payload: RailStopsSidecarV1 = {
    version: 1,
    year,
    scope: sidecar.scope,
    extractFingerprint: sidecar.extractFingerprint,
    feeds: sidecar.feeds,
    generatedAt: new Date().toISOString(),
    stops: [...stops],
  }
  writeFileSync(path, JSON.stringify(payload))
  return path
}

export async function enrichRailwaysByGraphWalk(opts: RailWalkEnrichOptions): Promise<RailWalkEnrichStats> {
  const hexIds = iterateCountryHexes(opts.h3r4Dir, opts.bbox, 'railways.arrow')
  const segments = collectGraphSegments(opts.h3r4Dir, hexIds)
  const graph = buildRailGraph(segments)
  const walk = walkRailStationPairs(graph, opts.pairs)

  // An unlocalized pair (neither end snapped) could belong to ANY component —
  // failedComponents can't have caught it, so it withholds the silent
  // residual for the WHOLE run rather than trusting a per-component gate
  // that has nothing to key on (2026-07-16 /gg review item 4).
  const silentSuppressedGlobally = walk.unlocalizedPairs > 0
  if (silentSuppressedGlobally) {
    console.error(
      `\n!!! rail-walk-enrich: ${walk.unlocalizedPairs} unlocalized pair(s) (neither end snapped onto the ` +
      `graph) — silent residual suppressed for this ENTIRE run (an unlocatable pair could belong to any ` +
      `component). Retract still applies per-component as usual.`,
    )
  }

  const wholeRowOutsideCountry = (row: RailRow): boolean =>
    opts.countryGate !== undefined &&
    segmentWhollyOutside(opts.countryGate, row.midLat, row.midLon, row.startLat, row.startLon, row.endLat, row.endLon)

  let rows = 0
  let stamped = 0
  let retracted = 0
  let silentStamped = 0
  let skippedService = 0
  let skippedForeign = 0

  for (const hexId of hexIds) {
    const path = resolve(opts.h3r4Dir, hexId, 'railways.arrow')
    // i -> which arm produced the ACCEPTED match, so onApplied (fires only after the
    // priority gate accepts) can tally `stamped` vs `silentStamped` precisely — `match`'s
    // own return value can't distinguish a rejected candidate from an applied one.
    const acceptedBranch = new Map<number, 'walk' | 'silent'>()

    const result = await writeRailTrains(
      path,
      (row, i) => {
        const key = segmentKey(hexId, i)
        const stamp = walk.stampsBySegmentKey.get(key)
        if (stamp) {
          acceptedBranch.set(i, 'walk')
          // Divisor rides with the stamp in the SAME atomic write (railways-arrow.ts
          // module doc invariant 3) — no separate writeRailParallelDivisor pass, and
          // this fires regardless of enableDestructive (stamp-only still gets the
          // walk's own divisor, never an undivided count next to a divided sibling).
          return { pax: Math.round(stamp.pax), frt: Math.round(stamp.frt), sourceId: opts.sourceId, divisor: stamp.divisor }
        }
        if (opts.silentResidual && opts.enableDestructive && opts.retractSafe && !silentSuppressedGlobally && row.railType === 0) {
          const component = graph.componentOfSegmentKey.get(key)
          if (component !== undefined && !walk.failedComponents.has(component)) {
            acceptedBranch.set(i, 'silent')
            // A quiet double-track must render at its true divided count, not the
            // engine's undivided default — divisorBySegmentKey covers every
            // sibling-bearing segment independent of whether the WALK stamped it
            // (rail-graph-metrics.ts's applyParallelSpread, /gg review item 2).
            return { ...opts.silentResidual, divisor: walk.divisorBySegmentKey.get(key) ?? 1 }
          }
        }
        return opts.extraMatch?.(row, i, hexId) ?? null
      },
      (_row, i) => {
        const branch = acceptedBranch.get(i)
        if (branch === 'walk') stamped++
        else if (branch === 'silent') silentStamped++
      },
      // enableDestructive gates the ENTIRE retract object, not just individual
      // arms within it — in stamp-only, no RailRetract is built at all, so
      // neither the country-bleed heal nor the always-on service-arm
      // auto-heal (both live inside writeRailTrains itself) can mutate
      // anything: stamp-only is inspection-safe in full, not just "mostly"
      // (2026-07-16 /gg review item 3).
      opts.retract && opts.enableDestructive
        ? {
            sourceId: opts.retract.sourceIds,
            when: (row, i) => {
              // Country-bleed arm: bypasses retractSafe/component health (geometry
              // is its own evidence a national dataset never owned this row — /gg
              // finding) but NOT enableDestructive, since the object above is only
              // ever constructed when that's already true. Sibling implementation
              // of the SAME policy over `segmentWhollyOutside`:
              // heal-rail-country-bleed.ts's `wouldRetract` — a future policy
              // change here must update both.
              if (wholeRowOutsideCountry(row)) return true
              if (!opts.retractSafe) return false
              const key = segmentKey(hexId, i)
              if (walk.stampsBySegmentKey.has(key)) return false // the walk still claims this row this pass
              // componentFailureFree: a row with NO graph component (a tram, or any
              // family the graph never admitted) carries no failure evidence either —
              // `failedComponents.has(undefined)` is trivially false, so such a row is
              // disownable on ordinary priority-gate terms, same as a road/rail
              // predecessor-id migration would expect. A graph row's OWN component
              // must simply not be flagged failed.
              const component = graph.componentOfSegmentKey.get(key)
              return component === undefined || !walk.failedComponents.has(component)
            },
          }
        : undefined,
      opts.countryGate,
    )

    rows += result.rows
    retracted += result.retracted
    skippedService += result.skippedService
    skippedForeign += result.skippedForeign
  }

  const perComponentFailedKm = computePerComponentFailedKm(graph, segments, walk.failedComponents)
  const stops = collectSnappedStops(graph, opts.pairs)
  if (stops.length === 0) warnIfStaleSidecarRemains(opts.h3r4Dir, opts.sidecar.scope)
  const sidecarPath = writeStopsSidecarIfAny(opts.h3r4Dir, opts.sidecar, stops)

  const stats: RailWalkEnrichStats = {
    hexes: hexIds.length,
    rows,
    stamped,
    retracted,
    silentStamped,
    skippedService,
    skippedForeign,
    walk: {
      failures: walk.failures,
      failedComponentCount: walk.failedComponents.size,
      unlocalizedPairs: walk.unlocalizedPairs,
      pairsWalked: walk.pairsWalked,
      pairsTotal: walk.pairsTotal,
    },
    perComponentFailedKm,
    sidecarPath,
  }

  console.log(
    `rail-walk-enrich: ${stats.hexes} hexes, ${stats.rows} rows, ${stats.stamped} stamped ` +
    `(${stats.silentStamped} silent, ${stats.retracted} retracted) — pairs ${stats.walk.pairsWalked}/${stats.walk.pairsTotal} walked; ` +
    `failures snap=${stats.walk.failures.snapFailed} disconnected=${stats.walk.failures.disconnected} ` +
    `detour=${stats.walk.failures.detourRejected} ambiguous=${stats.walk.failures.ambiguous}; ` +
    `${stats.walk.failedComponentCount} failed component(s), ${stats.walk.unlocalizedPairs} unlocalized, ` +
    `${stats.perComponentFailedKm.toFixed(1)} km stuck`,
  )

  return stats
}
