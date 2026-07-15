/**
 * Tests for `collectRailEndpointRows`/`loadRailStopsIndex` (rail-endpoint-rows.ts)
 * — 2026-07-16 /gg review item 8 (never-enriched hexes must NOT be skipped)
 * and item 12 (sidecar-load visibility logging).
 *
 * Run: `cd pipeline && npx tsx --test lib/rail-endpoint-rows.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Table, vectorFromArray, tableToIPC, Float64, Uint8, Uint16 } from 'apache-arrow'
import { collectRailEndpointRows, loadRailStopsIndex } from './rail-endpoint-rows.js'

const TMP = mkdtempSync(join(tmpdir(), 'rail-endpoint-rows-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** Arrow columns needed for the CORE_COLUMNS check plus optional
 *  trains_passenger/trains_freight — omitting `withTrainCols` reproduces a
 *  hex that was extracted but never rail-enriched. */
function writeHex(dir: string, hex: string, opts: { withTrainCols: boolean; omitCoreColumn?: string }): string {
  const hexDir = resolve(dir, hex)
  mkdirSync(hexDir, { recursive: true })
  const n = 2
  const idx = [...Array(n).keys()]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Vector record
  const cols: Record<string, any> = {
    rail_type: vectorFromArray(idx.map(() => 0), new Uint8()),
    usage: vectorFromArray(idx.map(() => 0), new Uint8()),
    service: vectorFromArray(idx.map(() => 0), new Uint8()),
    source_id: vectorFromArray(idx.map(() => 0), new Uint16()),
    start_lat: vectorFromArray(idx.map((i) => 50.0 + i * 0.001), new Float64()),
    start_lon: vectorFromArray(idx.map(() => 14.0), new Float64()),
    end_lat: vectorFromArray(idx.map((i) => 50.0 + i * 0.001 + 0.0005), new Float64()),
    end_lon: vectorFromArray(idx.map(() => 14.0), new Float64()),
  }
  if (opts.omitCoreColumn) delete cols[opts.omitCoreColumn]
  if (opts.withTrainCols) {
    cols['trains_passenger'] = vectorFromArray(idx.map((i) => 10 + i), new Float64())
    cols['trains_freight'] = vectorFromArray(idx.map((i) => 20 + i), new Float64())
  }
  const table = new Table(cols)
  const path = resolve(hexDir, 'railways.arrow')
  writeFileSync(path, Buffer.from(tableToIPC(table, 'file')))
  return path
}

test('a never-enriched hex (no trains_passenger/trains_freight columns at all) is NOT skipped — rows read pax=frt=0', () => {
  const dir = join(TMP, 'never-enriched')
  writeHex(dir, '841e309ffffffff', { withTrainCols: false })

  const { rows, ioErrors } = collectRailEndpointRows(dir, ['841e309ffffffff'])

  assert.equal(ioErrors.length, 0, 'a missing trains_passenger/trains_freight pair is NOT extract-core damage')
  assert.equal(rows.length, 2, 'both rows are collected, not silently skipped')
  for (const r of rows) {
    assert.equal(r.pax, 0)
    assert.equal(r.frt, 0)
    assert.equal(r.sourceId, 0)
  }
})

test('a hex missing an EXTRACT-CORE column (e.g. end_lat) still reports an ioError, unaffected by the never-enriched fix', () => {
  const dir = join(TMP, 'core-missing')
  writeHex(dir, '841e309ffffffff', { withTrainCols: true, omitCoreColumn: 'end_lat' })

  const { rows, ioErrors } = collectRailEndpointRows(dir, ['841e309ffffffff'])

  assert.equal(rows.length, 0, 'damaged hex contributes no rows')
  assert.equal(ioErrors.length, 1)
  assert.match(ioErrors[0].error, /missing extract-core column/)
  assert.match(ioErrors[0].error, /end_lat/)
})

test('loadRailStopsIndex logs each loaded sidecar file with scope+extractFingerprint+stop count', (t) => {
  const preparedRoot = join(TMP, 'sidecar-visibility')
  const h3r4Dir = resolve(preparedRoot, 'h3r4')
  const stopsDir = resolve(preparedRoot, 'rail-stops')
  mkdirSync(h3r4Dir, { recursive: true })
  mkdirSync(stopsDir, { recursive: true })
  writeFileSync(
    resolve(stopsDir, 'cz.json'),
    JSON.stringify({
      version: 1, year: '2099', scope: 'cz', extractFingerprint: 'jr2026:2026-04-08',
      feeds: ['czptt-jr2026'], generatedAt: new Date().toISOString(),
      stops: [{ lat: 50.0, lon: 14.0 }, { lat: 50.1, lon: 14.1 }],
    }),
  )

  const logs: string[] = []
  t.mock.method(console, 'log', (msg: string) => { logs.push(String(msg)) })

  const index = loadRailStopsIndex(h3r4Dir)
  assert.ok(index)
  assert.ok(
    logs.some((l) => l.includes('cz.json') && l.includes('scope=cz') && l.includes('jr2026:2026-04-08') && l.includes('stops=2')),
    `expected a log line naming the loaded sidecar, got: ${JSON.stringify(logs)}`,
  )
})
