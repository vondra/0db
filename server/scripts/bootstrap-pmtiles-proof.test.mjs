import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapPublisherProofs } from './bootstrap-pmtiles-proof.mjs'

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
