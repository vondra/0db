// Zoom-tier serving contract (city-z13 plan §D): the token grammar, the
// per-tier zoom bound, and the tiers-index referential validation — the
// server side is the contract most likely to rot (the Rust packer and the
// frontend resolver both carry their own tests; gg z13 impl review, Kimi #6).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseTierToken, parseTileParams } from './heatmap-shared.js'
import { validateTiersIndex, type PmtilesManifest } from '../runtime-readiness.js'

test('parseTierToken accepts canonical tokens and rejects near-misses', () => {
  assert.deepEqual(parseTierToken('road-z13-p001'), { base: 'road', tier: 13, pack: 'p001' })
  assert.deepEqual(parseTierToken('aircraft-ground-z14-p2'), {
    base: 'aircraft-ground', tier: 14, pack: 'p2',
  })
  assert.equal(parseTierToken('road'), null, 'base names are not tokens')
  assert.equal(parseTierToken('road-z12-p1'), null, 'z12 is the base band')
  assert.equal(parseTierToken('road-z013-p1'), null, 'non-canonical zoom digits (Rust lockstep)')
  assert.equal(parseTierToken('bogus-z13-p1'), null, 'unknown base layer')
  assert.equal(parseTierToken('road-z13-q1'), null, 'pack id must be p<N>')
})

test('tile params: base band keeps 2..12, a tier token serves EXACTLY its zoom', () => {
  assert.deepEqual(parseTileParams({ layer: 'road', z: '12', x: '2212', y: '1387' }),
    { layer: 'road', z: 12, x: 2212, y: 1387 })
  assert.equal(typeof parseTileParams({ layer: 'road', z: '13', x: '0', y: '0' }), 'string',
    'base layer refuses z13')
  assert.deepEqual(parseTileParams({ layer: 'road-z13-p001', z: '13', x: '4424', y: '2774' }),
    { layer: 'road-z13-p001', z: 13, x: 4424, y: 2774 })
  assert.equal(typeof parseTileParams({ layer: 'road-z13-p001', z: '12', x: '0', y: '0' }), 'string',
    'tier token refuses the base band')
})

function tieredManifest(overrides: Record<string, unknown> = {}): PmtilesManifest {
  return {
    build: 'b17',
    layers: {
      'road-z13-p001': { file: 'road-z13-p001.b17.pmtiles' },
    },
    tiers: {
      z13: {
        packs: [{
          pack: 'p001',
          coverage_r4: ['841e355ffffffff'],
          layers: ['road-z13-p001'],
        }],
      },
    },
    ...overrides,
  } as PmtilesManifest
}

test('validateTiersIndex: a well-formed index passes; absence passes', () => {
  validateTiersIndex(tieredManifest(), 'current.test.json')
  validateTiersIndex({ build: 'b1', layers: {} } as PmtilesManifest, 'current.test.json')
})

test('validateTiersIndex fails closed on every torn shape', () => {
  const bad = (mutate: (manifest: PmtilesManifest) => void, why: string) => {
    const manifest = tieredManifest()
    mutate(manifest)
    assert.throws(() => validateTiersIndex(manifest, 'current.test.json'), why)
  }
  bad((m) => { (m.tiers as Record<string, unknown>).z12 = { packs: [] } }, 'z12 is not a tier')
  bad((m) => { tierPack(m).pack = 'P001' }, 'non-canonical pack id')
  bad((m) => { tierPack(m).coverage_r4 = [] }, 'empty coverage')
  bad((m) => { tierPack(m).coverage_r4 = ['851e355ffffffff'] }, 'not a res-4 id shape')
  bad((m) => { tierPack(m).layers = ['road-z13-p002'] }, 'foreign pack token')
  bad((m) => { tierPack(m).layers = ['road-z14-p001'] }, 'foreign zoom token')
  bad((m) => { delete (m.layers as Record<string, unknown>)['road-z13-p001'] },
    'token without a layers entry')
  bad((m) => {
    (m.tiers as Record<string, { packs: unknown[] }>).z13.packs.push({
      pack: 'p001', coverage_r4: ['841e309ffffffff'], layers: ['road-z13-p001'],
    })
  }, 'duplicate pack id')
})

function tierPack(manifest: PmtilesManifest): {
  pack: string
  coverage_r4: string[]
  layers: string[]
} {
  return (manifest.tiers as Record<string, { packs: Array<{
    pack: string; coverage_r4: string[]; layers: string[]
  }> }>).z13.packs[0]
}
