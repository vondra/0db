/**
 * Unit tests for the CRITICAL-1b retract-safety helpers in gtfs-enrich-core.ts
 * (describeIncompleteFeeds — the completeness evidence every enricher gates its
 * writeRailTrains `retract` on — and the v2 merged-stop cache round-trip) plus
 * the shared route_type → family classification every GTFS rail enricher routes
 * stops through.
 *
 * Run: `cd pipeline && npx tsx --test lib/gtfs-enrich-core.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describeIncompleteFeeds, readMergedStopCache, routeFamily, writeMergedStopCache } from './gtfs-enrich-core.js'

const TMP = mkdtempSync(join(tmpdir(), 'gtfs-enrich-core-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

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
