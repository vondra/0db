/**
 * Tests for the shared parallel-track divisor pass (task #30 part 1) —
 * synthetic one-hex railways.arrow fixtures exercising corridor identity
 * (ref/name + rail_type + usage), the 50 m point-to-segment neighbour rule,
 * the nodeKey junction exclusion, the ≤3 clamp, the only-raise-from-1 rule,
 * and the walk-managed-source exclusion (`railDivisorFromWalk` in
 * enrichment-datasets.ts) that keeps this pass off rows the graph-walk
 * driver's own lateral spread already owns.
 *
 * Run: `cd pipeline && npx tsx --test enrich-railways-parallel.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Table, vectorFromArray, makeVector, tableFromIPC, tableToIPC,
  Float32, Float64, Int16, Int32, Uint8, Uint16, Utf8,
} from 'apache-arrow'
import { enrichHexRailParallelDivisor } from './enrich-railways-parallel.js'

const TMP = mkdtempSync(join(tmpdir(), 'enrich-railways-parallel-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

// Geometry: tracks run north-south at 50°N. 0.0002° of longitude ≈ 14.3 m —
// realistic parallel-track spacing, comfortably inside the 50 m radius.
const LON_STEP = 0.0002

interface FxRow {
  osm: number
  ref?: string
  name?: string
  railType?: number
  usage?: number
  service?: number
  /** Dataset id this row is stamped under; defaults to 0 (unspecified). */
  sourceId?: number
  start: [lat: number, lon: number]
  end: [lat: number, lon: number]
  divisor?: number // any row setting this materializes the parallel_divisor column
}

/** North-south segment at `lon`, ~100 m long. */
const NS = (lon: number): Pick<FxRow, 'start' | 'end'> => ({
  start: [50.0, lon],
  end: [50.0009, lon],
})

/** Synthetic one-hex railways.arrow with the extractor's column set (+ the
 *  enrichment extras). `parallel_divisor` is included only when some row sets
 *  `divisor` — a fresh extract has no such column. */
function writeFixture(name: string, rows: FxRow[]): string {
  const idx = [...rows.keys()]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Vector record
  const cols: Record<string, any> = {
    osm_id: makeVector(BigInt64Array.from(rows.map(r => BigInt(r.osm)))),
    segment_idx: vectorFromArray(idx.map(() => 0), new Int16()),
    start_lat: vectorFromArray(rows.map(r => r.start[0]), new Float64()),
    start_lon: vectorFromArray(rows.map(r => r.start[1]), new Float64()),
    end_lat: vectorFromArray(rows.map(r => r.end[0]), new Float64()),
    end_lon: vectorFromArray(rows.map(r => r.end[1]), new Float64()),
    length_m: vectorFromArray(idx.map(() => 100), new Float32()),
    rail_type: vectorFromArray(rows.map(r => r.railType ?? 0), new Uint8()),
    usage: vectorFromArray(rows.map(r => r.usage ?? 0), new Uint8()),
    maxspeed: vectorFromArray(idx.map(() => 120), new Uint16()),
    name: vectorFromArray(rows.map(r => r.name ?? null), new Utf8()),
    ref: vectorFromArray(rows.map(r => r.ref ?? null), new Utf8()),
    service: vectorFromArray(rows.map(r => r.service ?? 0), new Uint8()),
    trains_passenger: vectorFromArray(idx.map(i => 10 + i), new Int32()),
    trains_freight: vectorFromArray(idx.map(i => 20 + i), new Int32()),
    source_id: vectorFromArray(rows.map(r => r.sourceId ?? 0), new Uint16()),
  }
  if (rows.some(r => r.divisor !== undefined)) {
    cols['parallel_divisor'] = vectorFromArray(rows.map(r => r.divisor ?? 1), new Uint8())
  }
  const path = join(TMP, name)
  writeFileSync(path, Buffer.from(tableToIPC(new Table(cols), 'file')))
  return path
}

function readDivisors(path: string): Array<number | null> {
  const t = tableFromIPC(readFileSync(path))
  const div = t.getChild('parallel_divisor')
  if (!div) return new Array(t.numRows).fill(null)
  return [...Array(t.numRows)].map((_, i) => div.get(i) as number)
}

