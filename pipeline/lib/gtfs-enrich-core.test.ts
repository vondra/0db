/**
 * Unit tests for the CRITICAL-1b retract-safety helpers in gtfs-enrich-core.ts
 * (describeIncompleteFeeds — the completeness evidence every enricher gates its
 * writeRailTrains `retract` on — and the v2 merged-stop cache round-trip) plus
 * the shared route_type → family classification every GTFS rail enricher routes
 * stops through, and the shared `computeActiveTripFamiliesForFeed` calendar logic
 * (routes + calendar + trips -> trip_id family map) used by both the per-stop
 * frequency counter and the station-pair parser (gtfs-stop-pairs.ts).
 *
 * Run: `cd pipeline && npx tsx --test lib/gtfs-enrich-core.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  computeActiveTripFamiliesForFeed, describeIncompleteFeeds, readMergedStopCache, routeFamily,
  writeMergedStopCache,
} from './gtfs-enrich-core.js'

const TMP = mkdtempSync(join(tmpdir(), 'gtfs-enrich-core-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** Write a minimal synthetic GTFS extract into `dir` (created fresh) from a map of
 *  filename -> CSV text (header row + data rows, no trailing newline required). */
function writeGtfsFixture(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents.trim() + '\n')
  }
}

test('describeIncompleteFeeds: complete snapshot yields empty detail (retract-safe)', () => {
  assert.equal(describeIncompleteFeeds(['a', 'b', 'c'], ['c', 'a', 'b']), '')
})

test('describeIncompleteFeeds: a missing or empty-parsed feed is named (retract-unsafe)', () => {
  // 'b' never loaded, 'c' loaded but parsed empty (so the caller left it out of
  // loadedNonEmptyFeedIds) — both must appear; extra unknown ids never mask a gap.
  assert.equal(
    describeIncompleteFeeds(['a', 'b', 'c'], ['a', 'x']),
    'feeds missing or parsed empty: b,c',
  )
  assert.equal(describeIncompleteFeeds(['solo'], []), 'feeds missing or parsed empty: solo')
})

test('merged-stop cache v2 round-trip preserves stops AND feed provenance', () => {
  const path = join(TMP, 'v2.json')
  const stops = [{ stop_id: 's1', lat: 50.85, lon: 4.35, trains_passenger: 42 }]
  writeMergedStopCache(path, ['stib-brussels', 'tec-wallonia'], stops)
  const cached = readMergedStopCache<(typeof stops)[number]>(path)
  assert.deepEqual(cached.stops, stops)
  assert.deepEqual(cached.feedsLoadedNonEmpty, ['stib-brussels', 'tec-wallonia'])
  // The provenance closes the gate loop: only when every configured feed is in
  // the recorded list may a cache-served run pass `retract` to writeRailTrains.
  assert.equal(describeIncompleteFeeds(['stib-brussels', 'tec-wallonia'], cached.feedsLoadedNonEmpty!), '')
  assert.notEqual(describeIncompleteFeeds(['stib-brussels', 'tec-wallonia', 'delijn-flanders'], cached.feedsLoadedNonEmpty!), '')
})

test('routeFamily: basic GTFS codes route rail vs tram/metro vs dropped (DE de_full profile)', () => {
  // gtfs.de de_full flattens DELFI NeTEx to BASIC route_types only (verified
  // 2026-07-11: 2 rail, 0 tram, 1 subway, 3 bus, 4 ferry, 7 funicular — no
  // TPEG 100-117). Locks the family routing enrich-railway-de.ts rides on:
  // ICE/IC/RE/S-Bahn (2) must never land in the tram grid, U-Bahn (1) groups
  // with tram (OSM light_rail), road/water/funicular modes must drop out
  // (OSM funicular rows keep the engine's own 40/day default instead).
  assert.equal(routeFamily(2), 'rail')
  assert.equal(routeFamily(0), 'tram')
  assert.equal(routeFamily(1), 'tram')
  assert.equal(routeFamily(3), null, 'bus never enriches a rail row')
  assert.equal(routeFamily(4), null, 'ferry dropped')
  assert.equal(routeFamily(7), null, 'funicular dropped — engine default owns it')
})

test('routeFamily: TPEG extended codes keep the same family split', () => {
  // Representatives of the extended sets (feeds like ÖBB/opentransportdata
  // publish these): railway subtypes → rail, tram/metro subtypes → tram.
  assert.equal(routeFamily(102), 'rail', 'long-distance rail (TPEG 102)')
  assert.equal(routeFamily(109), 'rail', 'suburban railway (TPEG 109)')
  assert.equal(routeFamily(900), 'tram')
  assert.equal(routeFamily(402), 'tram', 'metro groups with tram (OSM light_rail)')
  assert.equal(routeFamily(715), null, 'bus subtype dropped')
})

test('legacy bare-array cache reads with null provenance (completeness unprovable)', () => {
  const path = join(TMP, 'legacy.json')
  const stops = [{ stop_id: 's1', lat: 51.2, lon: 4.4 }]
  writeFileSync(path, JSON.stringify(stops))
  const cached = readMergedStopCache<(typeof stops)[number]>(path)
  assert.deepEqual(cached.stops, stops, 'legacy stops still served for enrichment')
  assert.equal(cached.feedsLoadedNonEmpty, null, 'null = no provenance = retract-unsafe for multi-feed enrichers')
})

