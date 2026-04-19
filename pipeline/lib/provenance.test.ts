/**
 * Tests for enrichment dataset registry + provenance helpers.
 * Run: `npx tsx --test pipeline/lib/provenance.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DATASETS,
  DATASETS_BY_ID,
  DATASETS_BY_KEY,
} from './enrichment-datasets.js'
import {
  shouldOverwrite,
  updateRow,
  withArrowWrite,
} from './provenance.js'
import {
  makeTable,
  tableFromIPC,
  tableToIPC,
} from 'apache-arrow'

// ─── Registry integrity ─────────────────────────────────────────────────────

test('DATASETS has no duplicate ids', () => {
  const seen = new Set<number>()
  for (const d of DATASETS) {
    assert.ok(!seen.has(d.id), `duplicate id=${d.id} (${d.key})`)
    seen.add(d.id)
  }
})

test('DATASETS has no duplicate keys', () => {
  const seen = new Set<string>()
  for (const d of DATASETS) {
    assert.ok(!seen.has(d.key), `duplicate key=${d.key} (id=${d.id})`)
    seen.add(d.key)
  }
})

test('id=0 reserved for the unspecified sentinel', () => {
  const zero = DATASETS_BY_ID.get(0)
  assert.ok(zero, 'id=0 must exist')
  assert.strictEqual(zero.key, 'unspecified')
  assert.strictEqual(zero.priority, 0)
})

test('lookup maps stay in sync with DATASETS', () => {
  assert.strictEqual(DATASETS_BY_ID.size, DATASETS.length)
  assert.strictEqual(DATASETS_BY_KEY.size, DATASETS.length)
})

// ─── shouldOverwrite ────────────────────────────────────────────────────────
// Real registry entries: 0=unspecified(0), 10=eu-city-traffic(50), 20=cz-rsd(80),
// 22=de-bast-autobahn(80), 23=de-bast-bundes(80)

test('shouldOverwrite: empty slot (existing=0) always wins', () => {
  assert.strictEqual(shouldOverwrite(0, 10), true)
  assert.strictEqual(shouldOverwrite(0, 20), true)
})

test('shouldOverwrite: idempotent when existing === self', () => {
  assert.strictEqual(shouldOverwrite(10, 10), true)
  assert.strictEqual(shouldOverwrite(20, 20), true)
})

test('shouldOverwrite: higher priority wins', () => {
  assert.strictEqual(shouldOverwrite(10, 20), true)   // rsd(80) beats eu-city(50)
  assert.strictEqual(shouldOverwrite(20, 10), false)  // eu-city(50) loses
})

test('shouldOverwrite: tie broken by larger id (deterministic)', () => {
  assert.strictEqual(shouldOverwrite(22, 23), true)
  assert.strictEqual(shouldOverwrite(23, 22), false)
})

test('shouldOverwrite: unknown existing id treated as overwriteable', () => {
  assert.strictEqual(shouldOverwrite(65535, 10), true)
})

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
      roads_dataset_id: new Uint16Array([0, 0, 0, 0, 0]),
    })
    await fs.writeFile(arrowPath, Buffer.from(tableToIPC(initial, 'file')))

    await withArrowWrite(arrowPath, t => {
      const values = t.getChild('value')!.toArray() as Int32Array
      return makeTable({
        value: new Int32Array(values),
        roads_dataset_id: new Uint16Array([10, 10, 10, 10, 10]),
      })
    })

    const reread = tableFromIPC(await fs.readFile(arrowPath))
    const ids = Array.from(reread.getChild('roads_dataset_id')!.toArray() as Uint16Array)
    assert.deepStrictEqual(ids, [10, 10, 10, 10, 10])
  } finally {
    await fs.rm(tmpDir, { recursive: true })
  }
})

