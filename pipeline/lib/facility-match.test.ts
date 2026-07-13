/**
 * Selection-rule tests for facility-match.ts — the /gg-mandated cases
 * (cross-hex max-one, farm+livestock allowed, farm+meat blocked,
 * big-plant-vs-shed edge distance, contest ordering).
 *
 * Run: `cd pipeline && npx tsx --test lib/facility-match.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestCandidate, contestBeats, edgeDistM, quietGateBlocks, type MatchFacility, type MatchPolygon } from './facility-match.js'
import { flatDist } from './spatial.js'

const fac = (over: Partial<MatchFacility> = {}): MatchFacility =>
  ({ lat: 50.0, lon: 14.0, nace4: 1011, id: 310, rank: 5, year: 2022, ...over })

// ~meters → degrees latitude at 50°N (1° lat ≈ 111.2 km)
const mLat = (m: number) => m / 111_195

const poly = (over: Partial<MatchPolygon> = {}): MatchPolygon =>
  ({ lat: 50.0, lon: 14.0, areaM2: 10_000, subtype: 0, ...over })

test('big plant beats the nearer shed (edge distance, Gemini CRITICAL case)', () => {
  const polygons = [
    poly({ lat: 50.0 + mLat(50), areaM2: 100 }),        // 10 m shed, centroid 50 m away
    poly({ lat: 50.0 + mLat(400), areaM2: 500_000 }),   // 50 ha plant, centroid 400 m away (edge ≈ 0)
  ]
  const best = bestCandidate(fac(), polygons, 2000)
  assert.equal(best!.row, 1, 'the big plant whose boundary reaches the point must win')
  assert.ok(edgeDistM(fac(), polygons[1]) < 10, 'plant boundary ≈ at the point (400 m − √(50ha/π) ≈ 1 m)')
  assert.ok(edgeDistM(fac(), polygons[0]) > 40, 'shed boundary stays ~44 m away')
})

test('farm never inherits meat processing by proximity (the York bug)', () => {
  const farm = [poly({ lat: 50.0 + mLat(300), subtype: 10, areaM2: 5_000 })]
  assert.equal(bestCandidate(fac({ nace4: 1011 }), farm, 2000), null)
  assert.ok(quietGateBlocks(10, 1011), 'farm + meat = blocked')
})

test('farm accepts a livestock facility (Annex 7 → NACE 0146) by nearest', () => {
  const farm = [poly({ lat: 50.0 + mLat(300), subtype: 10, areaM2: 5_000 })]
  const best = bestCandidate(fac({ nace4: 146 }), farm, 2000)   // 0146 → division 1
  assert.ok(best, 'agriculture NACE passes the farm gate')
})

test('the quiet gate holds even inside the polygon (HQ-address failure mode)', () => {
  // equivalent-circle "inside" is unreliable on big blobs and a registry point ON
  // an office/farm is typically a registered ADDRESS, not the plant (/gg Gemini)
  const farm = [poly({ subtype: 10, areaM2: 500_000 })]         // point at centroid of 50 ha farm
  assert.equal(bestCandidate(fac({ nace4: 1011 }), farm, 2000), null, 'farm + meat blocked even at centroid')
  assert.ok(bestCandidate(fac({ nace4: 146 }), farm, 2000), 'farm + livestock still allowed (family)')
})

test('office blocks everything outside containment; radius excludes far polygons', () => {
  assert.ok(quietGateBlocks(11, 3511))
  assert.equal(bestCandidate(fac(), [poly({ lat: 50.0 + mLat(2500) })], 2000), null)
})

test('steel polygon rejects its on-site power block, takes metallurgy (Ostrava/Nová huť, Codex CRITICAL 6)', () => {
  // A giant steel polygon (subtype 6) is the smallest edge distance for miles.
  // The on-site power facility (NACE 3511) must NOT capture it; a metallurgy
  // facility (2410) must. Rejected → the polygon keeps its steel profile.
  const steel = [poly({ subtype: 6, areaM2: 5_379_612 })]
  assert.ok(quietGateBlocks(6, 3511), 'steel + power (3511) blocked')
  assert.equal(bestCandidate(fac({ nace4: 3511 }), steel, 2000), null, 'power block cannot stamp the steelworks')
  assert.ok(!quietGateBlocks(6, 2410), 'steel + metallurgy (2410) allowed')
  assert.ok(bestCandidate(fac({ nace4: 2410 }), steel, 2000), 'metallurgy stamps the steelworks')
})

test('heavy-subtype gate: quarry/chemical/cement accept only their division; port stays open', () => {
  assert.ok(quietGateBlocks(3, 2410) && !quietGateBlocks(3, 810), 'quarry ⇐ mining 08 only')
  assert.ok(quietGateBlocks(4, 2410) && !quietGateBlocks(4, 2011), 'chemical ⇐ 19|20 only')
  assert.ok(quietGateBlocks(5, 2410) && !quietGateBlocks(5, 2351), 'cement ⇐ 23 only')
  assert.ok(!quietGateBlocks(12, 2011) && !quietGateBlocks(12, 1011), 'port not gated — hosts many sectors')
  assert.ok(!quietGateBlocks(0, 3511) && !quietGateBlocks(2, 3511), 'generic/factory still accept any NACE')
})

test('cross-hex reduce keeps exactly one winner per facility', () => {
  // simulate two hexes: caller keeps the min-edge candidate across both
  const hexA = [poly({ lat: 50.0 + mLat(900) })]
  const hexB = [poly({ lat: 50.0 + mLat(200) })]
  const a = bestCandidate(fac(), hexA, 2000)!
  const b = bestCandidate(fac(), hexB, 2000)!
  const winner = a.edge < b.edge ? { hex: 'A', ...a } : { hex: 'B', ...b }
  assert.equal(winner.hex, 'B', 'the globally nearer hex wins — one winner total')
})

test('polygon contest mirrors shouldOverwrite: rank, then year, then id, then distance', () => {
  const eprtr = { rank: 5, year: 2022, id: 310, edge: 900 }
  const gppd = { rank: 4, year: 2021, id: 300, edge: 10 }
  const gem = { rank: 4, year: 2025, id: 331, edge: 500 }
  assert.ok(contestBeats(eprtr, gppd), 'higher rank wins regardless of distance')
  assert.ok(contestBeats(gem, gppd), 'same rank → newer year wins (GEM 2025 > GPPD 2021)')
  assert.ok(contestBeats({ ...gppd, edge: 10 }, { ...gppd, edge: 20 }), 'identical source → nearer wins')
})

test('spatial.flatDist sanity: 1° latitude = the canonical 110.54 km', () => {
  assert.ok(Math.abs(flatDist(50, 14, 51, 14) - 110_540) < 1)   // spatial.ts M_PER_DEG_LAT
})
