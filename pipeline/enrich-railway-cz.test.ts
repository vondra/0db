// Unit tests for the CZ rail enricher's pure pair-formation step
// (`czpttSequencesToStationPairs`) — the core of migration #26 (Phase 3):
// pairs are formed AFTER GPS resolution, so pseudo-locations bridge by
// construction instead of the old chord-matcher's 500 m-radius miss.
//
// GPS values are real coordinates lifted from
// `pipeline/lib/fixtures/trat200-milin-breznice.json` (trať 200
// Březnice-Příbram-Jince corridor) for realism — that fixture's own `pairs`
// carry the exact "Km 67,500" / duplicate-station shape these tests exercise.
//
// Run: cd pipeline && npx tsx --test enrich-railway-cz.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { czpttSequencesToStationPairs, type CzpttTrainSequence } from './enrich-railway-cz.js'

// Real station GPS from lib/fixtures/trat200-milin-breznice.json's `stations` map.
const STATIONS = {
  MILIN: { lat: 49.632385, lon: 14.021691 },
  PRIBRAM: { lat: 49.688805, lon: 14.003311 },
  BREZNICE: { lat: 49.558537, lon: 13.963547 },
  TOCHOVICE: { lat: 49.588767, lon: 13.98784 },
}

test('pseudo-location mid-sequence bridged into one pair (trať 200 "Km 67,500" shape)', () => {
  // Real trať 200 shape: Milín -> "Km 67,500" -> Příbram, where the middle
  // operating point is a pseudo-location CZPTT emits with no station record —
  // it never resolves to GPS, so it must simply drop out of the walked path.
  const codeToGPS = new Map([
    ['76914', STATIONS.MILIN],
    ['74953', STATIONS.PRIBRAM],
    // '76915' (Km 67,500) deliberately absent from codeToGPS — no OSM station exists there.
  ])
  const sequences: CzpttTrainSequence[] = [{
    isFreight: false,
    stops: [
      { code: '76914', name: 'Milín' },
      { code: '76915', name: 'Km 67,500' },
      { code: '74953', name: 'Příbram' },
    ],
  }]

  const pairs = czpttSequencesToStationPairs(sequences, codeToGPS)

  assert.equal(pairs.length, 1, 'the pseudo-location bridges by construction — one A-B pair, not zero')
  assert.deepEqual(pairs[0], {
    fromLat: STATIONS.MILIN.lat, fromLon: STATIONS.MILIN.lon,
    toLat: STATIONS.PRIBRAM.lat, toLon: STATIONS.PRIBRAM.lon,
    pax: 1, frt: 0,
  })
})

test('adjacent duplicate codes collapse to one stop after resolution, never a zero-length self-pair', () => {
  const codeToGPS = new Map([
    ['76914', STATIONS.MILIN],
    ['74953', STATIONS.PRIBRAM],
  ])
  const sequences: CzpttTrainSequence[] = [{
    isFreight: false,
    stops: [
      { code: '76914', name: 'Milín' },
      { code: '76914', name: 'Milín' }, // re-entered platform record, same resolved code
      { code: '74953', name: 'Příbram' },
    ],
  }]

  const pairs = czpttSequencesToStationPairs(sequences, codeToGPS)

  assert.equal(pairs.length, 1, 'exactly one Milín->Příbram pair — no Milín->Milín self-pair')
  assert.equal(pairs[0].fromLat, STATIONS.MILIN.lat)
  assert.equal(pairs[0].toLat, STATIONS.PRIBRAM.lat)
})

test('both directions of one line emit separate RAW pairs — summing is the walk lib\'s job', () => {
  const codeToGPS = new Map([
    ['76914', STATIONS.MILIN],
    ['74953', STATIONS.PRIBRAM],
  ])
  const sequences: CzpttTrainSequence[] = [
    { isFreight: false, stops: [{ code: '76914', name: 'Milín' }, { code: '74953', name: 'Příbram' }] },
    { isFreight: false, stops: [{ code: '74953', name: 'Příbram' }, { code: '76914', name: 'Milín' }] },
  ]

  const pairs = czpttSequencesToStationPairs(sequences, codeToGPS)

  assert.equal(pairs.length, 2, 'both directions stay as SEPARATE raw entries, never pre-summed here')
  assert.deepEqual(
    pairs.map(p => [p.fromLat, p.toLat]),
    [[STATIONS.MILIN.lat, STATIONS.PRIBRAM.lat], [STATIONS.PRIBRAM.lat, STATIONS.MILIN.lat]],
  )
  for (const p of pairs) { assert.equal(p.pax, 1); assert.equal(p.frt, 0) }
})

test('freight/passenger classification lands in the right column', () => {
  const codeToGPS = new Map([
    ['76934', STATIONS.BREZNICE],
    ['76924', STATIONS.TOCHOVICE],
  ])
  const sequences: CzpttTrainSequence[] = [
    { isFreight: false, stops: [{ code: '76934', name: 'Březnice' }, { code: '76924', name: 'Tochovice' }] },
    { isFreight: true, stops: [{ code: '76934', name: 'Březnice' }, { code: '76924', name: 'Tochovice' }] },
  ]

  const pairs = czpttSequencesToStationPairs(sequences, codeToGPS)

  assert.equal(pairs.length, 2)
  const passenger = pairs.find(p => p.pax === 1)
  const freight = pairs.find(p => p.frt === 1)
  assert.ok(passenger, 'a passenger train pair must exist')
  assert.equal(passenger!.frt, 0)
  assert.ok(freight, 'a freight train pair must exist')
  assert.equal(freight!.pax, 0)
})

test('a train with fewer than two GPS-known stops emits nothing', () => {
  const codeToGPS = new Map([['76914', STATIONS.MILIN]])
  const sequences: CzpttTrainSequence[] = [
    { isFreight: false, stops: [{ code: '76915', name: 'Km 67,500' }] }, // 0 known stops
    { isFreight: false, stops: [{ code: '76914', name: 'Milín' }, { code: '76915', name: 'Km 67,500' }] }, // 1 known stop
  ]

  const pairs = czpttSequencesToStationPairs(sequences, codeToGPS)

  assert.equal(pairs.length, 0, 'no pair can be formed with under two GPS-resolved stops')
})
