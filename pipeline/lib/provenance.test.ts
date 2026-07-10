/**
 * Tests for the write-side helpers in provenance.ts.
 *
 * Registry integrity and shouldOverwrite semantics are tested in
 * sources.test.ts; this file covers only `updateRow` and `withArrowWrite`.
 *
 * Run: `npx tsx --test pipeline/lib/provenance.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Field,
  Int32,
  RecordBatch,
  Schema,
  Table,
  Uint16,
  makeTable,
  makeVector,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow'
import { updateRow, withArrowWrite } from './provenance.js'

// ─── updateRow ──────────────────────────────────────────────────────────────

test('updateRow: calls writePayload + returns true when self wins', () => {
  let wrote = false
  const r = updateRow(0, 10, () => {
    wrote = true
  })
  assert.strictEqual(r, true)
  assert.strictEqual(wrote, true)
})

test('updateRow: skips writePayload + returns false when self loses', () => {
  let wrote = false
  const r = updateRow(20, 10, () => {
    wrote = true
  })
  assert.strictEqual(r, false)
  assert.strictEqual(wrote, false)
})

// ─── withArrowWrite ─────────────────────────────────────────────────────────

test('withArrowWrite round-trips a table and atomically replaces it', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arrow-prov-'))
  const arrowPath = path.join(tmpDir, 'test.arrow')
  try {
    const initial = makeTable({
      value: new Int32Array([1, 2, 3, 4, 5]),
      source_id: new Uint16Array([0, 0, 0, 0, 0]),
    })
    await fs.writeFile(arrowPath, Buffer.from(tableToIPC(initial, 'file')))

    await withArrowWrite(arrowPath, t => {
      const values = t.getChild('value')!.toArray() as Int32Array
      return makeTable({
        value: new Int32Array(values),
        source_id: new Uint16Array([10, 10, 10, 10, 10]),
      })
    })

    const reread = tableFromIPC(await fs.readFile(arrowPath))
    const ids = Array.from(reread.getChild('source_id')!.toArray() as Uint16Array)
    assert.deepStrictEqual(ids, [10, 10, 10, 10, 10])
  } finally {
    await fs.rm(tmpDir, { recursive: true })
  }
})

// ─── withArrowWrite shape preservation (popup batch pruning) ────────────────
// docs/dev/popup-batch-pruning.md: a bare-makeTable callback must not destroy
// schema metadata (contract stamps) nor collapse the extractors' record-batch
// boundaries; a stale qm_batch_bboxes must be DELETED when the shape changed.

/** Two-batch fixture (rows 0..5 | 6..9) with contract + qm_batch_bboxes. */
async function writeTwoBatchFixture(arrowPath: string): Promise<void> {
  const schema = new Schema(
    [
      new Field('id', new Int32(), false),
      new Field('source_id', new Uint16(), false),
    ],
    new Map([
      ['test_contract', 'v1'],
      ['qm_batch_bboxes', '[[50,14,50.05,14.1],[50.05,14.1,50.1,14.2]]'],
    ]),
  )
  const bare = makeTable({
    id: vectorFromArray(Array.from({ length: 10 }, (_, i) => i), new Int32()),
    source_id: vectorFromArray(new Array(10).fill(0), new Uint16()),
  })
  const full = new Table(schema, bare.batches.map(b => new RecordBatch(schema, b.data)))
  const twoBatches = new Table(schema, [
    ...full.slice(0, 6).batches.map(b => new RecordBatch(schema, b.data)),
    ...full.slice(6, 10).batches.map(b => new RecordBatch(schema, b.data)),
  ])
  await fs.writeFile(arrowPath, Buffer.from(tableToIPC(twoBatches, 'file')))
}

test('withArrowWrite: bare-makeTable patch keeps metadata, batches, qm key', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arrow-prov-'))
  const arrowPath = path.join(tmpDir, 'patch.arrow')
  try {
    await writeTwoBatchFixture(arrowPath)

    await withArrowWrite(arrowPath, table => {
      const n = table.numRows
      const src = new Uint16Array(n).fill(7)
      // Deliberately the buggy idiom the enrichers use: bare makeTable —
      // drops metadata and collapses chunks; withArrowWrite must restore both.
      return makeTable({
        id: table.getChild('id')!,
        source_id: makeVector(src),
      } as never) as unknown as Table
    })

    const out = tableFromIPC(await fs.readFile(arrowPath))
    assert.strictEqual(out.numRows, 10)
    assert.strictEqual(out.batches.length, 2, 'batch boundaries restored')
    assert.strictEqual(out.batches[0].numRows, 6)
    assert.strictEqual(out.schema.metadata.get('test_contract'), 'v1', 'contract survived')
    assert.strictEqual(
      out.schema.metadata.get('qm_batch_bboxes'),
      '[[50,14,50.05,14.1],[50.05,14.1,50.1,14.2]]',
      'bboxes survived a shape-preserving patch',
    )
    assert.strictEqual(out.getChild('source_id')!.get(3), 7, 'patch applied')
  } finally {
    await fs.rm(tmpDir, { recursive: true })
  }
})

test('withArrowWrite: row-count change deletes stale qm_batch_bboxes, keeps contract', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arrow-prov-'))
  const arrowPath = path.join(tmpDir, 'reshape.arrow')
  try {
    await writeTwoBatchFixture(arrowPath)

    await withArrowWrite(arrowPath, table => {
      const keep = table.slice(0, 9) // drops a row → any bbox map is stale
      return makeTable({
        id: keep.getChild('id')!,
        source_id: keep.getChild('source_id')!,
      } as never) as unknown as Table
    })

    const out = tableFromIPC(await fs.readFile(arrowPath))
    assert.strictEqual(out.numRows, 9)
    assert.strictEqual(out.schema.metadata.get('test_contract'), 'v1')
    assert.strictEqual(
      out.schema.metadata.get('qm_batch_bboxes'),
      undefined,
      'stale bboxes deleted',
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true })
  }
})
