import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ALLOWED_LAYERS } from './routes/heatmap-shared.js'
import { createReadinessCheck } from './runtime-readiness.js'

const REFERENCE_HEX = '841e309ffffffff'

async function readinessFixture() {
  const root = await mkdtemp(join(tmpdir(), '0db-ready-'))
  const sourceReaderPath = join(root, 'libsource_reader.so')
  const h3r4Dir = join(root, 'h3r4')
  const pmtilesDir = join(root, 'pmtiles')
  await mkdir(join(h3r4Dir, REFERENCE_HEX), { recursive: true })
  await mkdir(pmtilesDir, { recursive: true })
  await writeFile(sourceReaderPath, 'native-addon')
  await writeFile(join(h3r4Dir, REFERENCE_HEX, 'roads.arrow'), 'arrow-data')

  const layers: Record<string, { file: string; bytes: number }> = {}
  for (const layer of ALLOWED_LAYERS) {
    const file = `${layer}.b1.pmtiles`
    const content = `pmtiles-${layer}`
    await writeFile(join(pmtilesDir, file), content)
    layers[layer] = { file, bytes: Buffer.byteLength(content) }
  }
  await writeFile(join(pmtilesDir, 'current.json'), JSON.stringify({ build: 'b1', layers }))
  return { root, sourceReaderPath, h3r4Dir, pmtilesDir, layers }
}

test('readiness validates artifacts, single-flights, and periodically reprobes the engine', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  let engineProbes = 0
  let now = 1_000
  const check = createReadinessCheck({
    ...fixture,
    engineProbe: async () => { engineProbes++ },
    filesystemCacheMs: 0,
    engineSuccessCacheMs: 10_000,
    now: () => now,
  })

  const [first, concurrent] = await Promise.all([check(), check()])
  assert.deepEqual(first, { ready: true, failed: [], errors: {} })
  assert.deepEqual(concurrent, first)
  assert.equal(engineProbes, 1)
  assert.equal((await check()).ready, true)
  assert.equal(engineProbes, 1, 'successful probes are briefly cached')
  now += 10_001
  assert.equal((await check()).ready, true)
  assert.equal(engineProbes, 2, 'an expired probe is repeated to detect a crashed worker')
})

test('readiness rejects a PMTiles archive that disagrees with its manifest', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const total = fixture.layers.total
  await writeFile(join(fixture.pmtilesDir, total.file), 'wrong-size')

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['pmtiles'])
  assert.match(result.errors.pmtiles ?? '', /does not match manifest/)
})

test('readiness rejects a manifest file name that the tile route would not serve', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const total = fixture.layers.total
  const road = fixture.layers.road
  fixture.layers.total = { file: road.file, bytes: road.bytes }
  await writeFile(
    join(fixture.pmtilesDir, 'current.json'),
    JSON.stringify({ build: 'b1', layers: fixture.layers }),
  )

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['pmtiles'])
  assert.match(result.errors.pmtiles ?? '', /does not match the served archive name/)
  // The aliased road archive exists and has the declared size; filename-to-route
  // consistency, rather than the existing size check, must reject this manifest.
  assert.equal(total.file, 'total.b1.pmtiles')
})

test('readiness rejects a per-layer build that disagrees with its archive file', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const layers = {
    ...fixture.layers,
    total: { ...fixture.layers.total, build: 'b2' },
  }
  await writeFile(
    join(fixture.pmtilesDir, 'current.json'),
    JSON.stringify({ build: 'b2', layers }),
  )

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['pmtiles'])
  assert.match(result.errors.pmtiles ?? '', /build does not match its archive file/)
})

test('readiness accepts a consistent partial-publish manifest', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const content = 'pmtiles-total-b2'
  const file = 'total.b2.pmtiles'
  await writeFile(join(fixture.pmtilesDir, file), content)
  const layers = {
    ...fixture.layers,
    total: { file, build: 'b2', bytes: Buffer.byteLength(content) },
  }
  await writeFile(
    join(fixture.pmtilesDir, 'current.json'),
    JSON.stringify({ build: 'b2', layers }),
  )

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.deepEqual(result, { ready: true, failed: [], errors: {} })
})

test('readiness does not spawn the engine against missing prepared data', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  await rm(join(fixture.h3r4Dir, REFERENCE_HEX, 'roads.arrow'))
  let engineProbes = 0

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => { engineProbes++ },
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['prepared-data'])
  assert.equal(engineProbes, 0)
})

test('filesystem failures are retried immediately during startup', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const roadsPath = join(fixture.h3r4Dir, REFERENCE_HEX, 'roads.arrow')
  await rm(roadsPath)

  const check = createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 10_000,
  })
  assert.equal((await check()).ready, false)

  await writeFile(roadsPath, 'repaired-arrow-data')
  assert.equal((await check()).ready, true)
})
