/**
 * Graph-construction tests for rail-graph.ts: node interning, T-junction
 * healing (the load-bearing fix for the extractor's collinear-merge
 * swallowing junction vertices — see `microsegment.rs::split`), snap
 * radius, `effectiveRailTraffic`'s engine-zero-defaulting mirror, and the
 * rail-stops index. Routing/parallel-spread/detector tests live in
 * rail-graph-metrics.test.ts (they build on `buildRailGraph` from here).
 *
 * Run: `cd pipeline && npx tsx --test lib/rail-graph.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flatDist } from './spatial.js'
import {
  buildRailGraph, snapToNearestRailGraphNode, effectiveRailTraffic, buildRailStopsIndex,
  STATION_SNAP_RADIUS_M, type RailGraphSegmentInput,
} from './rail-graph.js'

function seg(over: Partial<RailGraphSegmentInput> & Pick<RailGraphSegmentInput, 'key' | 'startLat' | 'startLon' | 'endLat' | 'endLon'>): RailGraphSegmentInput {
  const lengthM = flatDist(over.startLat, over.startLon, over.endLat, over.endLon)
  return {
    osmId: over.key, railType: 0, usage: 0, isTraversalOnly: false, corridorToken: '',
    lengthM, ...over,
  }
}

test('buildRailGraph: a single segment interns exactly two nodes and one edge', () => {
  const g = buildRailGraph([seg({ key: 'a', startLat: 50, startLon: 14, endLat: 50, endLon: 14.01 })])
  assert.equal(g.nodeCount, 2)
  assert.equal(g.edgeCount, 1)
  assert.equal(g.componentOfSegmentKey.get('a'), 0)
})

test('T-junction healing: a branch touching a trunk mid-chord splits the trunk and connects the components', () => {
  // Trunk runs straight east-west at lat 50; its exact midpoint (50, 14.005)
  // is NOT one of its own endpoints, so nodeKey() would otherwise intern the
  // branch's foot as an isolated 3rd node with no edge to the trunk.
  const trunk = seg({ key: 'trunk', startLat: 50, startLon: 14.000, endLat: 50, endLon: 14.010, corridorToken: 'TRUNK' })
  const branch = seg({ key: 'branch', startLat: 50, startLon: 14.005, endLat: 50.005, endLon: 14.005, corridorToken: 'BRANCH' })
  // Unrelated far-away segment: proves components stay SEPARATE where nothing touches.
  const island = seg({ key: 'island', startLat: 60, startLon: 14.000, endLat: 60, endLon: 14.010 })

  const g = buildRailGraph([trunk, branch, island])

  assert.equal(g.nodeCount, 6, 'trunk start/end + junction + branch end, plus the island\'s own 2 nodes')
  assert.equal(g.edgeCount, 4, 'trunk healed into 2 sub-edges + 1 branch edge + 1 island edge')

  const trunkEdges = g.edges.filter((e) => e.parentKey === 'trunk')
  assert.equal(trunkEdges.length, 2, 'trunk split into two sub-edges at the junction')
  for (const e of trunkEdges) assert.equal(e.corridorToken, 'TRUNK', 'sub-edges keep the parent segment fields')

  const trunkComp = g.componentOfSegmentKey.get('trunk')
  const branchComp = g.componentOfSegmentKey.get('branch')
  const islandComp = g.componentOfSegmentKey.get('island')
  assert.equal(trunkComp, branchComp, 'healing connects trunk and branch into ONE component')
  assert.notEqual(trunkComp, islandComp, 'an untouched segment stays its own component')
})

test('T-junction healing: no split when nothing touches the segment body', () => {
  const a = seg({ key: 'a', startLat: 50, startLon: 14.000, endLat: 50, endLon: 14.010 })
  const b = seg({ key: 'b', startLat: 51, startLon: 14.000, endLat: 51, endLon: 14.010 }) // far away, no touch
  const g = buildRailGraph([a, b])
  assert.equal(g.edgeCount, 2, 'neither segment is split')
  assert.notEqual(g.componentOfSegmentKey.get('a'), g.componentOfSegmentKey.get('b'))
})

test('snapToNearestRailGraphNode: within radius resolves to the nearest node, beyond radius fails (-1)', () => {
  const g = buildRailGraph([seg({ key: 'a', startLat: 50, startLon: 14, endLat: 50, endLon: 14.01 })])
  const nodeAId = 0 // trunk start interned first
  assert.equal(snapToNearestRailGraphNode(g, 50, 14), nodeAId, 'exact coordinate match')
  // ~50 m north — comfortably inside the default 300 m radius.
  const near = snapToNearestRailGraphNode(g, 50 + 50 / 110_540, 14, STATION_SNAP_RADIUS_M)
  assert.equal(near, nodeAId)
  // ~1000 m away — outside the default radius.
  const far = snapToNearestRailGraphNode(g, 50 + 1000 / 110_540, 14)
  assert.equal(far, -1)
})

test('effectiveRailTraffic: matches the engine default_traffic table with per-column zero-defaulting', () => {
  // engine/noise-compute/src/emission/railway.rs::default_traffic
  assert.deepEqual(effectiveRailTraffic(0, 0, 0, 0, 1), { pax: 80, frt: 20, total: 100 }, 'rail main')
  assert.deepEqual(effectiveRailTraffic(0, 0, 0, 1, 1), { pax: 30, frt: 5, total: 35 }, 'rail branch')
  assert.deepEqual(effectiveRailTraffic(0, 0, 0, 2, 1), { pax: 0, frt: 15, total: 15 }, 'rail industrial')
  assert.deepEqual(effectiveRailTraffic(0, 0, 0, 9, 1), { pax: 40, frt: 10, total: 50 }, 'rail unknown usage')
  assert.deepEqual(effectiveRailTraffic(0, 0, 1, 0, 1), { pax: 120, frt: 0, total: 120 }, 'tram')
  assert.deepEqual(effectiveRailTraffic(0, 0, 2, 0, 1), { pax: 80, frt: 0, total: 80 }, 'light_rail')
  assert.deepEqual(effectiveRailTraffic(0, 0, 3, 0, 1), { pax: 10, frt: 0, total: 10 }, 'narrow_gauge')
  assert.deepEqual(effectiveRailTraffic(0, 0, 4, 0, 1), { pax: 40, frt: 0, total: 40 }, 'funicular')
  // RailType::from_u8 maps ANY unrecognized code to Rail — an out-of-range
  // railType must resolve through the usage-based Rail table, not a generic
  // fallback of its own.
  assert.deepEqual(effectiveRailTraffic(0, 0, 9, 0, 1), { pax: 80, frt: 20, total: 100 }, 'unrecognized railType falls back to Rail')

  // Per-COLUMN defaulting: a real, nonzero pax leaves frt to default alone.
  assert.deepEqual(effectiveRailTraffic(50, 0, 0, 0, 1), { pax: 50, frt: 20, total: 70 })
  assert.deepEqual(effectiveRailTraffic(0, 40, 0, 0, 1), { pax: 80, frt: 40, total: 120 })

  // Divisor scales both columns after defaulting.
  assert.deepEqual(effectiveRailTraffic(100, 40, 0, 0, 2), { pax: 50, frt: 20, total: 70 })
  // Divisor floors at 1 (0 or negative never means "less than one track").
  assert.deepEqual(effectiveRailTraffic(100, 40, 0, 0, 0), { pax: 100, frt: 40, total: 140 })
})

test('buildRailStopsIndex: radius query true within range, false outside', () => {
  const idx = buildRailStopsIndex([{ lat: 50, lon: 14 }])
  assert.equal(idx.queryWithinRadius(50.001, 14.001, 300), true)
  assert.equal(idx.queryWithinRadius(51, 14, 300), false)
})
