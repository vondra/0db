/**
 * Shared GTFS parsing core for the `enrich-railway-*.ts` country enrichers.
 *
 * One source of truth for the generic, country-agnostic GTFS helpers that were
 * previously copy-pasted byte-for-byte across the per-country railway enrichers:
 * CSV parsing, GTFS date math, the calendar-midpoint Wednesday service-day picker,
 * the route_type → family classification sets, and the two shared row shapes.
 *
 * Per-country code (feed URLs, bbox + exclusion zones, match/closure logic) stays in
 * each `enrich-railway-<cc>.ts` file — only the truly identical generics live here.
 * No-match rows return null (source_id stays 0): the ENGINE default table
 * (engine/noise-compute/src/emission/railway.rs::default_traffic) is the single
 * "we don't know" authority — per-country class-default stamping was purged 2026-07-10.
 *
 * `computeStopFrequenciesForFeed` is a thin composition over two lower-level helpers
 * also used by the station-pair parser (`gtfs-stop-pairs.ts`): `computeActiveTripFamiliesForFeed`
 * (routes + calendar + trips -> trip_id family map) and `loadStopsWithCoords` (stops +
 * parent-station index). Behavior is preserved from the pre-2026-07-15 byte-identical
 * copies EXCEPT one intentional fix: a calendar present but resolving to zero active
 * services on the target date now yields zero trips instead of silently counting every
 * trip — see the BUG FIX comment on `computeActiveTripFamiliesForFeed` below.
 */

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { latLngToCell } from 'h3-js'
import { pointToSegmentDist } from './spatial.js'

// ── GTFS route_type families ──

// GTFS route_type: 2=Rail, 100-109=Railway subtypes, 0=Tram, 900-906=Tram subtypes,
// 1=Subway/Metro, 400-405=Urban Railway/Monorail subtypes
export const RAIL_TYPES = new Set([2, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
export const TRAM_TYPES = new Set([0, 900, 901, 902, 903, 904, 905, 906])
export const METRO_TYPES = new Set([1, 400, 401, 402, 403, 404, 405])

// GTFS route family → OSM rail_type family (rail_type 0=rail, 1=tram, 2=light_rail).
// Metro/light-metro is grouped with tram: OSM tags light-metro as light_rail (rail_type 2)
// while GTFS tags it route_type 1 (Porto etc.), and true underground subways have no OSM
// segment so never match. Conscious Occam trade-off — a subway STOP within 500 m of a
// surface tram/light_rail segment can match it; accepted over a 3-family scheme that would
// miss GTFS-tram-tagged light rails. Bus/ferry/etc. → null (skipped).
export function routeFamily(routeType: number): 'rail' | 'tram' | null {
  if (RAIL_TYPES.has(routeType)) return 'rail'
  if (TRAM_TYPES.has(routeType) || METRO_TYPES.has(routeType)) return 'tram'
  return null
}

// ── Types ──

export interface GtfsStop {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
}

export interface StopTrainCount {
  stop_id: string
  lat: number
  lon: number
  name: string
  h3r4: string
  family: 'rail' | 'tram'
  trains_passenger: number
  trains_freight: number
}

// ── Stop↔segment proximity join ──

/** Nearest GTFS stop within `radiusM` of a railway row's segment, looked up in the
 *  0.01°-cell stop grid every per-hex enricher builds. The longitude cell span is
 *  latitude-aware: 0.01° lon shrinks below 500 m past ~63°N (Scandinavian feeds),
 *  where a fixed 3×3 window silently under-searched (/gg Codex W4 — codified from
 *  the old inline joins, now fixed once here). Latitude cells are ~1.11 km, so ±1
 *  always covers a 500 m radius. Known, accepted limit: the search anchors on the
 *  row MIDPOINT — a stop near the far END of a very long segment can sit outside
 *  the window (preserved pre-purge behavior; segments are 6-120 m, negligible).
 *  ONE source of truth for this join: the per-country `match` closures AND the
 *  OLD_FALLBACK retract corroborations must use the same join, otherwise a row
 *  could be disowned that `match` would still claim (or vice versa). */
export function nearestGridStop<S extends { lat: number; lon: number }>(
  grid: ReadonlyMap<string, S[]>,
  row: { startLat: number; startLon: number; endLat: number; endLon: number; midLat: number; midLon: number },
  radiusM = 500,
): S | null {
  let bestDist = radiusM
  let best: S | null = null
  const gy = Math.floor(row.midLat * 100), gx = Math.floor(row.midLon * 100)
  // Cells needed so dx spans radiusM of longitude at this latitude.
  const lonCellM = 1111.949 * Math.max(0.05, Math.cos((row.midLat * Math.PI) / 180))
  const dxMax = Math.max(1, Math.ceil(radiusM / lonCellM))
  for (let dy = -1; dy <= 1; dy++) for (let dx = -dxMax; dx <= dxMax; dx++) {
    const cell = grid.get(`${gy + dy}_${gx + dx}`)
    if (!cell) continue
    for (const sc of cell) {
      const d = pointToSegmentDist(sc.lat, sc.lon, row.startLat, row.startLon, row.endLat, row.endLon)
      if (d < bestDist) { bestDist = d; best = sc }
    }
  }
  return best
}

// ── CSV parsing ──

/** Parse a single CSV line, handling quoted fields with commas. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current.trim())
  return fields
}

/** Stream-parse a large CSV file line by line. */
export async function parseCsvStream(filePath: string): Promise<Record<string, string>[]> {
  const results: Record<string, string>[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let headers: string[] | null = null
  for await (const rawLine of rl) {
    const line = headers === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue

    if (!headers) {
      headers = parseCsvLine(line)
      continue
    }
    const values = parseCsvLine(line)
    const row: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] || ''
    }
    results.push(row)
  }
  return results
}

// ── Date helpers ──

export function parseGtfsDate(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.substring(0, 4))
  const m = parseInt(yyyymmdd.substring(4, 6)) - 1
  const d = parseInt(yyyymmdd.substring(6, 8))
  return new Date(y, m, d).getTime()
}

