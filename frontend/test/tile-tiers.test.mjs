import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildKey,
  hasTierCoverage,
  resolveTileFetch,
  tileCentreR4,
  tierTokenFor,
} from '../src/lib/tile-urls.ts'

// Coverage rule anchor: tileCentreR4 must match the ENGINE's
// region_runner::tile_centre_r4 (arithmetic mean of the tile bbox lat/lon,
// then H3 res 4). These reference cells pin the port — a different centre
// definition would create false-positive coverage and render authoritative
// silence over real z12 data (gg z13 review, Codex #5).
test('tileCentreR4 matches the engine centre rule on reference tiles', () => {
  // z12 Praha tile (Ruzyně R4) and its four z13 children.
  assert.equal(tileCentreR4(12, 2212, 1387), '841e355ffffffff')
  assert.equal(tileCentreR4(13, 4424, 2774), '841e355ffffffff')
  assert.equal(tileCentreR4(13, 4425, 2775), '841e355ffffffff')
  // Ávila (the repo's second reference area).
  assert.equal(tileCentreR4(13, 3958, 3115), '8439003ffffffff')
})

function buildsWith(packs) {
  return {
    latest: 'b16',
    byLayer: { road: 'b16', 'road-z13-p001': 'b17', 'total-z13-p001': 'b17' },
    base: '',
    tiers: packs ? { z13: packs } : {},
  }
}

const PACK = {
  pack: 'p001',
  coverage: new Set(['841e355ffffffff']),
  layers: new Set(['road-z13-p001', 'total-z13-p001']),
}

test('tierTokenFor: covered tile resolves to the pack token, uncovered to null', () => {
  const builds = buildsWith([PACK])
  assert.equal(tierTokenFor(builds, 'road', 13, 4424, 2774), 'road-z13-p001')
  // Ávila is not in coverage.
  assert.equal(tierTokenFor(builds, 'road', 13, 3958, 3115), null)
  // A layer the pack does not carry never resolves.
  assert.equal(tierTokenFor(builds, 'rail', 13, 4424, 2774), null)
})

test('last pack containing an R4 owns it (append-order supersession)', () => {
  const p2 = {
    pack: 'p002',
    coverage: new Set(['841e355ffffffff']),
    layers: new Set(['road-z13-p002']),
  }
  const builds = buildsWith([PACK, p2])
  assert.equal(tierTokenFor(builds, 'road', 13, 4424, 2774), 'road-z13-p002')
})

test('resolveTileFetch: base band → url; covered z13 → native pack url; uncovered → parent quadrant', () => {
  const builds = buildsWith([PACK])
  assert.deepEqual(resolveTileFetch(builds, 'road', 12, 2212, 1387), {
    url: '/api/tiles/b16/road/12/2212/1387.bin',
  })
  assert.deepEqual(resolveTileFetch(builds, 'road', 13, 4424, 2774), {
    url: '/api/tiles/b17/road-z13-p001/13/4424/2774.bin',
  })
  // Uncovered z13 tile falls back to its z12 parent + quadrant.
  assert.deepEqual(resolveTileFetch(builds, 'road', 13, 3959, 3114), {
    parentUrl: '/api/tiles/b16/road/12/1979/1557.bin',
    quadrant: { dx: 1, dy: 0 },
  })
})

test('buildKey folds tier packs in; no tiers keeps the legacy shape', () => {
  const none = buildsWith(null)
  assert.equal(buildKey(none, ['road']), 'road:b16')
  assert.equal(hasTierCoverage(none, 'z13'), false)
  const tiered = buildsWith([PACK])
  assert.equal(buildKey(tiered, ['road']), 'road:b16|tiers:z13[p001]')
  assert.equal(hasTierCoverage(tiered, 'z13'), true)
})
