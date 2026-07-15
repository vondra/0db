import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapPublisherProofs, rebindVerifiedProofs } from './bootstrap-pmtiles-proof.mjs'

test('legacy publisher proof bootstrap is explicit, atomic and stat-bound', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '0db-pmtiles-proof-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  const content = 'immutable-pmtiles'
  const file = 'total.b1.pmtiles'
  await writeFile(join(root, file), content)
  const manifest = Buffer.from(JSON.stringify({
    build: 'b1',
    created_unix: Math.floor(Date.now() / 1000),
    layers: {
      total: {
        file,
        bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    },
  }))
  await writeFile(join(root, 'current.json'), manifest)
  const expected = createHash('sha256').update(manifest).digest('hex')

  const result = await bootstrapPublisherProofs(root, expected)
  assert.equal(result.before, expected)
  const published = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  assert.equal(published.layers.total.publisher_proof.schema, 'sha256-posix-stat-v1')
  assert.equal(published.layers.total.publisher_proof.sha256, published.layers.total.sha256)
  assert.equal(published.layers.total.publisher_proof.size, String(Buffer.byteLength(content)))
  assert.match(published.layers.total.publisher_proof.ino, /^[0-9]+$/)
})

test('legacy publisher proof bootstrap rejects a stale expected manifest hash', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '0db-pmtiles-proof-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'current.json'), '{}')
  await assert.rejects(
    bootstrapPublisherProofs(root, '0'.repeat(64)),
    /current\.json changed/,
  )
})

// Helper for the rebind tests: a manifest whose proof identity is deliberately
// WRONG (simulating a whole-archive move — new dev/ino/ctime, same bytes; the
// 2026-07-15 incident: readiness hard-failed after the Track D /data2→/data1
// relocation because rsync preserves content+mtime but identity changes).
async function movedArchiveFixture(root, content) {
  const file = 'total.b1.pmtiles'
  await writeFile(join(root, file), content)
  const info = await stat(join(root, file), { bigint: true })
  const sha256 = createHash('sha256').update(content).digest('hex')
  const manifest = {
    build: 'b1',
    created_unix: Math.floor(Date.now() / 1000),
    layers: {
      total: {
        file,
        bytes: Buffer.byteLength(content),
        sha256,
        publisher_proof: {
          schema: 'sha256-posix-stat-v1',
          sha256,
          dev: String(info.dev + 1n),          // pre-move device
          ino: String(info.ino + 1n),          // pre-move inode
          size: info.size.toString(),
          mtime_ns: info.mtimeNs.toString(),
          ctime_ns: String(info.ctimeNs - 1n), // pre-move ctime
        },
      },
    },
  }
  await writeFile(join(root, 'current.json'), JSON.stringify(manifest))
  return { file, sha256 }
}

test('rebind-verified re-hashes content and stamps the moved archive\'s fresh identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '0db-pmtiles-rebind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { file, sha256 } = await movedArchiveFixture(root, 'immutable-pmtiles-moved')

  await rebindVerifiedProofs(root)
  const published = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  const now = await stat(join(root, file), { bigint: true })
  const proof = published.layers.total.publisher_proof
  assert.equal(proof.sha256, sha256)
  assert.equal(proof.dev, now.dev.toString())
  assert.equal(proof.ino, now.ino.toString())
  assert.equal(proof.ctime_ns, now.ctimeNs.toString())
})

test('rebind-verified REFUSES an archive whose content no longer matches the manifest sha256', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '0db-pmtiles-rebind-tamper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { file } = await movedArchiveFixture(root, 'immutable-pmtiles-moved')
  // SAME byte length on purpose: a size mismatch is caught by the cheaper size
  // check; this test must prove the full content re-hash catches a same-size swap.
  await writeFile(join(root, file), 'TAMPERED!-pmtiles-moved')

  await assert.rejects(rebindVerifiedProofs(root), /REFUSING to re-bind a changed archive/)
  // The manifest must be untouched after a refusal.
  const manifest = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  assert.notEqual(manifest.layers.total.publisher_proof.ino, (await stat(join(root, file), { bigint: true })).ino.toString())
})

test('rebind-verified refuses a manifest that never had proofs (legacy mode\'s job)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '0db-pmtiles-rebind-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const content = 'immutable-pmtiles'
  const file = 'total.b1.pmtiles'
  await writeFile(join(root, file), content)
  await writeFile(join(root, 'current.json'), JSON.stringify({
    build: 'b1',
    created_unix: Math.floor(Date.now() / 1000),
    layers: { total: { file, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } },
  }))
  await assert.rejects(rebindVerifiedProofs(root), /no consistent publisher_proof/)
})
