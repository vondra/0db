import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ALLOWED_LAYERS } from './routes/heatmap-shared.js'
import { createReadinessCheck } from './runtime-readiness.js'

const REFERENCE_HEX = '841e309ffffffff'
// This checkout's own env for the fixture — arbitrary but fixed, so every test that rewrites
// the manifest writes to the SAME per-env pointer the readiness check under test also reads
// (docs/dev/checkout-restructure-plan.md Track 2: current.{TILE_ENV}.json, not the shared
// current.json merge head).
const TEST_TILE_ENV = 'dev2'

async function publisherProof(path: string, sha256: string) {
  const info = await stat(path, { bigint: true })
  return {
    schema: 'sha256-posix-stat-v1',
    sha256,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtime_ns: info.mtimeNs.toString(),
    ctime_ns: info.ctimeNs.toString(),
  }
}

async function readinessFixture() {
  const root = await mkdtemp(join(tmpdir(), '0db-ready-'))
  const sourceReaderPath = join(root, 'libsource_reader.so')
  const frontendDist = join(root, 'frontend')
  const h3r4Dir = join(root, 'h3r4')
  const pmtilesDir = join(root, 'pmtiles')
  await mkdir(join(h3r4Dir, REFERENCE_HEX), { recursive: true })
  await mkdir(pmtilesDir, { recursive: true })
  await mkdir(frontendDist, { recursive: true })
  await writeFile(sourceReaderPath, 'native-addon')
  await writeFile(join(frontendDist, 'index.html'), '<!doctype html><title>map</title>')
  await writeFile(join(h3r4Dir, REFERENCE_HEX, 'roads.arrow'), 'arrow-data')

  const layers: Record<string, {
    file: string
    bytes: number
    sha256: string
    publisher_proof: Awaited<ReturnType<typeof publisherProof>>
  }> = {}
  for (const layer of ALLOWED_LAYERS) {
    const file = `${layer}.b1.pmtiles`
    const content = `pmtiles-${layer}`
    await writeFile(join(pmtilesDir, file), content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    layers[layer] = {
      file,
      bytes: Buffer.byteLength(content),
      sha256,
      publisher_proof: await publisherProof(join(pmtilesDir, file), sha256),
    }
  }
  await writeFile(join(pmtilesDir, `current.${TEST_TILE_ENV}.json`), JSON.stringify({ build: 'b1', layers }))
  return { root, sourceReaderPath, frontendDist, h3r4Dir, pmtilesDir, layers, tileEnv: TEST_TILE_ENV }
}

test('readiness rejects a release whose static root is missing the SPA', async (t) => {
  // 2026-07-19: a frontend-less release served 404 on every page while /api/ready
  // reported healthy and start.sh activated it. The frontend gate locks that hole.
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  await rm(join(fixture.frontendDist, 'index.html'))

  const missing = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.failed, ['frontend'])
  assert.match(missing.errors.frontend ?? '', /index\.html/)

  // An EMPTY index.html is just as broken (a truncated frontend copy).
  await writeFile(join(fixture.frontendDist, 'index.html'), '')
  const empty = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(empty.ready, false)
  assert.deepEqual(empty.failed, ['frontend'])
})

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
  fixture.layers.total = { ...road }
  await writeFile(
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
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
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
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
    total: {
      file,
      build: 'b2',
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      publisher_proof: await publisherProof(
        join(fixture.pmtilesDir, file),
        createHash('sha256').update(content).digest('hex'),
      ),
    },
  }
  await writeFile(
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
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

// The readiness contract was RELAXED on purpose (owner call, 2026-07-15): the boot-time
// stat-identity gate (dev/ino/ctime vs the publisher proof) caught zero real faults in
// production and broke the first deploy after a PLANNED storage move (Track D: every
// archive's inode changed, readiness went permanently red, release activation blocked).
// Content integrity belongs to pack-time validation, fsck and --rebind-verified; boot-time
// readiness keeps only the cheap operational invariants (manifest coherence + exact size).
// These tests LOCK IN the relaxation so a future "harden readiness" pass can't quietly
// re-introduce the planned-maintenance foot-gun without meeting this decision record.
test('readiness ACCEPTS a same-size archive replacement — identity is deliberately not verified at boot', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const total = fixture.layers.total
  const archivePath = join(fixture.pmtilesDir, total.file)
  const replacement = join(fixture.pmtilesDir, '.replacement.pmtiles')
  await writeFile(replacement, 'pmtiles-total')
  await rename(replacement, archivePath)

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, true)
})

