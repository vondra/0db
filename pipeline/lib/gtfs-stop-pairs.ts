/**
 * GTFS station-pair frequency parser — turns `stop_times.txt` into consecutive-stop
 * pairs per active rail trip, canonicalized (order-independent key) and summed across
 * trips AND directions, so the graph-walk matcher (`pipeline/lib/rail-graph.ts`, being
 * built in parallel per plan pro-e-sd-zaj-m-wobbly-liskov) has station-pair frequencies
 * to stamp along shortest paths instead of the current per-stop 500 m radius join.
 *
 * Built on the two generic helpers extracted from `gtfs-enrich-core.ts`:
 * `computeActiveTripFamiliesForFeed` (routes + calendar + trips -> trip_id family map,
 * with the 2026-07-15 calendar-zero-active fix) and `loadStopsWithCoords` /
 * `resolveStopViaParent` (stops + parent-station fallback). Not yet wired into any
 * `enrich-railway-*.ts` enricher — that wiring is a later phase of the plan.
 */

import { existsSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { coordKey4dp } from './spatial.js'
import {
  RAIL_TYPES, parseCsvLine, parseCsvStream, parseTime,
  computeActiveTripFamiliesForFeed, loadStopsWithCoords, resolveStopViaParent,
  writeMergedStopCache, readMergedStopCache,
  type GtfsStop,
} from './gtfs-enrich-core.js'
// RailStationPairCount's home is rail-graph.ts (the topology SSOT), imported
// for local use and re-exported: gtfs-stop-pairs.test.ts still imports it
// from this file.
import type { RailStationPairCount } from './rail-graph.js'
export type { RailStationPairCount }

export interface StopPairFrequenciesOptions {
  /** Bounding box for stops.txt out-of-bounds pruning (1° margin), same convention as
   *  `loadStopsWithCoords`/`computeStopFrequenciesForFeed`. Omit to keep every stop. */
  bbox?: readonly [number, number, number, number]
  /** Route-type -> family classifier. Defaults to RAIL_TYPES-only (tram/metro excluded).
   *  Pass a metroAsRail-style override (e.g. europe's `railFamilyFor` narrowed to 'rail')
   *  to widen it per feed — the hook IS the override mechanism, no built-in flag needed. */
  familyOf?: (routeType: number) => 'rail' | null
  /** Calendar service-day picker, shared with `computeActiveTripFamiliesForFeed`.
   *  Defaults to the midpoint-Wednesday policy; pass europe's busiest-Wednesday sampler
   *  to match its per-stop counter's target date. */
  dateSelection?: (calendarRows: Record<string, string>[]) => string
  /** Expand frequencies.txt headway blocks into a per-trip repeat count (TH-multiplier
   *  style, `enrich-railway-th.ts`). Defaults to true iff frequencies.txt exists in
   *  extractDir; pass false to force-ignore it even when present. */
  expandFrequencies?: boolean
  /** Max vertices kept per attached shape polyline (evenly downsampled, endpoints kept). */
  maxShapePoints?: number
  /** Cache-relevant options fingerprint (2026-07-16 /gg review item 11b):
   *  `familyOf`/`dateSelection` are functions and can't be hashed reliably, so
   *  the CALLER supplies a stable string identifying its options combination
   *  instead (e.g. `'europe-busiest-wed'`) — every caller whose
   *  familyOf/dateSelection/expandFrequencies/maxShapePoints shape differs
   *  from another caller's MUST pass a distinct key, or a cache written under
   *  one combination could be silently served to a caller expecting another.
   *  Defaults to `'default'` — fine as long as only ONE options shape ever
   *  hits a given extractDir. A mismatch on cache read recomputes and
   *  overwrites, never silently serves the stale parse. */
  optionsKey?: string
}

export interface StopPairFrequenciesProvenance {
  /** Resolved service day (YYYYMMDD), '' when unresolved (no rail trips at all). */
  targetDate: string
  calendarPresent: boolean
  /** Active rail trips selected for `targetDate` — before stop_times is even read. */
  activeTripCount: number
  /** Distinct trips actually found in stop_times.txt (can be < activeTripCount for a
   *  malformed feed with trips that have no stop pattern). */
  tripsWithStopTimes: number
  stopTimesLines: number
  /** Consecutive-pair occurrences emitted across all trips, before canonical merge. */
  pairEventsBeforeDedup: number
  /** Final canonical station-pair count (after direction + cross-trip summing). */
  pairsAfterDedup: number
  droppedUnresolvedStops: number
  collapsedAdjacentDuplicates: number
  frequenciesExpanded: boolean
  tripsWithShape: number
  /** True when this result was served from `gtfs-rail-pairs-v1.json` — in that case
   *  every OTHER count above is 0/false (not recomputed; the cache stores pairs only,
   *  see the caching note on `computeStopPairFrequenciesForFeed`). */
  fromCache: boolean
}

export interface StopPairFrequenciesResult {
  pairs: RailStationPairCount[]
  provenance: StopPairFrequenciesProvenance
}

const DEFAULT_MAX_SHAPE_POINTS = 500
const CACHE_FILENAME = 'gtfs-rail-pairs-v1.json'

function defaultFamilyOf(routeType: number): 'rail' | null {
  return RAIL_TYPES.has(routeType) ? 'rail' : null
}

function emptyProvenance(overrides: Partial<StopPairFrequenciesProvenance> = {}): StopPairFrequenciesProvenance {
  return {
    targetDate: '',
    calendarPresent: false,
    activeTripCount: 0,
    tripsWithStopTimes: 0,
    stopTimesLines: 0,
    pairEventsBeforeDedup: 0,
    pairsAfterDedup: 0,
    droppedUnresolvedStops: 0,
    collapsedAdjacentDuplicates: 0,
    frequenciesExpanded: false,
    tripsWithShape: 0,
    fromCache: false,
    ...overrides,
  }
}

/** Station identity for pairing/collapsing: the shared 4dp key (spatial.ts)
 *  so two stop_ids at the same physical location (duplicate platform
 *  records, or a child resolved to its parent) count as ONE node — matches
 *  the canonical pair key's precision. */
function stationKey(stop: GtfsStop): string {
  return coordKey4dp(stop.lat, stop.lon)
}

/** Evenly-spaced downsample keeping the first and last point exactly. */
function downsamplePolyline(points: Array<[number, number]>, maxPoints: number): Array<[number, number]> {
  if (points.length <= maxPoints || maxPoints < 2) return points
  const step = (points.length - 1) / (maxPoints - 1)
  const out: Array<[number, number]> = []
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)])
  return out
}