test('two parallel ways same ref → 2 on both; different ref, service and token-less rows untouched and never counted', async () => {
  const path = writeFixture('core.arrow', [
    { osm: 1, ref: '2600', ...NS(14.0) },
    { osm: 2, ref: '2600', ...NS(14.0 + LON_STEP) },
    { osm: 3, ref: '4500', ...NS(14.0 + 2 * LON_STEP) }, // different corridor, alone → stays 1
    { osm: 4, ref: '2600', service: 2, ...NS(14.0 - LON_STEP) }, // siding: excluded entirely
    { osm: 5, ...NS(14.0 + 3 * LON_STEP) }, // neither ref nor name: untouched, no guessing
  ])
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(
    {
      rows: s.rows, eligible: s.eligibleRows, service: s.serviceRows, noToken: s.noTokenRows,
      computed: s.computedHist, written: s.writtenHist, changed: s.changed,
    },
    {
      rows: 5, eligible: 3, service: 1, noToken: 1,
      computed: [1, 2, 0], written: [0, 2, 0], changed: true,
    },
  )
  // Service row parallel to osm 1 within 14 m: had it counted, osm 1/2 would be 3.
  assert.deepEqual(readDivisors(path), [2, 2, 1, 1, 1])
  // Untouched columns copied verbatim through the write.
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('trains_passenger')!.get(3), 13)
  assert.equal(t.getChild('ref')!.get(0), '2600')
})

test('name is the corridor fallback when ref is empty', async () => {
  const path = writeFixture('name-fallback.arrow', [
    { osm: 60, name: 'Stammstrecke', ...NS(14.0) },
    { osm: 61, name: 'Stammstrecke', ...NS(14.0 + LON_STEP) },
  ])
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(s.writtenHist, [0, 2, 0])
  assert.deepEqual(readDivisors(path), [2, 2])
})

test('same ref but different usage or rail_type never groups', async () => {
  const path = writeFixture('family-split.arrow', [
    { osm: 50, ref: 'U', usage: 0, ...NS(14.0) },
    { osm: 51, ref: 'U', usage: 1, ...NS(14.0 + LON_STEP) },
    { osm: 52, ref: 'U', railType: 1, ...NS(14.0 + 2 * LON_STEP) },
  ])
  const before = readFileSync(path)
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(s.computedHist, [3, 0, 0], 'three singleton corridors')
  assert.equal(s.changed, false)
  assert.deepEqual(readFileSync(path), before, 'nothing to write → byte-identical')
})

test('five parallel ways clamp at 3 — even the outermost track that only sees 3 neighbours', async () => {
  const path = writeFixture('clamp.arrow', [...Array(5)].map((_, k) => (
    { osm: 100 + k, ref: 'C', ...NS(14.0 + k * LON_STEP) }
  )))
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(s.computedHist, [0, 0, 5])
  assert.deepEqual(readDivisors(path), [3, 3, 3, 3, 3])
})

test('nodeKey junction exclusion: consecutive ways of ONE track are continuation, not parallel', async () => {
  // Way 10 ends exactly where way 11 starts (shared OSM node). The short end
  // segment's midpoint is ~28 m from the continuation way — inside 50 m, and
  // WITHOUT the shared-endpoint skip both rows would get divisor 2.
  const path = writeFixture('junction.arrow', [
    { osm: 10, ref: 'J', start: [50.0, 14.0], end: [50.0005, 14.0] },
    { osm: 11, ref: 'J', start: [50.0005, 14.0], end: [50.001, 14.0] },
  ])
  const before = readFileSync(path)
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(s.computedHist, [2, 0, 0], 'both rows stay single-track')
  assert.equal(s.changed, false)
  assert.deepEqual(readFileSync(path), before)
})

test('two nearby segments of the SAME osm_id do not count as parallel', async () => {
  const path = writeFixture('same-way.arrow', [
    { osm: 20, ref: 'S', ...NS(14.0) },
    { osm: 20, ref: 'S', ...NS(14.0 + LON_STEP) },
  ])
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(s.computedHist, [2, 0, 0])
  assert.equal(s.changed, false)
})

