/**
 * #31.6 au-vic: the PTV feed ships one outer gtfs.zip that unzips into mode-split
 * <N>/google_transit.zip subfeeds. downloadGtfs processes the rail-bearing ones;
 * railFamilyFor maps Melbourne Metro Trains (GTFS route_type 400) to HEAVY rail
 * (OSM railway=rail), not the default 'tram'/light_rail. This pins the modeling
 * decision + the subfeed discovery. The end-to-end load (611 rail stops:
 * V/Line + Metro Trains + interstate, buses skipped) is verified against the
 * real 206 MB cache; here we pin the pure logic.
 *
 * Run: `cd pipeline && npx tsx --test enrich-railway-europe.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FEEDS, railFamilyFor, findInnerGtfsZips, innerFeedHasRail, dedupeStopsByLocation } from './enrich-railway-europe.js'

const auvic = FEEDS.find((f) => f.id === 'au-vic')! // metroAsRail, RAIL∪METRO
const de = FEEDS.find((f) => f.id === 'de')!        // ALL_RAIL_AND_TRAM, no override
const us = FEEDS.find((f) => f.id === 'us')!        // RAIL_TYPES only

test('railFamilyFor: au-vic maps GTFS metro (400) to HEAVY rail', () => {
  assert.equal(railFamilyFor(2, auvic), 'rail')   // V/Line regional
  assert.equal(railFamilyFor(400, auvic), 'rail') // Metro Trains — THE FIX (would be 'tram' by default)
  assert.equal(railFamilyFor(102, auvic), 'rail') // extended rail (interstate)
  assert.equal(railFamilyFor(0, auvic), null)     // Yarra Trams: not in au-vic's allow-list
  assert.equal(railFamilyFor(3, auvic), null)     // bus
})

test('railFamilyFor: a normal metro feed keeps metro as tram/light_rail', () => {
  assert.equal(railFamilyFor(400, de), 'tram') // no metroAsRail → the global default
  assert.equal(railFamilyFor(2, de), 'rail')
  assert.equal(railFamilyFor(0, de), 'tram')
})

test('railFamilyFor: a rail-only feed rejects metro entirely', () => {
  assert.equal(railFamilyFor(400, us), null) // 400 ∉ RAIL_TYPES → not counted
  assert.equal(railFamilyFor(2, us), 'rail')
})

test('dedupeStopsByLocation: sums same coord+family (shared station across subfeeds), keeps distinct coords apart', () => {
  const at = (lat: number, lon: number, pax: number, family: 'rail' | 'tram' = 'rail') =>
    ({ stop_id: `${lat}`, lat, lon, name: 'x', h3r4: 'h', family, trains_passenger: pax, trains_freight: 0 })
  const out = dedupeStopsByLocation([
    at(-37.8182, 144.9522, 385), // au-vic Southern Cross via V/Line (feed 1)
    at(-37.8182, 144.9522, 15),  // same coord via interstate (feed 10) → sums to 400
    at(-37.8184, 144.9519, 130), // a distinct Metro platform ~20m away → stays separate
    at(-37.8182, 144.9522, 9, 'tram'), // same coord, different family → separate
  ])
  const rail = out.filter((s) => s.family === 'rail').sort((a, b) => b.trains_passenger - a.trains_passenger)
  assert.equal(rail[0].trains_passenger, 400) // 385 + 15
  assert.equal(rail[1].trains_passenger, 130) // distinct platform untouched
  assert.equal(out.filter((s) => s.family === 'tram').length, 1)
  assert.equal(out.length, 3)
})

const TMP = mkdtempSync(join(tmpdir(), 'auvic-nested-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

test('findInnerGtfsZips: lists <N>/google_transit.zip subdirs, sorted; empty for a flat/missing dir', () => {
  for (const n of ['2', '1', '10']) {
    mkdirSync(join(TMP, n), { recursive: true })
    writeFileSync(join(TMP, n, 'google_transit.zip'), 'PK') // presence is all findInnerGtfsZips checks
  }
  mkdirSync(join(TMP, 'notafeed'), { recursive: true }) // subdir without the zip → ignored
  assert.deepEqual(findInnerGtfsZips(TMP).map((f) => f.label), ['1', '10', '2'])
  assert.equal(findInnerGtfsZips(join(TMP, 'does-not-exist')).length, 0)
})

test('innerFeedHasRail: fail-safe false on an unreadable/for non-zip file (success path is the real-feed run)', () => {
  // the staged files above are not real zips → unzip -p throws → caught → false
  assert.equal(innerFeedHasRail(join(TMP, '1', 'google_transit.zip'), auvic), false)
})
