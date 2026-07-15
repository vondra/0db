/**
 * Antimeridian regression tests for spatial.ts (2026-07-16 /gg review, item
 * F): `flatDist`/`pointToSegmentDist`/`pointToSegmentParamT` wrap the
 * longitude delta to [-180, 180] before projecting, mirroring
 * `engine/osm-extract/src/microsegment.rs::flat_dist`'s own wrap — without
 * it, two points straddling ±180° project to a ~359.8° delta instead of the
 * true ~0.2°, reporting ~40,000 km instead of ~22 km.
 *
 * Run: `cd pipeline && npx tsx --test lib/spatial.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flatDist, pointToSegmentDist, pointToSegmentParamT } from './spatial.js'

test('flatDist: 179.9° -> -179.9° is ~22 km (wrapped), not ~40,000 km (unwrapped)', () => {
  const d = flatDist(0, 179.9, 0, -179.9)
  assert.ok(d > 20_000 && d < 25_000, `expected ~22 km, got ${(d / 1000).toFixed(1)} km`)
  assert.ok(d < 1_000_000, 'must never read as ~40,000 km (the unwrapped delta)')
})

test('pointToSegmentDist: a point/segment trio straddling ±180° measures the SHORT way around', () => {
  // Segment runs from 179.995° to -179.995° (crossing the antimeridian, ~55 m
  // long); a point sitting exactly at 180°/-180° should read as ~0 m from the
  // segment's body, not a near-planet-width miss.
  const d = pointToSegmentDist(0, 180, 0, 179.995, 0, -179.995)
  assert.ok(d < 100, `expected a few metres, got ${(d / 1000).toFixed(1)} km`)
})

test('pointToSegmentParamT: a point straddling ±180° still projects to the midpoint (t≈0.5)', () => {
  const t = pointToSegmentParamT(0, 180, 0, 179.995, 0, -179.995)
  assert.ok(Math.abs(t - 0.5) < 0.01, `expected t≈0.5, got ${t}`)
})