test('only-raise: an existing CZ-style divisor is never lowered (computed 1) — byte-identical', async () => {
  const path = writeFixture('cz-protect.arrow', [
    { osm: 30, ref: 'P', ...NS(14.0), divisor: 2 }, // isolated → computed 1
  ])
  const before = readFileSync(path)
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(
    { computed: s.computedHist, kept: s.keptExistingAbove1, written: s.writtenHist, changed: s.changed },
    { computed: [1, 0, 0], kept: 1, written: [0, 0, 0], changed: false },
  )
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readDivisors(path), [2])
})

test('only-raise: protected row keeps its higher value while its unstamped twin is raised', async () => {
  const path = writeFixture('cz-mixed.arrow', [
    { osm: 40, ref: 'M', ...NS(14.0), divisor: 3 }, // CZ-style value ≠ our computed 2 — kept
    { osm: 41, ref: 'M', ...NS(14.0 + LON_STEP), divisor: 1 },
  ])
  const s = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(
    { kept: s.keptExistingAbove1, written: s.writtenHist, changed: s.changed },
    { kept: 1, written: [0, 1, 0], changed: true },
  )
  assert.deepEqual(readDivisors(path), [3, 2])
})

test('dry-run reports the histogram it WOULD write and leaves the file byte-identical', async () => {
  const path = writeFixture('dry-run.arrow', [
    { osm: 70, ref: 'D', ...NS(14.0) },
    { osm: 71, ref: 'D', ...NS(14.0 + LON_STEP) },
  ])
  const before = readFileSync(path)
  const s = await enrichHexRailParallelDivisor(path, { dryRun: true })
  assert.deepEqual({ written: s.writtenHist, changed: s.changed }, { written: [0, 2, 0], changed: false })
  assert.deepEqual(readFileSync(path), before)
})

test('idempotent: a second run writes nothing (raised rows are now current > 1)', async () => {
  const path = writeFixture('idempotent.arrow', [
    { osm: 80, ref: 'I', ...NS(14.0) },
    { osm: 81, ref: 'I', ...NS(14.0 + LON_STEP) },
  ])
  const first = await enrichHexRailParallelDivisor(path)
  assert.equal(first.changed, true)
  const afterFirst = readFileSync(path)
  const second = await enrichHexRailParallelDivisor(path)
  assert.deepEqual(
    { written: second.writtenHist, kept: second.keptExistingAbove1, changed: second.changed },
    { written: [0, 0, 0], kept: 2, changed: false },
  )
  assert.deepEqual(readFileSync(path), afterFirst)
  assert.deepEqual(readDivisors(path), [2, 2])
})

test('walk-managed source (railDivisorFromWalk): its divisor-1 rows are never raised; an unflagged source in the same shape still is', async () => {
  const path = writeFixture('walk-managed.arrow', [
    // cz-szcd-gtfs (id 110) is flagged railDivisorFromWalk in enrichment-datasets.ts —
    // the graph-walk driver already decided divisor 1 here and this pass must
    // not raise it even though the geometry looks like a genuine parallel pair.
    { osm: 200, ref: 'W', sourceId: 110, ...NS(14.0), divisor: 1 },
    { osm: 201, ref: 'W', sourceId: 110, ...NS(14.0 + LON_STEP), divisor: 1 },
    // Same corridor shape, stamped by an UNFLAGGED source (100 = global-gtfs-transit) — still raised.
    { osm: 202, ref: 'U', sourceId: 100, ...NS(14.0 + 2 * LON_STEP), divisor: 1 },
    { osm: 203, ref: 'U', sourceId: 100, ...NS(14.0 + 3 * LON_STEP), divisor: 1 },
  ])
  const s = await enrichHexRailParallelDivisor(path)
  assert.equal(s.eligibleRows, 2, 'the two walk-managed rows never enter the corridor-eligible count at all')
  assert.deepEqual(readDivisors(path), [1, 1, 2, 2])
})
