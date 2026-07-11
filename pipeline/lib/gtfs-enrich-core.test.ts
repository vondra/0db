/**
 * Unit tests for the CRITICAL-1b retract-safety helpers in gtfs-enrich-core.ts:
 * describeIncompleteFeeds (the completeness evidence every enricher gates its
 * writeRailTrains `retract` on) and the v2 merged-stop cache round-trip
 * (feed provenance persisted; legacy bare-array caches surface as unprovable).
 *
 * Run: `cd pipeline && npx tsx --test lib/gtfs-enrich-core.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describeIncompleteFeeds, readMergedStopCache, writeMergedStopCache } from './gtfs-enrich-core.js'

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

test('legacy bare-array cache reads with null provenance (completeness unprovable)', () => {
  const path = join(TMP, 'legacy.json')
  const stops = [{ stop_id: 's1', lat: 51.2, lon: 4.4 }]
  writeFileSync(path, JSON.stringify(stops))
  const cached = readMergedStopCache<(typeof stops)[number]>(path)
  assert.deepEqual(cached.stops, stops, 'legacy stops still served for enrichment')
  assert.equal(cached.feedsLoadedNonEmpty, null, 'null = no provenance = retract-unsafe for multi-feed enrichers')
})