test('readiness still rejects a malformed manifest sha256, but ignores proof mutations', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  const total = fixture.layers.total
  const goodSha256 = total.sha256
  total.sha256 = 'NOT-A-SHA'
  await writeFile(
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
    JSON.stringify({ build: 'b1', layers: fixture.layers }),
  )
  const badManifest = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(badManifest.ready, false)
  assert.match(badManifest.errors.pmtiles ?? '', /invalid sha256/)

  total.sha256 = goodSha256
  total.publisher_proof.sha256 = '0'.repeat(64)   // stale proof — boot-time readiness must not care
  await writeFile(
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
    JSON.stringify({ build: 'b1', layers: fixture.layers }),
  )
  const staleProof = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(staleProof.ready, true)
})

test('readiness never opens PMTiles archive content (stat-only, always)', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  for (const entry of Object.values(fixture.layers)) {
    const archivePath = join(fixture.pmtilesDir, entry.file)
    await chmod(archivePath, 0o000)
    entry.publisher_proof = await publisherProof(archivePath, entry.sha256)
  }
  await writeFile(
    join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`),
    JSON.stringify({ build: 'b1', layers: fixture.layers }),
  )
  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.deepEqual(result, { ready: true, failed: [], errors: {} })
})

// Track 2 (docs/dev/checkout-restructure-plan.md): readiness now gates on THIS deployment's
// own per-environment pin (current.{TILE_ENV}.json), selected via the shared
// tile-manifest-reader.ts, rather than the packer's shared current.json merge head.

test('readiness fails closed on a missing/unrecognized TILE_ENV', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))

  const missing = await createReadinessCheck({
    ...fixture,
    tileEnv: '',
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.failed, ['pmtiles'])
  assert.match(missing.errors.pmtiles ?? '', /TILE_ENV must be one of/)

  const bogus = await createReadinessCheck({
    ...fixture,
    tileEnv: 'staging',
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(bogus.ready, false)
  assert.match(bogus.errors.pmtiles ?? '', /TILE_ENV must be one of/)
})

test('readiness fails closed when this env pin is missing but a legacy current.json exists (un-seeded rollout)', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  // Simulate a checkout mid-Track-2-rollout: the per-env pin was never seeded, but the OLD
  // shared current.json is still sitting there from before the cutover.
  await rm(join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`))
  await writeFile(join(fixture.pmtilesDir, 'current.json'), JSON.stringify({ build: 'b1', layers: fixture.layers }))

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['pmtiles'])
  assert.match(result.errors.pmtiles ?? '', /legacy current\.json exists/)
  assert.match(result.errors.pmtiles ?? '', /seed it/)
})

test('readiness treats a genuinely fresh checkout (neither pin nor legacy manifest) as ordinary not-ready', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  await rm(join(fixture.pmtilesDir, `current.${fixture.tileEnv}.json`))

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(result.ready, false)
  assert.deepEqual(result.failed, ['pmtiles'])
  assert.doesNotMatch(result.errors.pmtiles ?? '', /seed it/, 'a fresh checkout is not a seeding error')
})

test('readiness reads THIS environment pin, never the legacy current.json, when both exist', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  // A stale/foreign legacy current.json sitting next to a valid per-env pin must be
  // completely ignored — this is the exact drift Track 2 exists to prevent (prod must never
  // read what dev's shared merge head happens to say).
  await writeFile(join(fixture.pmtilesDir, 'current.json'), 'not even valid JSON')

  const result = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.deepEqual(result, { ready: true, failed: [], errors: {} })
})

test('readiness is independent across two environments sharing one pmtiles dir', async (t) => {
  const fixture = await readinessFixture()
  t.after(async () => rm(fixture.root, { recursive: true, force: true }))
  // A second environment pin, deliberately broken, must not affect THIS environment's result
  // — each `current.{env}.json` is read in total isolation from every other one.
  await writeFile(join(fixture.pmtilesDir, 'current.prod.json'), '{ not json')

  const thisEnv = await createReadinessCheck({
    ...fixture,
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.deepEqual(thisEnv, { ready: true, failed: [], errors: {} })

  const otherEnv = await createReadinessCheck({
    ...fixture,
    tileEnv: 'prod',
    engineProbe: async () => {},
    filesystemCacheMs: 0,
  })()
  assert.equal(otherEnv.ready, false)
  assert.deepEqual(otherEnv.failed, ['pmtiles'])
})
