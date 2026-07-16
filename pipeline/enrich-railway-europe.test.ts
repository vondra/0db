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
import { latLngToCell, gridDisk } from 'h3-js'
import {
  FEEDS, railFamilyFor, findInnerGtfsZips, innerFeedHasRail, dedupeStopsByLocation,
  countryBboxFor, buildTramExtraMatch, feedDeclaresHeavyRail, feedPartsIncomplete,
  type StopTrainCount,
} from './enrich-railway-europe.js'
import type { RailRow } from './lib/railways-arrow.js'

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

// ── Phase 4 (2026-07-16): per-country execution + registry overlap policy ──

test('registry: fr-idf is TRAM-ONLY — its heavy rail (Transilien/RER) is already published in the national fr feed (item 2: mirror dedup deleted on the 7-shared-keys verdict)', () => {
  const frIdf = FEEDS.find(f => f.id === 'fr-idf')!
  assert.equal(railFamilyFor(2, frIdf), null, 'route_type 2 (heavy rail) is NOT counted from fr-idf — the national fr feed owns it')
  assert.equal(railFamilyFor(0, frIdf), 'tram', 'tram route_types still count (SNCF tram-train services)')
  assert.equal(feedDeclaresHeavyRail(frIdf), false, 'tram-only: fr-idf can never contribute heavy-rail retract evidence')
})

test('registry: the national fr feed still declares heavy rail — the ONE heavy-rail authority for FR', () => {
  const fr = FEEDS.find(f => f.id === 'fr')!
  assert.equal(railFamilyFor(2, fr), 'rail')
  assert.equal(feedDeclaresHeavyRail(fr), true)
})

test('feedDeclaresHeavyRail is DERIVED from the allow-list (+ metroAsRail), never a hand flag', () => {
  assert.equal(feedDeclaresHeavyRail(de), true, 'ALL_RAIL_AND_TRAM feed declares heavy rail')
  assert.equal(feedDeclaresHeavyRail(us), true, 'RAIL_TYPES-only feed declares heavy rail')
  assert.equal(feedDeclaresHeavyRail(auvic), true, 'metroAsRail maps METRO types to heavy rail')
})

// ── Item 3: per-family completeness — test BOTH directions ──

test('feedPartsIncomplete: a heavy-rail feed whose PAIRS parsed empty is incomplete even when its tram part loaded (the masking bug direction)', () => {
  assert.equal(feedPartsIncomplete(de, 100, 0), true, 'working tram part must NOT mask an empty heavy-rail part — retractSafe would disown heavy stamps on tram-only evidence')
  assert.equal(feedPartsIncomplete(us, 0, 0), true, 'rail-only feed with no pairs is incomplete')
})

test('feedPartsIncomplete: a heavy-rail feed with pairs loaded is complete (tram emptiness does not block); a tram-only feed is exempt from the pairs requirement', () => {
  assert.equal(feedPartsIncomplete(de, 0, 100), false, 'heavy part loaded — complete')
  const frIdf = FEEDS.find(f => f.id === 'fr-idf')!
  assert.equal(feedPartsIncomplete(frIdf, 50, 0), false, 'tram-only feed judged on its tram part alone — zero pairs is its normal state')
  assert.equal(feedPartsIncomplete(frIdf, 0, 0), true, 'tram-only feed with an empty tram part IS incomplete')
})

test('per-country feed selection: filtering FEEDS by country selects exactly that country\'s own feeds, nothing else', () => {
  assert.deepEqual(FEEDS.filter(f => f.country === 'DE').map(f => f.id), ['de'])
  assert.deepEqual(FEEDS.filter(f => f.country === 'FR').map(f => f.id).sort(), ['fr', 'fr-idf'])
  assert.deepEqual(FEEDS.filter(f => f.country === 'AU').map(f => f.id).sort(), ['au-qld', 'au-vic'])
  assert.deepEqual(FEEDS.filter(f => f.country === 'CZ'), [], 'CZ has no feed in this registry — it runs its own bespoke enricher (enrich-railway-cz.ts)')
})

