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
  makeTable,
  tableFromIPC,
  tableToIPC,
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