type PairAccumulator = RailStationPairCount

/**
 * GTFS `stop_times.txt` -> consecutive station pairs for every active rail trip,
 * summed across trips and BOTH directions into one canonical pair per station couple.
 *
 * Mechanics (per plan pro-e-sd-zaj-m-wobbly-liskov, Phase 1 gtfs-stop-pairs paragraph):
 *  1. Determine active rail trips via `computeActiveTripFamiliesForFeed` (shares the
 *     calendar-fix + family-hook + dateSelection-hook with the per-stop counter).
 *  2. Stream stop_times.txt, keeping (stop_sequence, stop_id) per active trip only.
 *  3. Per trip: sort by NUMERIC stop_sequence (file order is not trustworthy), resolve
 *     each stop's coords WITH parent-station fallback BEFORE dropping coordless stops,
 *     drop truly unresolvable stops (pairs bridge the gap), collapse adjacent
 *     duplicates (same resolved station).
 *  4. Emit consecutive pairs; frequencies.txt (when present) expands a trip's pair
 *     contribution by its headway-derived daily repeat count, mirroring the TH
 *     multiplier approach.
 *  5. Canonicalize each pair by its sorted 4dp coordinate key so A->B and B->A (and
 *     every other trip through the same section) accumulate into ONE summed entry.
 *  6. Attach the trip's (downsampled) shape polyline to every pair it contributes to,
 *     when trips.txt has shape_id and shapes.txt exists (first trip wins; a SECOND,
 *     DIFFERENT shapeId reaching an already-shaped pair DROPS the polyline entirely —
 *     see `addPair`'s doc, 2026-07-16 /gg review item 11a).
 *
 * Caching: `gtfs-rail-pairs-v1.json` lives INSIDE `extractDir` — the same per-extractDir
 * keying the existing per-feed caches use (`family-frequencies.json` in
 * enrich-railway-europe.ts, `gtfs-family-frequencies.json` in dk/th/...), so nested
 * PTV-style subfeeds (each with their own extractDir) never collide. Reuses the shared
 * v2 cache envelope helpers (`writeMergedStopCache`/`readMergedStopCache`) purely for
 * their versioned on-disk shape — `feedsLoadedNonEmpty` carries no multi-feed
 * completeness signal here (this cache always describes ONE extractDir's own single
 * parse, never a merge), so its first slot is a fixed version marker and its second
 * slot carries `opts.optionsKey` (2026-07-16 /gg review item 11b): a cache hit only
 * counts when the stored key matches the CURRENT call's — a caller whose
 * familyOf/dateSelection/expandFrequencies/maxShapePoints shape differs from an
 * earlier writer's recomputes and overwrites instead of silently serving a parse that
 * would have come out differently. Never persists an empty parse (mirrors
 * gtfs-enrich-core.ts's merged-stop-cache rule): a poisoned/empty cache would silently
 * starve every later cache-served call.
 */