test('countryBboxFor: a single-feed country pads that feed\'s own boundingBox by 0.5°', () => {
  const de = FEEDS.find(f => f.id === 'de')!
  const bbox = countryBboxFor('DE')
  assert.deepEqual(bbox, [
    de.boundingBox[0] - 0.5, de.boundingBox[1] - 0.5, de.boundingBox[2] + 0.5, de.boundingBox[3] + 0.5,
  ])
})

test('countryBboxFor: a multi-feed country (FR) unions every one of its feeds\' boundingBoxes before padding', () => {
  const fr = FEEDS.find(f => f.id === 'fr')!
  const frIdf = FEEDS.find(f => f.id === 'fr-idf')!
  const bbox = countryBboxFor('FR')
  const expected: [number, number, number, number] = [
    Math.min(fr.boundingBox[0], frIdf.boundingBox[0]) - 0.5,
    Math.min(fr.boundingBox[1], frIdf.boundingBox[1]) - 0.5,
    Math.max(fr.boundingBox[2], frIdf.boundingBox[2]) + 0.5,
    Math.max(fr.boundingBox[3], frIdf.boundingBox[3]) + 0.5,
  ]
  assert.deepEqual(bbox, expected)
})

test('countryBboxFor: an unknown country throws rather than silently returning a world-wide box', () => {
  assert.throws(() => countryBboxFor('ZZ'))
})

const FAKE_RAIL_ROW = (railType: number): RailRow => ({
  railType, usage: 0, existingSourceId: 0, existingPax: 0, existingFrt: 0,
  startLat: 50.0, startLon: 14.0, endLat: 50.0, endLon: 14.0, midLat: 50.0, midLon: 14.0, name: '',
})

test('buildTramExtraMatch: a tram stop registered under a NEIGHBOR hex (k=1 ring) still matches a row queried under the origin hex — fixes the single-hex limitation', () => {
  const originHex = latLngToCell(50.0, 14.0, 4)
  const neighborHex = gridDisk(originHex, 1).find(h => h !== originHex)!
  // The stop's h3r4 is set to the NEIGHBOR hex id on purpose (isolating
  // buildTramExtraMatch's OWN ring-merge logic from real H3 boundary
  // geometry, which this unit test doesn't need to reproduce) while its
  // lat/lon sits well within the 500 m nearestGridStop radius of the query row.
  const tramStops: StopTrainCount[] = [
    { stop_id: 'S1', lat: 50.0001, lon: 14.0001, name: 'Neighbor Stop', h3r4: neighborHex, family: 'tram', trains_passenger: 42, trains_freight: 0 },
  ]
  const extraMatch = buildTramExtraMatch(tramStops)
  const result = extraMatch(FAKE_RAIL_ROW(2), 0, originHex)
  assert.ok(result, 'the k=1 ring pulled in the neighbor hex\'s stop — a per-hex-only grid would have missed it')
  assert.equal(result!.pax, 42)
})

test('buildTramExtraMatch: heavy rail rows (railType 0) never match — heavy rail is walk-only', () => {
  const originHex = latLngToCell(50.0, 14.0, 4)
  const tramStops: StopTrainCount[] = [
    { stop_id: 'S1', lat: 50.0001, lon: 14.0001, name: 'Stop', h3r4: originHex, family: 'tram', trains_passenger: 42, trains_freight: 0 },
  ]
  const extraMatch = buildTramExtraMatch(tramStops)
  assert.equal(extraMatch(FAKE_RAIL_ROW(0), 0, originHex), null, 'heavy rail rows are never handled by the tram extraMatch arm')
})

test('buildTramExtraMatch: no stop anywhere in the ring returns null (never throws on an empty grid)', () => {
  const originHex = latLngToCell(50.0, 14.0, 4)
  const extraMatch = buildTramExtraMatch([])
  assert.equal(extraMatch(FAKE_RAIL_ROW(1), 0, originHex), null)
})
