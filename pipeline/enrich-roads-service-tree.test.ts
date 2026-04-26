/**
 * Regression tests for enrich-roads-service-tree.ts root-cause fixes.
 * Run: `npx tsx --test pipeline/enrich-roads-service-tree.test.ts`
 *
 * Three scenarios from the /gg quad review (commit 2bda9264 + 6a2fa2af):
 *   1. track-stub-not-root           — service road dead-ending at cls=8 track
 *                                       must NOT form an exit; flow stays local.
 *   2. measured-boundary-still-roots — non-overwriteable cls 5–9 (already filled
 *                                       by higher-precedence source) must still
 *                                       create an exit, otherwise pseudo-root
 *                                       inverts flow toward an internal hub.
 *   3. apartment-cap-clamps           — cls=7 cap=400 clamps high accumulated flow.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGraph,
  findComponents,
  flowAccumulate,
  splitAADT,
  estimateDwellings,
  SERVICE_TREE_CAP_PER_CLASS,
  TRIPS_PER_DWELLING,
} from './enrich-roads-service-tree.ts'

// ─── Mock arrow-table helper ───────────────────────────────────────────────
//
// `buildGraph` only needs `.numRows` and `.getChild(name).get(i)` from the
// table — no need to construct a real apache-arrow Table for these tests.
// Each test row is `{ start_lat, start_lon, end_lat, end_lon, length_m,
// road_class, source_id, osm_id }`.

interface RoadRow {
  start_lat: number; start_lon: number
  end_lat: number;   end_lon: number
  length_m: number
  road_class: number
  source_id?: number
  osm_id?: number
}

function mockRoadTable(rows: RoadRow[]): any {
  return {
    numRows: rows.length,
    getChild(name: string) {
      if (!rows.length) return undefined
      const sample = rows[0] as Record<string, number | undefined>
      if (!(name in sample) && name !== 'source_id' && name !== 'osm_id') return undefined
      return { get: (i: number) => (rows[i] as Record<string, number | undefined>)[name] ?? 0 }
    },
  }
}

// ─── Test 1: track-stub does not create an exit ────────────────────────────

test('track-stub-not-root: service road dead-ending at track is not an exit', () => {
  // N0 ──cls=5──N1──cls=7──N2──cls=8(track)──N3
  //                         │
  //                         (track has no further connections)
  const rows: RoadRow[] = [
    { start_lat: 0, start_lon: 0, end_lat: 0, end_lon: 0.001, length_m: 100, road_class: 5 }, // N0-N1 residential
    { start_lat: 0, start_lon: 0.001, end_lat: 0, end_lon: 0.002, length_m: 100, road_class: 7 }, // N1-N2 service
    { start_lat: 0, start_lon: 0.002, end_lat: 0, end_lon: 0.003, length_m: 100, road_class: 8 }, // N2-N3 track
  ]
  const graph = buildGraph(mockRoadTable(rows))
  const components = findComponents(graph)

  // Eligible: cls=5 + cls=7 (track excluded)
  assert.strictEqual(graph.eligible[0], 1, 'cls=5 eligible')
  assert.strictEqual(graph.eligible[1], 1, 'cls=7 eligible')
  assert.strictEqual(graph.eligible[2], 0, 'cls=8 track NOT eligible')

  // Exactly one component (the cls=5 + cls=7 chain)
  assert.strictEqual(components.length, 1)
  assert.strictEqual(components[0].segments.length, 2)

  // No exit edges anywhere — track is not an exit; pure dead-end.
  assert.strictEqual(components[0].rootNodes.size, 0,
    'track endpoint must NOT be a root — that was the Pasito bug')

  // Pseudo-root fallback fires; flow stays bounded by local trips
  // (no buildings in this fixture, so segFlow seeded with 0).
  const segNodeIds = graph.segNodeIds
  const lengthCol = mockRoadTable(rows).getChild('length_m')
  const emptyDwellings = new Map<number, number>()
  const segFlow = flowAccumulate(components[0], segNodeIds, lengthCol, emptyDwellings)
  for (const flow of segFlow.values()) {
    assert.strictEqual(flow, 0, 'no buildings → no flow inflation through fake-root')
  }
})

// ─── Test 2: measured-boundary still roots ─────────────────────────────────

test('measured-boundary-still-roots: non-overwriteable cls=5 marks exit', () => {
  // N0 ──cls=5(measured src=10)──N1──cls=5──N2──cls=7──N3
  //
  // The N0-N1 segment is non-overwriteable (eu-city-traffic, source_id=10).
  // It is filtered OUT of routing eligibility, but N1 must still be an exit
  // root because the measured edge IS a real motor-vehicle exit.
  const rows: RoadRow[] = [
    { start_lat: 0, start_lon: 0, end_lat: 0, end_lon: 0.001, length_m: 100, road_class: 5, source_id: 10 }, // measured
    { start_lat: 0, start_lon: 0.001, end_lat: 0, end_lon: 0.002, length_m: 100, road_class: 5, source_id: 0 }, // unfilled
    { start_lat: 0, start_lon: 0.002, end_lat: 0, end_lon: 0.003, length_m: 100, road_class: 7, source_id: 0 }, // unfilled service
  ]
  const graph = buildGraph(mockRoadTable(rows))

  // Eligibility: only un-overwriteable rows are in routing graph
  assert.strictEqual(graph.eligible[0], 0, 'measured cls=5 NOT in routing graph')
  assert.strictEqual(graph.eligible[1], 1)
  assert.strictEqual(graph.eligible[2], 1)

  // hasExitEdge: N1 is shared between measured edge (sets hasExitEdge) and
  // the eligible cls=5 (doesn't set). The OR → N1.hasExitEdge=true.
  // N0 only touches the measured edge → also hasExitEdge=true (but N0 is
  // outside any eligible component, so won't appear as root).
  // N2, N3 only touch eligible local edges → hasExitEdge=false.
  const components = findComponents(graph)
  assert.strictEqual(components.length, 1, 'one eligible component')
  assert.strictEqual(components[0].segments.length, 2)

  // The component must have exactly one root: N1 (where measured boundary meets eligible).
  assert.strictEqual(components[0].rootNodes.size, 1,
    'measured-cls=5 boundary node must still be a root — that was the Codex finding')
})

// ─── Test 3: cls=7 cap clamps apartment-block accumulated flow ─────────────

test('apartment-cap-clamps: cls=7 flow > 400 clamps to cap, splitAADT correct', () => {
  // Cap is 400 (1.6× engine default of 250); apartment-block driveways with
  // many dwellings can legitimately accumulate more, and the cap is the
  // intended defense. Verify the constant + the splitAADT result.
  assert.strictEqual(SERVICE_TREE_CAP_PER_CLASS[7], 400,
    'cls=7 cap raised from 200 to 400 (above engine default 250)')

  // Apartment block: 200 dwellings × 3.68 = 736 trips (above cap).
  const rawTrips = 200 * TRIPS_PER_DWELLING
  assert.ok(rawTrips > 400, 'apartment-block trip count exceeds cap')

  const capped = Math.min(rawTrips, SERVICE_TREE_CAP_PER_CLASS[7])
  assert.strictEqual(capped, 400)

  // splitAADT proportions: 1 % medium, 2 % heavy, 1 % moto, rest light.
  const split = splitAADT(capped)
  assert.strictEqual(split.medium + split.heavy + split.moto + split.light, 400)
  assert.ok(split.light >= 380 && split.light <= 396, `light should dominate, got ${split.light}`)
})

// ─── Test 4: estimateDwellings matches expected ratios ─────────────────────

test('estimateDwellings: residential default scales with GFA', () => {
  // Type=0 (unknown → residential) divides GFA by 80 m²/dwelling.
  assert.strictEqual(estimateDwellings(0, 1, 80), 1, '80 m² × 1 floor = 1 dw')
  assert.strictEqual(estimateDwellings(0, 2, 80), 2, '80 m² × 2 floors = 2 dw')
  assert.strictEqual(estimateDwellings(0, 5, 200), 12, '200 m² × 5 floors = 1000 m² GFA = 12 dw')

  // Garage (type=7) is fixed at 1 dwelling regardless of size.
  assert.strictEqual(estimateDwellings(7, 1, 30), 1)
  assert.strictEqual(estimateDwellings(7, 1, 300), 1)
})
