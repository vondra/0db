/**
 * Unit tests for `computeStopFrequenciesWithHeadwayBoost` (enrich-railway-mx.ts) —
 * synthetic tmpdir GTFS fixtures, fully offline (no network, no real feed download,
 * no fabricated GTFS zip). Pins the ONE genuinely MX-specific behavior this
 * migration preserved: frequencies.txt headway-block expansion of a per-stop
 * departure count, which core's shared `computeStopFrequenciesForFeed`
 * (gtfs-enrich-core.ts) does not support — see this file's module doc and the
 * function's own doc comment for the CDMX SEMOVI Metro/Tren Ligero rationale.
 *
 * Run: `cd pipeline && npx tsx --test enrich-railway-mx.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeStopFrequenciesWithHeadwayBoost, MX_BBOX, type FeedConfig } from './enrich-railway-mx.js'

const TMP = mkdtempSync(join(tmpdir(), 'enrich-railway-mx-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const FEED: FeedConfig = { id: 'test-feed', name: 'Test Feed', urls: [] }

/** Write a minimal synthetic GTFS extract into `dir` (created fresh) from a map of
 *  filename -> CSV text (header row + data rows). Mirrors the fixture helper in
 *  lib/gtfs-stop-pairs.test.ts / lib/gtfs-enrich-core.test.ts. */
function writeGtfsFixture(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents.trim() + '\n')
  }
}

// No calendar.txt/calendar_dates.txt in these fixtures => computeActiveTripFamiliesForFeed's
// "no calendar data at all" fallback counts every trip — keeps fixtures focused on the
// headway-boost mechanics under test, not calendar-day selection.
const METRO_ROUTES = 'route_id,route_type\nMETRO_L1,1\n' // GTFS metro (1) -> 'tram' family (routeFamily)
const TRIPS = 'trip_id,route_id,service_id\nT1,METRO_L1,svc\n'
const STOPS = 'stop_id,stop_name,stop_lat,stop_lon\nS1,Indios Verdes,19.5000,-99.1200\n'

test('frequencies.txt headway boost: a single template stop_time expands to its daily departure count', async () => {
  const dir = join(TMP, 'headway-boost')
  writeGtfsFixture(dir, {
    'routes.txt': METRO_ROUTES,
    'trips.txt': TRIPS,
    // ONE stop_time for the template trip — without the boost this would count as 1 departure.
    'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,S1,1\n',
    'stops.txt': STOPS,
    // 05:00-24:00 (19h = 68 400s) every 300s (5 min) headway => 228 departures.
    'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nT1,05:00:00,24:00:00,300\n',
  })

  const stops = await computeStopFrequenciesWithHeadwayBoost(FEED, dir, MX_BBOX)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].family, 'tram') // GTFS route_type 1 (metro) -> 'tram' family, never heavy rail
  assert.equal(stops[0].trains_passenger, 228, 'headway-expanded count, not the raw 1 stop_time')
})

test('no frequencies.txt: each stop_time counts as exactly one departure (unboosted default)', async () => {
  const dir = join(TMP, 'no-frequencies')
  writeGtfsFixture(dir, {
    'routes.txt': METRO_ROUTES,
    'trips.txt': 'trip_id,route_id,service_id\nT1,METRO_L1,svc\nT2,METRO_L1,svc\n',
    'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,S1,1\nT2,S1,1\n',
    'stops.txt': STOPS,
    // no frequencies.txt at all
  })

  const stops = await computeStopFrequenciesWithHeadwayBoost(FEED, dir, MX_BBOX)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].trains_passenger, 2, 'two individually-scheduled trips, no boost applied')
})

test('a trip absent from frequencies.txt keeps its unboosted count of 1, alongside a boosted sibling', async () => {
  const dir = join(TMP, 'mixed-boost')
  writeGtfsFixture(dir, {
    'routes.txt': METRO_ROUTES,
    // T1 is frequency-based (template trip), T2 is an individually-scheduled trip.
    'trips.txt': 'trip_id,route_id,service_id\nT1,METRO_L1,svc\nT2,METRO_L1,svc\n',
    'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,S1,1\nT2,S1,1\n',
    'stops.txt': STOPS,
    // T1 boosted 10x (3600s / 360s); T2 has no frequencies.txt row, stays at 1.
    'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nT1,06:00:00,07:00:00,360\n',
  })

  const stops = await computeStopFrequenciesWithHeadwayBoost(FEED, dir, MX_BBOX)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].trains_passenger, 11, '10 (boosted T1) + 1 (unboosted T2)')
})

test('rail vs tram family split: a heavy-rail route (route_type 2) never mixes into the tram bucket', async () => {
  const dir = join(TMP, 'family-split')
  writeGtfsFixture(dir, {
    'routes.txt': 'route_id,route_type\nSUBURBANO,2\nMETRO_L1,1\n', // 2=rail (Tren Suburbano-style), 1=tram (Metro)
    'trips.txt': 'trip_id,route_id,service_id\nTR,SUBURBANO,svc\nTM,METRO_L1,svc\n',
    'stop_times.txt': 'trip_id,stop_id,stop_sequence\nTR,S1,1\nTM,S1,1\n',
    'stops.txt': STOPS,
    'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nTM,06:00:00,07:00:00,600\n', // TM x6, TR unboosted
  })

  const stops = await computeStopFrequenciesWithHeadwayBoost(FEED, dir, MX_BBOX)
  assert.equal(stops.length, 2, 'same stop, two families -> two rows (one rail, one tram)')
  const rail = stops.find(s => s.family === 'rail')!
  const tram = stops.find(s => s.family === 'tram')!
  assert.equal(rail.trains_passenger, 1, 'SUBURBANO (rail) has no frequencies.txt row, stays unboosted')
  assert.equal(tram.trains_passenger, 6, 'METRO_L1 (tram) boosted 3600s/600s = 6')
})

test('a zero-span or zero-headway frequencies.txt row is ignored, not a divide-by-zero', async () => {
  const dir = join(TMP, 'degenerate-frequencies')
  writeGtfsFixture(dir, {
    'routes.txt': METRO_ROUTES,
    'trips.txt': 'trip_id,route_id,service_id\nT1,METRO_L1,svc\n',
    'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,S1,1\n',
    'stops.txt': STOPS,
    'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nT1,06:00:00,06:00:00,0\n', // zero span AND zero headway
  })

  const stops = await computeStopFrequenciesWithHeadwayBoost(FEED, dir, MX_BBOX)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].trains_passenger, 1, 'degenerate frequencies.txt row dropped -> falls back to the unboosted 1')
})
