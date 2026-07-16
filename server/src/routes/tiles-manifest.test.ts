// Contract test for GET /api/tiles-manifest — Track 2 (docs/dev/checkout-restructure-plan.md):
// the route now serves THIS environment's per-env pin (current.{TILE_ENV}.json), selected via
// the shared tile-manifest-reader.ts, instead of the packer's shared current.json merge head.
// Run: cd server && npx tsx --test src/routes/tiles-manifest.test.ts

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// PMTILES_BASE and TILE_ENV are captured from the env when heatmap-shared/tile-manifest-reader
// load — point them at the fixture dir BEFORE importing (mirrors heatmap-pmtiles.test.ts's
// pattern). TILE_ENV is fixed at 'dev1' for this whole file; every scenario below is driven by
// changing what's ON DISK in `dir`, not by re-reading env vars mid-file (module-level consts
// can't be re-evaluated once imported).
const dir = mkdtempSync(join(tmpdir(), 'tiles-manifest-route-test-'))
process.env.PMTILES_DIR = dir
process.env.TILE_ENV = 'dev1'

const { tilesManifestRoutes } = await import('./tiles-manifest.js')
const { default: Fastify } = await import('fastify')

async function buildApp() {
  const app = Fastify()
  await app.register(tilesManifestRoutes)
  return app
}

const pinPath = join(dir, 'current.dev1.json')
const legacyPath = join(dir, 'current.json')
const clearFixture = () => { for (const p of [pinPath, legacyPath]) rmSync(p, { force: true }) }

test('serves this environment pin, with tile_base attached', async () => {
  clearFixture()
  writeFileSync(pinPath, JSON.stringify({ build: 'b3', layers: { total: { file: 'total.b3.pmtiles' } } }))
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    build: 'b3',
    layers: { total: { file: 'total.b3.pmtiles' } },
    tile_base: null,
  })
  assert.equal(res.headers['cache-control'], 'no-cache')
  await app.close()
})

test('a genuinely fresh checkout (no pin, no legacy manifest) is a 404, not a 500', async () => {
  clearFixture()
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'no build published' })
  await app.close()
})

test('an un-seeded checkout (legacy current.json but no per-env pin) is a 500, never a silent fallback to the legacy build', async () => {
  clearFixture()
  writeFileSync(legacyPath, JSON.stringify({ build: 'b1', layers: { total: { file: 'total.b1.pmtiles' } } }))
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'manifest unreadable' })
  assert.doesNotMatch(res.body, /b1|total\.b1/, 'must never leak the legacy build it refused to serve')
  await app.close()
})

test('a torn/unparseable pin is a 500', async () => {
  clearFixture()
  writeFileSync(pinPath, '{ not json')
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'manifest unreadable' })
  await app.close()
})
