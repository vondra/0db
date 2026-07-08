// Unit tests for the shared heatmap tile-route validation.
// Run: cd server && npx tsx --test src/routes/heatmap-shared.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_LAYERS, parseTileParams } from './heatmap-shared.js'

test('accepts every allowed layer at a valid z/x/y', () => {
  for (const layer of ALLOWED_LAYERS) {
    assert.deepEqual(
      parseTileParams({ layer, z: '6', x: '33', y: '21' }),
      { layer, z: 6, x: 33, y: 21 },
    )
  }
})

test('rejects unknown layers with the allowlist message', () => {
  const err = parseTileParams({ layer: 'lava', z: '6', x: '0', y: '0' })
  assert.equal(typeof err, 'string')
  assert.match(err as string, /^layer must be one of /)
})

test('rejects out-of-range and non-integer zoom', () => {
  for (const z of ['2', '14', '6.5', 'abc', '']) {
    assert.equal(parseTileParams({ layer: 'total', z, x: '0', y: '0' }), 'bad zoom')
  }
  // Bounds themselves are valid.
  assert.deepEqual(parseTileParams({ layer: 'total', z: '3', x: '0', y: '0' }), { layer: 'total', z: 3, x: 0, y: 0 })
  assert.deepEqual(parseTileParams({ layer: 'total', z: '13', x: '0', y: '0' }), { layer: 'total', z: 13, x: 0, y: 0 })
})

test('bounds x and y by 2^z', () => {
  assert.equal(parseTileParams({ layer: 'road', z: '6', x: '64', y: '0' }), 'bad x')
  assert.equal(parseTileParams({ layer: 'road', z: '6', x: '-1', y: '0' }), 'bad x')
  assert.equal(parseTileParams({ layer: 'road', z: '6', x: '3.5', y: '0' }), 'bad x')
  assert.equal(parseTileParams({ layer: 'road', z: '6', x: '0', y: '64' }), 'bad y')
  assert.equal(parseTileParams({ layer: 'road', z: '6', x: '0', y: '-1' }), 'bad y')
  assert.deepEqual(
    parseTileParams({ layer: 'road', z: '6', x: '63', y: '63' }),
    { layer: 'road', z: 6, x: 63, y: 63 },
  )
})