export function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-${yyyymmdd.substring(6, 8)}`
}

/** GTFS `HH:MM:SS` (hour may exceed 23 for past-midnight trips) -> seconds since
 *  midnight, or -1 if unparseable. Shared by `gtfs-stop-pairs.ts` and
 *  `enrich-railway-th.ts`'s `frequencies.txt` headway expansion. */
export function parseTime(s: string): number {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s.trim())
  if (!m) return -1
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
}

/**
 * Pick a representative Wednesday via the calendar-midpoint heuristic: take the
 * midpoint of the overall calendar validity span (earliest start_date .. latest
 * end_date across all rows) and snap forward to the nearest Wednesday. Falls back
 * to the next upcoming Wednesday when no calendar dates are present.
 *
 * Note: this is the cheap midpoint variant. The busiest-Wednesday *sampling*
 * variant (which counts service per candidate Wednesday and keeps the densest)
 * lives locally in `enrich-railway-europe.ts`, not here.
 */
export function findTargetWednesday(calendarRows: Record<string, string>[]): string {
  let minDate = '99999999'
  let maxDate = '00000000'
  for (const row of calendarRows) {
    const start = row['start_date'] || ''
    const end = row['end_date'] || ''
    if (start && start < minDate) minDate = start
    if (end && end > maxDate) maxDate = end
  }

  if (minDate === '99999999') {
    const now = new Date()
    now.setDate(now.getDate() + 7)
    while (now.getDay() !== 3) now.setDate(now.getDate() + 1)
    return now.toISOString().substring(0, 10).replace(/-/g, '')
  }

  const startMs = parseGtfsDate(minDate)
  const endMs = parseGtfsDate(maxDate)
  const midMs = startMs + (endMs - startMs) / 2
  const mid = new Date(midMs)
  const day = mid.getDay()
  const offset = (3 - day + 7) % 7
  mid.setDate(mid.getDate() + offset)
  return mid.toISOString().substring(0, 10).replace(/-/g, '')
}

// ── Active trip families (routes.txt + calendar + trips.txt) ──

export interface ActiveTripFamiliesResult<F extends string> {
  /** trip_id -> its GTFS-route family, already filtered to trips active on `targetDate`. */
  tripFam: Map<string, F>
  /** Resolved service day (YYYYMMDD), or '' when no rail/tram routes or no calendar data exist. */
  targetDate: string
  /** True when calendar.txt OR calendar_dates.txt exists — i.e. there is a basis to
   *  determine which service ids ran on `targetDate`, even if that set turns out empty.
   *  Distinguishing this from `activeServiceIds.size > 0` is the 2026-07-15 fix below. */
  calendarPresent: boolean
  /** The resolved active service_id set for `targetDate`. Can be legitimately empty
   *  when `calendarPresent` is true (a broken/expired feed serves zero trips that day). */
  activeServiceIds: Set<string>
}

/**
 * routes.txt + calendar(_dates).txt + trips.txt → the trip_id -> family map every GTFS
 * rail matcher needs, shared between the per-stop frequency counter below
 * (`computeStopFrequenciesForFeed`) and the station-pair parser (`gtfs-stop-pairs.ts`).
 * `familyOf` lets callers plug in their own route_type -> family classification (europe's
 * per-feed allow-list + metroAsRail override, the pair parser's rail-only filter);
 * `dateSelection` lets callers plug in their own service-day picker (europe's
 * busiest-Wednesday sampler) in place of the default midpoint-Wednesday heuristic
 * (`findTargetWednesday`).
 */
export async function computeActiveTripFamiliesForFeed<F extends string>(
  extractDir: string,
  familyOf: (routeType: number) => F | null,
  dateSelection?: (calendarRows: Record<string, string>[]) => string,
): Promise<ActiveTripFamiliesResult<F>> {
  const routesRaw = await parseCsvStream(resolve(extractDir, 'routes.txt'))
  const routeFam = new Map<string, F>()
  for (const r of routesRaw) {
    const fam = familyOf(parseInt(r['route_type'] || '3'))
    if (fam) routeFam.set(r['route_id'], fam)
  }
  if (routeFam.size === 0) {
    return { tripFam: new Map(), targetDate: '', calendarPresent: false, activeServiceIds: new Set() }
  }

  const calendarPath = resolve(extractDir, 'calendar.txt')
  const calendarDatesPath = resolve(extractDir, 'calendar_dates.txt')
  const activeServiceIds = new Set<string>()
  let targetDate = ''
  const calendarPresent = existsSync(calendarPath) || existsSync(calendarDatesPath)

  if (existsSync(calendarPath)) {
    const calendarRaw = await parseCsvStream(calendarPath)
    targetDate = (dateSelection ?? findTargetWednesday)(calendarRaw)
    for (const r of calendarRaw) {
      const start = r['start_date'] || ''
      const end = r['end_date'] || ''
      if (r['wednesday'] === '1' && targetDate >= start && targetDate <= end) activeServiceIds.add(r['service_id'])
    }
    if (existsSync(calendarDatesPath)) {
      const calDates = await parseCsvStream(calendarDatesPath)
      for (const r of calDates) {
        if (r['date'] !== targetDate) continue
        if (r['exception_type'] === '1') activeServiceIds.add(r['service_id'])
        if (r['exception_type'] === '2') activeServiceIds.delete(r['service_id'])
      }
    }
  } else if (existsSync(calendarDatesPath)) {
    const calDates = await parseCsvStream(calendarDatesPath)
    const dateCounts = new Map<string, number>()
    for (const r of calDates) {
      if (r['exception_type'] === '1') dateCounts.set(r['date'] || '', (dateCounts.get(r['date'] || '') || 0) + 1)
    }
    const wednesdays = [...dateCounts.entries()]
      .filter(([d]) => new Date(parseGtfsDate(d)).getDay() === 3)
      .sort((a, b) => b[1] - a[1])
    if (wednesdays.length > 0) {
      targetDate = wednesdays[0][0]
      for (const r of calDates) {
        if (r['date'] === targetDate && r['exception_type'] === '1') activeServiceIds.add(r['service_id'])
      }
    } else {
      const best = [...dateCounts.entries()].sort((a, b) => b[1] - a[1])
      if (best.length > 0) {
        targetDate = best[0][0]
        for (const r of calDates) {
          if (r['date'] === targetDate && r['exception_type'] === '1') activeServiceIds.add(r['service_id'])
        }
      }
    }
  }
  // else: no calendar files at all — calendarPresent is false, every rail/tram trip below counts.

  const tripsRaw = await parseCsvStream(resolve(extractDir, 'trips.txt'))
  const tripFam = new Map<string, F>()
  for (const r of tripsRaw) {
    const fam = routeFam.get(r['route_id'])
    if (!fam) continue
    // BUG FIX (2026-07-15): this used to gate on `activeServiceIds.size > 0`, so a
    // calendar.txt (or calendar_dates.txt) present but resolving to ZERO active services
    // on the target date — an expired or malformed feed, not a rare case — silently
    // counted EVERY trip as running instead of none. Correct semantics: calendar data
    // present means the (possibly empty) active set is authoritative; only when there is
    // NO calendar data at all do we fall back to "count everything". Changes counts for
    // broken feeds only — intended, see /gg review item 2 (plan pro-e-sd-zaj-m-wobbly-liskov).
    if (calendarPresent && !activeServiceIds.has(r['service_id'])) continue
    tripFam.set(r['trip_id'], fam)
  }

  return { tripFam, targetDate, calendarPresent, activeServiceIds }
}

// ── Retract safety (CRITICAL-1b) ──
// A retract may only run over a PROVABLY COMPLETE input snapshot: when a feed
// silently fails to load (every downloadAllGtfs tolerates per-feed failure so
// enrichment can still stamp from the rest), the retract's join corroboration
// reads "no coverage" over that feed's region — an input artifact, not evidence —
// and would disown REAL stamps. These helpers carry the completeness evidence.

/** '' when every configured feed is in the loaded-non-empty list; otherwise the
 *  detail for the mandated "retract skipped — incomplete inputs (…)" log line. */
export function describeIncompleteFeeds(
  configuredFeedIds: readonly string[],
  loadedNonEmptyFeedIds: readonly string[],
): string {
  const loaded = new Set(loadedNonEmptyFeedIds)
  const missing = configuredFeedIds.filter(id => !loaded.has(id))
  return missing.length === 0 ? '' : `feeds missing or parsed empty: ${missing.join(',')}`
}

/** The ONE loud line every enricher prints when it withholds `retract` from
 *  writeRailTrains — uniform wording so ops can grep a run log for it. */
export function logRetractSkippedIncompleteInputs(detail: string): void {
  console.error(`\n!!! retract skipped — incomplete inputs (${detail}) — legacy OLD_FALLBACK stamps stay in place this run`)
}

// ── Merged stop-frequency cache with feed provenance ──
// The merged CACHE_FREQUENCIES snapshot used to be a bare stops array written
// UNCONDITIONALLY — a partial-feed run could poison it and every later
// cache-served run would both under-enrich and (worse) pass a partial snapshot
// to the retract. v2 records which feeds contributed non-empty parses, and the
// enrichers only persist complete snapshots.

/** `stops` is generic: per-country enrichers carry slightly different
 *  StopTrainCount shapes (ae adds a 'metro' family). */
interface MergedStopCacheV2<T> {
  v: 2
  feedsLoadedNonEmpty: string[]
  stops: T[]
}

export function writeMergedStopCache<T>(path: string, feedsLoadedNonEmpty: string[], stops: T[]): void {
  const payload: MergedStopCacheV2<T> = { v: 2, feedsLoadedNonEmpty, stops }
  writeFileSync(path, JSON.stringify(payload))
}

/** `feedsLoadedNonEmpty === null` marks a legacy bare-array cache: its stops are
 *  fine for enrichment, but its completeness is unprovable, so callers must treat
 *  it as retract-unsafe. Refresh path: delete the cache file (feed extracts are
 *  cached separately, so the rebuild needs no network) or --force-download. */
export function readMergedStopCache<T>(path: string): { stops: T[]; feedsLoadedNonEmpty: string[] | null } {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as T[] | MergedStopCacheV2<T>
  if (Array.isArray(parsed)) return { stops: parsed, feedsLoadedNonEmpty: null }
  return { stops: parsed.stops ?? [], feedsLoadedNonEmpty: parsed.feedsLoadedNonEmpty ?? [] }
}

// ── Stops with coordinates + parent-station resolution ──

export interface StopsWithCoords {
  /** stop_id -> parsed stop, valid-coords (and in-bounds, when `bbox` was given) only. */
  stopsMap: Map<string, GtfsStop>
  /** child stop_id -> parent_station id, for every stop that declares one — whether or
   *  not the child itself has valid coords (a coordless platform still needs its parent
   *  looked up). */
  childToParent: Map<string, string>
  skippedNoCoords: number
  skippedOutOfBounds: number
}

/**
 * stops.txt -> coordinate map + parent-station index, shared by the per-stop frequency
 * counter (`computeStopFrequenciesForFeed`) and the station-pair parser
 * (`gtfs-stop-pairs.ts`). `bbox` (with the same 1° border margin the pre-dedup enrichers
 * used) drops stops far outside the country the caller cares about; omit it to keep
 * every stop with valid coordinates.
 */
export async function loadStopsWithCoords(
  extractDir: string,
  bbox?: readonly [number, number, number, number],
): Promise<StopsWithCoords> {
  const stopsRaw = await parseCsvStream(resolve(extractDir, 'stops.txt'))
  const stopsMap = new Map<string, GtfsStop>()
  let skippedNoCoords = 0
  let skippedOutOfBounds = 0

  for (const r of stopsRaw) {
    const lat = parseFloat(r['stop_lat'] || '')
    const lon = parseFloat(r['stop_lon'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) { skippedNoCoords++; continue }

    if (bbox) {
      const [minLat, minLon, maxLat, maxLon] = bbox
      if (lat < minLat - 1 || lat > maxLat + 1 || lon < minLon - 1 || lon > maxLon + 1) {
        skippedOutOfBounds++
        continue
      }
    }

    let h3r4: string
    try { h3r4 = latLngToCell(lat, lon, 4) } catch { continue }

    stopsMap.set(r['stop_id'], { stop_id: r['stop_id'], lat, lon, name: (r['stop_name'] || '').trim(), h3r4 })
  }

  const childToParent = new Map<string, string>()
  for (const r of stopsRaw) {
    const parentId = (r['parent_station'] || '').trim()
    if (parentId) childToParent.set(r['stop_id'], parentId)
  }

  return { stopsMap, childToParent, skippedNoCoords, skippedOutOfBounds }
}

/**
 * Resolve a stop_id to its coordinates, falling back to its parent_station when the stop
 * itself has no valid coords (a common pattern: platforms/child stops carry only a name,
 * the parent station carries the GPS). ONE source of truth for this fallback — both the
 * per-stop counter and the pair parser must apply it BEFORE giving up on a stop, or a bare
 * coordless-skip would silently break trip continuity on a platform-heavy feed (Rejseplanen,
 * DELFI, ...).
 */
export function resolveStopViaParent(
  stops: StopsWithCoords,
  stopId: string,
): { stop: GtfsStop | undefined; viaParent: boolean } {
  const direct = stops.stopsMap.get(stopId)
  if (direct) return { stop: direct, viaParent: false }
  const parentId = stops.childToParent.get(stopId)
  const viaParentStop = parentId ? stops.stopsMap.get(parentId) : undefined
  return { stop: viaParentStop, viaParent: viaParentStop !== undefined }
}

// ── Per-feed stop-frequency computation ──
// Composition of computeActiveTripFamiliesForFeed + loadStopsWithCoords above (was
// byte-identical inlined across 11 files pre-2026-07-15); bbox is the only
// per-country input, passed through as a parameter.

export async function computeStopFrequenciesForFeed(
  feed: { id: string },
  extractDir: string,
  bbox: readonly [number, number, number, number],
): Promise<StopTrainCount[]> {
  console.log(`\n  [${feed.id}] Parsing GTFS files...`)
  const startTime = Date.now()

  console.log(`  Reading routes.txt, calendar, trips.txt...`)
  const { tripFam, targetDate, calendarPresent, activeServiceIds } =
    await computeActiveTripFamiliesForFeed(extractDir, routeFamily)
  if (calendarPresent) {
    console.log(`  Target date: ${targetDate ? formatDate(targetDate) : '(unresolved)'}`)
  } else {
    console.log(`  WARNING: No calendar files. Counting all trips.`)
  }
  console.log(`  ${activeServiceIds.size} active service IDs on target date`)
  console.log(`  ${tripFam.size} rail/tram trips on target day`)

  if (tripFam.size === 0) {
    console.log(`  WARNING: No active rail trips (or no rail routes). Returning empty.`)
    return []
  }

  // ── stop_times.txt (stream for large files) ──
  console.log(`  Reading stop_times.txt (streaming)...`)
  const stopDepartures = new Map<string, { rail: number; tram: number }>()

  const stStream = createReadStream(resolve(extractDir, 'stop_times.txt'), { encoding: 'utf-8' })
  const stRl = createInterface({ input: stStream, crlfDelay: Infinity })
  let stHeaders: string[] | null = null
  let stLines = 0
  let stMatched = 0
  let tripIdIdx = -1
  let stopIdIdx = -1
  let lastProgressTime = Date.now()

  for await (const rawLine of stRl) {
    const line = stHeaders === null ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trim() === '') continue

    if (!stHeaders) {
      stHeaders = parseCsvLine(line)
      tripIdIdx = stHeaders.indexOf('trip_id')
      stopIdIdx = stHeaders.indexOf('stop_id')
      if (tripIdIdx < 0 || stopIdIdx < 0) {
        throw new Error(`stop_times.txt missing trip_id/stop_id. Found: ${stHeaders.join(', ')}`)
      }
      continue
    }

    stLines++
    const fields = parseCsvLine(line)
    const tripId = fields[tripIdIdx]
    const fam = tripFam.get(tripId)
    if (!fam) continue

    const stopId = fields[stopIdIdx]
    let counts = stopDepartures.get(stopId)
    if (!counts) { counts = { rail: 0, tram: 0 }; stopDepartures.set(stopId, counts) }
    counts[fam]++
    stMatched++

    if (Date.now() - lastProgressTime > 10_000) {
      console.log(`    ... ${(stLines / 1e6).toFixed(1)}M lines, ${stMatched} rail stop-times`)
      lastProgressTime = Date.now()
    }
  }
  console.log(`  ${stLines} stop_times lines, ${stMatched} rail stop-times, ${stopDepartures.size} unique stops`)

  // ── stops.txt + parent-station resolution ──
  console.log(`  Reading stops.txt...`)
  const stops = await loadStopsWithCoords(extractDir, bbox)
  console.log(`  ${stops.stopsMap.size} stops with valid coords`)
  if (stops.skippedOutOfBounds > 0) console.log(`  Skipped (out of bounds): ${stops.skippedOutOfBounds}`)

  // ── Build final list ──
  const results: StopTrainCount[] = []
  let resolvedViaParent = 0

  for (const [stopId, counts] of stopDepartures) {
    const { stop, viaParent } = resolveStopViaParent(stops, stopId)
    if (!stop) continue
    if (viaParent) resolvedViaParent++

    for (const family of ['rail', 'tram'] as const) {
      if (counts[family] === 0) continue
      results.push({
        stop_id: stop.stop_id,
        lat: stop.lat,
        lon: stop.lon,
        name: stop.name,
        h3r4: stop.h3r4,
        family,
        trains_passenger: counts[family],
        trains_freight: 0,
      })
    }
  }

  // Deduplicate by coordinates + family
  const dedupMap = new Map<string, StopTrainCount>()
  for (const sc of results) {
    const key = `${sc.lat.toFixed(4)}_${sc.lon.toFixed(4)}_${sc.family}`
    const existing = dedupMap.get(key)
    if (existing) {
      existing.trains_passenger += sc.trains_passenger
    } else {
      dedupMap.set(key, { ...sc })
    }
  }
  const deduped = [...dedupMap.values()]

  console.log(`  [${feed.id}] ${deduped.length} stops with train counts (${resolvedViaParent} resolved via parent station)`)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  [${feed.id}] GTFS parsing took ${elapsed}s`)

  return deduped
}
