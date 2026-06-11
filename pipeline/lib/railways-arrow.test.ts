/**
 * Writer-level invariant tests for `writeRailTrains` (A3/C2 of the 2026-06
 * audit wave). Locks the two rail invariants:
 *
 *   1. SERVICE-SKIP — a `service > 0` row (siding/yard) is never offered to
 *      `match` (the CZ 94,928-siding bug).
 *   2. FAMILY ROUTING — the writer delivers `railType` per row so a
 *      family-aware match closure (the 2026-06-10 rail-wave Variant B shape,
 *      see enrich-railway-europe.ts) routes tram rows to tram counts only; a
 *      tram can never inherit a mainline's GTFS count (the 14,799-tram bug).
 *
 * Run: `cd pipeline && npx tsx --test lib/railways-arrow.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Table, vectorFromArray, tableFromIPC, tableToIPC,
  Float64, Int32, Uint8, Uint16,
} from 'apache-arrow'
import { writeRailTrains, type RailRow } from './railways-arrow.js'

// cz-szcd-gtfs — a real national-measured registry id, so shouldOverwrite(0, id) passes.
const STAMP_ID = 110
const MAINLINE = { pax: 300, frt: 50 } // the GTFS count that must never land on a tram

const TMP = mkdtempSync(join(tmpdir(), 'railways-arrow-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** Tiny railways.arrow on disk. rows = [railType, service] pairs; seeds
 *  distinctive counts (10+i / 20+i) so "untouched" is provable. */
function writeRailFixture(name: string, rows: Array<[railType: number, service: number]>): string {
  const idx = [...rows.keys()]
  const table = new Table({
    start_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001), new Float64()),
    start_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001), new Float64()),
    end_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001 + 0.0005), new Float64()),
    end_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001 + 0.0005), new Float64()),
    rail_type: vectorFromArray(rows.map(r => r[0]), new Uint8()),
    usage: vectorFromArray(idx.map(() => 0), new Uint8()),
    service: vectorFromArray(rows.map(r => r[1]), new Uint8()),
    trains_passenger: vectorFromArray(idx.map(i => 10 + i), new Int32()),
    trains_freight: vectorFromArray(idx.map(i => 20 + i), new Int32()),
    parallel_divisor: vectorFromArray(idx.map(() => 1), new Uint8()),
    source_id: vectorFromArray(idx.map(() => 0), new Uint16()),
  })
  const path = join(TMP, name)
  writeFileSync(path, Buffer.from(tableToIPC(table, 'file')))
  return path
}

test('family routing + service skip: tram never gets the mainline count, rail does, sidings never offered', async () => {
  // row 0: plain heavy rail (rail_type 0) — gets the mainline GTFS count.
  // row 1: tram (rail_type 1) — family closure must route it AWAY from the mainline count.
  // row 2: heavy rail but service=2 (siding) — never offered at all.
  const path = writeRailFixture('family.arrow', [[0, 0], [1, 0], [0, 2]])

  const offered: RailRow[] = []
  const result = await writeRailTrains(path, (row) => {
    offered.push(row)
    // Variant B closure shape (enrich-railway-europe.ts): the mainline count is
    // reachable only via the rail-family arm; tram/light_rail fall through to
    // their own class default. A writer regression that mis-delivered railType
    // would route the tram into the mainline arm and fail the asserts below.
    if (row.railType === 0) return { pax: MAINLINE.pax, frt: MAINLINE.frt, sourceId: STAMP_ID }
    if (row.railType === 1 || row.railType === 2) return { pax: 200, frt: 0, sourceId: STAMP_ID } // tram class default
    return null
  })

  assert.deepEqual(
    { rows: result.rows, matched: result.matched, skippedService: result.skippedService, updated: result.updated },
    { rows: 3, matched: 2, skippedService: 1, updated: true },
  )
  assert.deepEqual(offered.map(r => r.railType), [0, 1], 'service row (index 2) must never be offered')

  const t = tableFromIPC(readFileSync(path))
  const pax = t.getChild('trains_passenger')!
  const frt = t.getChild('trains_freight')!
  const src = t.getChild('source_id')!
  // Plain rail row IS stamped with the mainline count.
  assert.equal(pax.get(0), MAINLINE.pax)
  assert.equal(frt.get(0), MAINLINE.frt)
  assert.equal(src.get(0), STAMP_ID)
  // Tram row got its family value — NOT the mainline count.
  assert.equal(pax.get(1), 200)
  assert.notEqual(pax.get(1), MAINLINE.pax)
  assert.equal(frt.get(1), 0)
  // Siding row untouched: seeded values + no provenance stamp.
  assert.equal(pax.get(2), 12)
  assert.equal(frt.get(2), 22)
  assert.equal(src.get(2), 0)
  // Untouched columns copied verbatim.
  assert.equal(t.getChild('parallel_divisor')!.get(1), 1)
})

test('match returning null leaves the row untouched (no stamp, no count)', async () => {
  const path = writeRailFixture('null-match.arrow', [[1, 0]])
  const result = await writeRailTrains(path, () => null)
  assert.deepEqual(
    { matched: result.matched, updated: result.updated },
    { matched: 0, updated: false },
  )
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('trains_passenger')!.get(0), 10)
  assert.equal(t.getChild('source_id')!.get(0), 0)
})

test('fail-loud: non-integer pax in match payload throws, file left unchanged', async () => {
  const path = writeRailFixture('malformed.arrow', [[0, 0]])
  const before = readFileSync(path)
  await assert.rejects(
    writeRailTrains(path, () => ({ pax: 2.5, frt: 0, sourceId: STAMP_ID })),
    /invalid match/,
  )
  assert.deepEqual(readFileSync(path), before, 'failed write must not mutate the arrow')
})
