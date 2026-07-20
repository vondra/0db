// Contract test for GET /api/tiles-manifest — Track 2 (docs/dev/checkout-restructure-plan.md):
// the route now serves THIS environment's per-env pin (current.{TILE_ENV}.json), selected via
// the shared tile-manifest-reader.ts, instead of the packer's shared current.json merge head.
// Run: cd server && npx tsx --test src/routes/tiles-manifest.test.ts

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const { ALLOWED_LAYERS } = await import('./heatmap-shared.js')
const { default: Fastify } = await import('fastify')

async function buildApp() {
  const app = Fastify()
  await app.register(tilesManifestRoutes)
  return app
}

const pinPath = join(dir, 'current.dev1.json')
const legacyPath = join(dir, 'current.json')
const clearFixture = () => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true, recursive: true })
}
function validManifest(build = 'b3') {
  const layers: Record<string, { file: string; build: string; bytes: number; sha256: string }> = {}
  for (const layer of ALLOWED_LAYERS) {
    const file = `${layer}.${build}.pmtiles`
    const content = `archive-${layer}-${build}`
    writeFileSync(join(dir, file), content)
    layers[layer] = {
      file,
      build,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  }
  return { build, layers }
}

test('serves this environment pin, with tile_base attached', async () => {
  clearFixture()
  writeFileSync(pinPath, JSON.stringify(validManifest('b3')))
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().build, 'b3')
  assert.equal(res.json().layers.total.file, 'total.b3.pmtiles')
  assert.equal(res.json().tile_base, null)
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

test('a parseable but readiness-invalid pin is a 500, never served to a goal', async () => {
  clearFixture()
  const manifest = validManifest('b4')
  delete manifest.layers.road
  writeFileSync(pinPath, JSON.stringify(manifest))
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'manifest unreadable' })
  await app.close()
})

test('a present pin that references a missing archive is corruption (500), not no-build (404)', async () => {
  clearFixture()
  const manifest = validManifest('b5')
  rmSync(join(dir, manifest.layers.road.file))
  writeFileSync(pinPath, JSON.stringify(manifest))
  const app = await buildApp()
  const res = await app.inject('/api/tiles-manifest')
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'manifest unreadable' })
  await app.close()
})

test('the pin cache revalidates immutable archives after its short TTL', async () => {
  clearFixture()
  const manifest = validManifest('b6')
  writeFileSync(pinPath, JSON.stringify(manifest))
  const app = await buildApp()
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    assert.equal((await app.inject('/api/tiles-manifest')).statusCode, 200)
    rmSync(join(dir, manifest.layers.road.file))
    assert.equal((await app.inject('/api/tiles-manifest')).statusCode, 200)
    now += 10_001
    assert.equal((await app.inject('/api/tiles-manifest')).statusCode, 500)
  } finally {
    Date.now = realNow
    await app.close()
  }
})