const CACHE_VERSION_MARKER = 'pairs-v1'

export async function computeStopPairFrequenciesForFeed(
  extractDir: string,
  opts: StopPairFrequenciesOptions = {},
): Promise<StopPairFrequenciesResult> {
  const optionsFingerprint = opts.optionsKey ?? 'default'
  const cachePath = resolve(extractDir, CACHE_FILENAME)
  if (existsSync(cachePath)) {
    const cached = readMergedStopCache<RailStationPairCount>(cachePath)
    if (cached.feedsLoadedNonEmpty?.[1] === optionsFingerprint) {
      return { pairs: cached.stops, provenance: emptyProvenance({ pairsAfterDedup: cached.stops.length, fromCache: true }) }
    }
    // Options changed since this cache was written (or it predates optionsKey
    // entirely) — fall through and recompute; the write below overwrites it
    // with the CURRENT fingerprint rather than serving a mismatched parse.
  }

  const familyOf = opts.familyOf ?? defaultFamilyOf
  const maxShapePoints = opts.maxShapePoints ?? DEFAULT_MAX_SHAPE_POINTS

  const { tripFam, targetDate, calendarPresent } =
    await computeActiveTripFamiliesForFeed(extractDir, familyOf, opts.dateSelection)

  if (tripFam.size === 0) {
    return { pairs: [], provenance: emptyProvenance({ targetDate, calendarPresent }) }
  }

  // ── trips.txt (2nd pass): shape_id per active trip ──
  const tripShapeId = new Map<string, string>()
  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  for (const r of tripsRaw) {
    if (!tripFam.has(r['trip_id'])) continue
    const shapeId = (r['shape_id'] || '').trim()
    if (shapeId) tripShapeId.set(r['trip_id'], shapeId)
  }

  // ── shapes.txt (only if any active trip references one) ──
  const shapesById = new Map<string, Array<[number, number]>>()
  const shapesPath = resolve(extractDir, 'shapes.txt')
  if (tripShapeId.size > 0 && existsSync(shapesPath)) {
    const shapesRaw = await parseCsvStream(shapesPath)
    const bySeq = new Map<string, Array<{ seq: number; lat: number; lon: number }>>()
    for (const r of shapesRaw) {
      const id = r['shape_id']
      if (!id) continue
      const lat = parseFloat(r['shape_pt_lat'] || '')
      const lon = parseFloat(r['shape_pt_lon'] || '')
      if (isNaN(lat) || isNaN(lon)) continue
      const seq = parseInt(r['shape_pt_sequence'] || '0', 10)
      let arr = bySeq.get(id)
      if (!arr) { arr = []; bySeq.set(id, arr) }
      arr.push({ seq: Number.isFinite(seq) ? seq : arr.length, lat, lon })
    }
    for (const [id, pts] of bySeq) {
      pts.sort((a, b) => a.seq - b.seq)
      shapesById.set(id, downsamplePolyline(pts.map(p => [p.lat, p.lon] as [number, number]), maxShapePoints))
    }
  }

  // ── frequencies.txt expansion (opt-in by default when the file exists) ──
  const freqPath = resolve(extractDir, 'frequencies.txt')
  const frequenciesExpanded = opts.expandFrequencies ?? existsSync(freqPath)
  const tripBoosts = new Map<string, number>()
  if (frequenciesExpanded && existsSync(freqPath)) {
    const freqs = await parseCsvStream(freqPath)
    for (const f of freqs) {
      const tripId = f['trip_id']
      if (!tripFam.has(tripId)) continue
      const startSec = parseTime(f['start_time'] || '')
      const endSec = parseTime(f['end_time'] || '')
      const headway = parseInt(f['headway_secs'] || '0', 10)
      if (startSec < 0 || endSec < 0 || headway <= 0) continue
      const count = Math.max(1, Math.floor(Math.max(0, endSec - startSec) / headway))
      tripBoosts.set(tripId, (tripBoosts.get(tripId) || 0) + count)
    }
  }
  const boostFor = (tripId: string): number => tripBoosts.get(tripId) ?? 1

  // ── stop_times.txt (streamed), grouped per active trip ──
  const perTripRows = new Map<string, Array<{ seq: number; stopId: string }>>()
  let stopTimesLines = 0
  const stStream = createReadStream(resolve(extractDir, 'stop_times.txt'), { encoding: 'utf-8' })
  const stRl = createInterface({ input: stStream, crlfDelay: Infinity })
  let stHeaders: string[] | null = null
  let tripIdIdx = -1, stopIdIdx = -1, seqIdx = -1
  for await (const rawLine of stRl) {
    const line = stHeaders === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue
    if (!stHeaders) {
      stHeaders = parseCsvLine(line)
      tripIdIdx = stHeaders.indexOf('trip_id')
      stopIdIdx = stHeaders.indexOf('stop_id')
      seqIdx = stHeaders.indexOf('stop_sequence')
      if (tripIdIdx < 0 || stopIdIdx < 0 || seqIdx < 0) {
        throw new Error(`stop_times.txt missing trip_id/stop_id/stop_sequence`)
      }
      continue
    }
    stopTimesLines++
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    if (!tripFam.has(tripId)) continue
    let arr = perTripRows.get(tripId)
    if (!arr) { arr = []; perTripRows.set(tripId, arr) }
    const seq = parseInt(fields[seqIdx] || '', 10)
    arr.push({ seq: Number.isFinite(seq) ? seq : arr.length, stopId: fields[stopIdIdx] })
  }

  const stops = await loadStopsWithCoords(extractDir, opts.bbox)

  // ── Per trip: sort, resolve+bridge, collapse adjacent dups, emit + accumulate pairs ──
  const pairMap = new Map<string, PairAccumulator>()
  let droppedUnresolvedStops = 0
  let collapsedAdjacentDuplicates = 0
  let pairEventsBeforeDedup = 0
  let tripsWithShape = 0

  // Sentinel shapeId a real GTFS shape_id can never collide with (GTFS ids are
  // caller-defined strings, but never contain NUL) — once a pair is marked
  // CONFLICTED, every later trip through it (any shapeId, including a third
  // DIFFERENT one) re-triggers the same "different from stored" branch below
  // and stays dropped; the sentinel just needs to never equal a real shapeId.
  const SHAPE_CONFLICT_MARKER = ' conflict'
  const shapeIdByPairKey = new Map<string, string>()

  const addPair = (a: GtfsStop, b: GtfsStop, boost: number, shape: Array<[number, number]> | undefined, shapeId: string | undefined) => {
    const ka = stationKey(a), kb = stationKey(b)
    if (ka === kb) return // defensive: a non-adjacent revisit landing on the exact same 4dp cell
    const swap = ka > kb
    const key = swap ? `${kb}|${ka}` : `${ka}|${kb}`
    const [from, to] = swap ? [b, a] : [a, b]
    let acc = pairMap.get(key)
    if (!acc) {
      acc = { fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon, pax: 0, frt: 0 }
      pairMap.set(key, acc)
    }
    acc.pax += boost
    if (shape && shapeId) {
      const existingShapeId = shapeIdByPairKey.get(key)
      if (existingShapeId === undefined) {
        // First trip to reach this canonical pair wins the shape attachment —
        // deterministic (insertion order = first appearance in stop_times.txt),
        // not merged/averaged.
        acc.shapePolyline = shape
        shapeIdByPairKey.set(key, shapeId)
      } else if (existingShapeId !== shapeId) {
        // A SECOND, DIFFERENT shapeId reaches the SAME canonical pair — two
        // distinct corridors share this station couple (e.g. a junction where
        // both branches happen to connect the same two stations). Attaching
        // either shape would wrongly narrow the graph-walk's search to ONE of
        // the two real corridors, so drop the polyline entirely and let the
        // ambiguity probe run unconstrained (2026-07-16 /gg review item 11a)
        // — "no shape" is exactly the case that probe exists for.
        acc.shapePolyline = undefined
        shapeIdByPairKey.set(key, SHAPE_CONFLICT_MARKER)
      }
    }
    pairEventsBeforeDedup++
  }

  for (const [tripId, rows] of perTripRows) {
    rows.sort((a, b) => a.seq - b.seq) // numeric stop_sequence sort — file order is not trustworthy
    const boost = boostFor(tripId)
    const shapeId = tripShapeId.get(tripId)
    const shape = shapeId ? shapesById.get(shapeId) : undefined
    if (shape) tripsWithShape++

    // Resolve WITH parent-station fallback BEFORE dropping coordless stops.
    const resolved: GtfsStop[] = []
    for (const { stopId } of rows) {
      const { stop } = resolveStopViaParent(stops, stopId)
      if (!stop) { droppedUnresolvedStops++; continue }
      resolved.push(stop)
    }

    // Collapse adjacent duplicates (same resolved station) — dropped/bridged stops
    // above already let pairs span the gap; this handles e.g. two child platforms of
    // one parent visited back-to-back.
    const sequence: GtfsStop[] = []
    for (const stop of resolved) {
      const prev = sequence[sequence.length - 1]
      if (prev && stationKey(prev) === stationKey(stop)) { collapsedAdjacentDuplicates++; continue }
      sequence.push(stop)
    }

    for (let i = 0; i < sequence.length - 1; i++) addPair(sequence[i], sequence[i + 1], boost, shape, shapeId)
  }

  const pairs = [...pairMap.values()]
  const provenance = emptyProvenance({
    targetDate,
    calendarPresent,
    activeTripCount: tripFam.size,
    tripsWithStopTimes: perTripRows.size,
    stopTimesLines,
    pairEventsBeforeDedup,
    pairsAfterDedup: pairs.length,
    droppedUnresolvedStops,
    collapsedAdjacentDuplicates,
    frequenciesExpanded,
    tripsWithShape,
  })

  // Never persist an empty parse — mirrors gtfs-enrich-core.ts's writeMergedStopCache
  // callers: a poisoned/empty cache would silently starve every later cache-served run.
  // Second slot carries the CURRENT optionsFingerprint (see the module doc) so a later
  // call under a different options shape recomputes instead of reading this one.
  if (pairs.length > 0) {
    writeMergedStopCache(cachePath, [CACHE_VERSION_MARKER, optionsFingerprint], pairs)
  }

  return { pairs, provenance }
}