// ── computeActiveTripFamiliesForFeed ──
// The shared routes+calendar+trips resolver used by both computeStopFrequenciesForFeed
// (below) and the station-pair parser (gtfs-stop-pairs.ts).

const RAIL_ROUTES_CSV = 'route_id,route_type\nR1,2\n'
const TRIPS_CSV = (serviceId: string) => `trip_id,route_id,service_id\nT1,R1,${serviceId}\n`

test('computeActiveTripFamiliesForFeed: calendar present + zero active services on target date = ZERO trips (2026-07-15 fix)', async () => {
  const dir = join(TMP, 'calendar-zero-active')
  // wednesday=0 for every service_id defined here, so no matter which Wednesday
  // findTargetWednesday's midpoint heuristic resolves to, activeServiceIds stays
  // empty — calendar.txt exists (a real, non-broken date range) but genuinely
  // serves nothing on a Wednesday (e.g. a weekend-only shuttle).
  writeGtfsFixture(dir, {
    'routes.txt': RAIL_ROUTES_CSV,
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'weekend_only,0,0,0,0,0,1,1,20260101,20261231\n',
    'trips.txt': TRIPS_CSV('weekend_only'),
  })

  const result = await computeActiveTripFamiliesForFeed(dir, routeFamily)
  assert.equal(result.calendarPresent, true, 'calendar.txt exists — this is the "we know the active set" branch')
  assert.equal(result.activeServiceIds.size, 0, 'genuinely zero services run on the resolved Wednesday')
  assert.equal(
    result.tripFam.size, 0,
    'BUG FIX: calendar present + zero active services must yield ZERO trips, not "count everything" — ' +
    'the pre-2026-07-15 code gated on `activeServiceIds.size > 0`, so this exact case silently counted T1 as running',
  )
})

test('computeActiveTripFamiliesForFeed: calendar present + a matching active service still counts that trip (fix does not over-correct)', async () => {
  const dir = join(TMP, 'calendar-nonzero-active')
  writeGtfsFixture(dir, {
    'routes.txt': RAIL_ROUTES_CSV,
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'daily,1,1,1,1,1,1,1,20260101,20261231\n',
    'trips.txt': TRIPS_CSV('daily'),
  })

  const result = await computeActiveTripFamiliesForFeed(dir, routeFamily)
  assert.equal(result.calendarPresent, true)
  assert.ok(result.activeServiceIds.has('daily'))
  assert.equal(result.tripFam.get('T1'), 'rail', 'a trip whose service DOES run on the target date is still counted')
})

test('computeActiveTripFamiliesForFeed: no calendar files at all still counts every trip (preserved fallback)', async () => {
  const dir = join(TMP, 'no-calendar-files')
  writeGtfsFixture(dir, {
    'routes.txt': RAIL_ROUTES_CSV,
    'trips.txt': TRIPS_CSV('whatever'), // no calendar.txt/calendar_dates.txt define this service at all
  })

  const result = await computeActiveTripFamiliesForFeed(dir, routeFamily)
  assert.equal(result.calendarPresent, false, 'neither calendar.txt nor calendar_dates.txt exists')
  assert.equal(result.tripFam.get('T1'), 'rail', 'the pre-existing "no calendar data" fallback still counts all trips')
})

test('computeActiveTripFamiliesForFeed: a custom dateSelection hook overrides the default midpoint-Wednesday picker', async () => {
  const dir = join(TMP, 'custom-date-selection')
  writeGtfsFixture(dir, {
    'routes.txt': RAIL_ROUTES_CSV,
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'svc,1,1,1,1,1,1,1,20260101,20260201\n',
    'trips.txt': TRIPS_CSV('svc'),
  })

  const forcedDate = '20260115'
  const result = await computeActiveTripFamiliesForFeed(dir, routeFamily, () => forcedDate)
  assert.equal(result.targetDate, forcedDate, 'europe-style busiest-Wednesday sampler (or any hook) wins over the default heuristic')
})

test('computeActiveTripFamiliesForFeed: familyOf hook filters out non-matching route types (rail-only view)', async () => {
  const dir = join(TMP, 'family-hook-filter')
  writeGtfsFixture(dir, {
    'routes.txt': 'route_id,route_type\nR1,2\nR2,0\n', // R1 rail, R2 tram
    'trips.txt': 'trip_id,route_id,service_id\nT1,R1,svc\nT2,R2,svc\n',
  })

  const railOnly = (routeType: number): 'rail' | null => (routeType === 2 ? 'rail' : null)
  const result = await computeActiveTripFamiliesForFeed(dir, railOnly)
  assert.equal(result.tripFam.size, 1)
  assert.equal(result.tripFam.get('T1'), 'rail')
  assert.equal(result.tripFam.has('T2'), false, 'tram trip excluded by the rail-only familyOf hook')
})
