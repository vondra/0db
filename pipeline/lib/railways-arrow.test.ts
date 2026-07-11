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
 *  distinctive counts (10+i / 20+i) so "untouched" is provable. `sourceIds`
 *  (parallel to rows) pre-seeds an existing stamp per row — default unstamped
 *  — for retract tests that need an already-owned row a live writer pass
 *  could never itself produce (e.g. a stamped row later reclassified as a
 *  siding, which the service-skip gate would keep `match` from ever
 *  reaching). */
function writeRailFixture(
  name: string,
  rows: Array<[railType: number, service: number]>,
  sourceIds?: number[],
): string {
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
    source_id: vectorFromArray(idx.map(i => sourceIds?.[i] ?? 0), new Uint16()),
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

// ── RETRACT self-heal (rail twin of the roads-arrow.test.ts retract case) ───

test('retract: disowns owned rows (incl. now-service) and zeroes counts; counter reports them', async () => {
  // The rail twin of the roads "Zelená 20" heal: a row stamped by GTFS id 110
  // while healthy, later reclassified as a siding (service=2) by an OSM edit,
  // must be disowned even though the service-skip gate would otherwise keep
  // `match` from ever reaching it — retraction runs BEFORE that gate. A row
  // owned by the same id that stayed healthy is left alone. A row owned by
  // ANOTHER id is never touched even though it would also satisfy `when`.
  const rows: Array<[railType: number, service: number]> = [[0, 2], [0, 0], [0, 2]]
  const path = writeRailFixture('retract.arrow', rows, [110, 110, 99])

  const result = await writeRailTrains(
    path,
    () => null, // no new matches — pure heal pass
    undefined,
    { sourceId: 110, when: (row, i) => row.railType === 0 && rows[i][1] > 0 },
  )
  assert.equal(result.retracted, 1, 'exactly the now-service row owned by 110')
  assert.equal(result.matched, 0, 'pure heal pass matches nothing new')
  assert.equal(result.updated, true)

  const t = tableFromIPC(readFileSync(path))
  const src = [...Array(3)].map((_, i) => t.getChild('source_id')!.get(i))
  const pax = [...Array(3)].map((_, i) => t.getChild('trains_passenger')!.get(i))
  const frt = [...Array(3)].map((_, i) => t.getChild('trains_freight')!.get(i))
  assert.deepEqual(src, [0, 110, 99], 'row0 disowned, row1 kept, foreign row2 untouched despite matching `when`')
  assert.equal(pax[0], 0, 'retracted passenger count zeroed')
  assert.equal(frt[0], 0, 'retracted freight count zeroed')
  assert.equal(pax[1], 11, 'kept counts intact')
  assert.equal(frt[1], 21, 'kept counts intact')
  assert.equal(pax[2], 12, 'foreign counts intact despite matching `when`')
  assert.equal(frt[2], 22, 'foreign counts intact despite matching `when`')
})

test('retract: value fingerprint — `when` sees existingPax/existingFrt and disowns only the exact tuple', async () => {
  // The OLD_FALLBACK heal shape (task #26): every enricher retracts rows whose
  // CURRENT counts exactly equal the legacy class-default tuple it used to stamp.
  // Fixture seeds pax=10+i / frt=20+i, so (10, 20) fingerprints row 0 only; row 1
  // (11/21) is the "same owner, real-looking values" row that must survive.
  const path = writeRailFixture('retract-fingerprint.arrow', [[0, 0], [0, 0]], [110, 110])

  const result = await writeRailTrains(
    path,
    () => null,
    undefined,
    { sourceId: 110, when: (row) => row.existingPax === 10 && row.existingFrt === 20 },
  )
  assert.equal(result.retracted, 1, 'only the tuple-valued row is disowned')

  const t = tableFromIPC(readFileSync(path))
  assert.deepEqual(
    [t.getChild('source_id')!.get(0), t.getChild('source_id')!.get(1)],
    [0, 110],
    'fingerprinted row disowned, differently-valued row kept',
  )
  assert.equal(t.getChild('trains_passenger')!.get(1), 11, 'kept row counts intact')
})

test('retract: an owned SERVICE row is auto-healed even when `when` declines', async () => {
  // Row1 is service=2 yet carries the dataset's own stamp — a state the
  // service-skip gate forbids creating, so ownership alone proves it stale
  // (the CZ 94,928-siding legacy; /gg Codex W1). `when: false` must not
  // protect it; the non-service owned row0 stays untouched.
  const path = writeRailFixture('retract-svc.arrow', [[0, 0], [1, 2]], [110, 110])
  const result = await writeRailTrains(path, () => null, undefined,
    { sourceId: 110, when: () => false })
  assert.equal(result.retracted, 1, 'exactly the owned service row')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('source_id')!.get(1), 0, 'service row disowned')
  assert.equal(t.getChild('source_id')!.get(0), 110, 'non-service owned row kept (when=false)')
})

test('retract: a heal pass that retracts nothing leaves the file byte-identical', async () => {
  // Both rows NON-service — an owned service row is auto-healed by design (above).
  const path = writeRailFixture('retract-noop.arrow', [[0, 0], [1, 0]], [110, 110])
  const before = readFileSync(path)
  const result = await writeRailTrains(
    path,
    () => null,
    undefined,
    { sourceId: 110, when: () => false }, // dataset owns both rows but heals neither
  )
  assert.equal(result.retracted, 0)
  assert.equal(result.updated, false)
  assert.deepEqual(readFileSync(path), before, 'no-op retract pass must not rewrite the file')
})

test('retract fall-through: match re-claims a coincidental tuple in the same pass', async () => {
  // Row0 carries the dataset's stamp; the fingerprint says "legacy tuple" but
  // the live join (simulated: `match` returns a real count) still covers it —
  // the retract zeroes, match re-stamps in the SAME pass, the row is never
  // lost (/gg Codex+Gemini consensus CRITICAL; the BE 200/0 tram collision).
  const path = writeRailFixture('retract-reclaim.arrow', [[0, 0]], [110])
  const result = await writeRailTrains(
    path,
    () => ({ pax: 144, frt: 12, sourceId: 110 }),
    undefined,
    { sourceId: 110, when: () => true },
  )
  assert.equal(result.retracted, 1)
  assert.equal(result.matched, 1, 'same-pass re-claim')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('trains_passenger')!.get(0), 144)
  assert.equal(t.getChild('source_id')!.get(0), 110)
})
