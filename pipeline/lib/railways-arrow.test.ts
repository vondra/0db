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
import { writeRailTrains, writeRailParallelDivisor, type RailRow } from './railways-arrow.js'

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
  divisors?: number[] | null, // undefined → all 1; null → OMIT the parallel_divisor column
): string {
  const idx = [...rows.keys()]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Vector record
  const cols: Record<string, any> = {
    start_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001), new Float64()),
    start_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001), new Float64()),
    end_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001 + 0.0005), new Float64()),
    end_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001 + 0.0005), new Float64()),
    rail_type: vectorFromArray(rows.map(r => r[0]), new Uint8()),
    usage: vectorFromArray(idx.map(() => 0), new Uint8()),
    service: vectorFromArray(rows.map(r => r[1]), new Uint8()),
    trains_passenger: vectorFromArray(idx.map(i => 10 + i), new Int32()),
    trains_freight: vectorFromArray(idx.map(i => 20 + i), new Int32()),
    source_id: vectorFromArray(idx.map(i => sourceIds?.[i] ?? 0), new Uint16()),
  }
  if (divisors !== null) {
    cols['parallel_divisor'] = vectorFromArray(idx.map(i => divisors?.[i] ?? 1), new Uint8())
  }
  const table = new Table(cols)
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

// ── writeRailParallelDivisor (task #30: shared parallel-track divisor) ──────

test('parallel divisor: rebuilds only parallel_divisor, null keeps, other columns verbatim', async () => {
  const path = writeRailFixture('pdiv-basic.arrow', [[0, 0], [0, 0], [0, 2]])
  const result = await writeRailParallelDivisor(path, (i) => (i === 0 ? 2 : null))
  assert.deepEqual(
    { rows: result.rows, changedRows: result.changedRows, updated: result.updated },
    { rows: 3, changedRows: 1, updated: true },
  )
  const t = tableFromIPC(readFileSync(path))
  const div = t.getChild('parallel_divisor')!
  assert.deepEqual([div.get(0), div.get(1), div.get(2)], [2, 1, 1])
  // Every other column copied verbatim — seeded counts + provenance intact.
  assert.equal(t.getChild('trains_passenger')!.get(1), 11)
  assert.equal(t.getChild('trains_freight')!.get(2), 22)
  assert.equal(t.getChild('source_id')!.get(0), 0)
  assert.equal(t.getChild('service')!.get(2), 2)
})

test('parallel divisor: no value change leaves the file byte-identical (all-null and same-value)', async () => {
  const path = writeRailFixture('pdiv-noop.arrow', [[0, 0], [0, 0]], undefined, [2, 1])
  const before = readFileSync(path)
  const r1 = await writeRailParallelDivisor(path, () => null)
  assert.deepEqual({ changedRows: r1.changedRows, updated: r1.updated }, { changedRows: 0, updated: false })
  const r2 = await writeRailParallelDivisor(path, (i) => (i === 0 ? 2 : 1)) // equals stored values
  assert.deepEqual({ changedRows: r2.changedRows, updated: r2.updated }, { changedRows: 0, updated: false })
  assert.deepEqual(readFileSync(path), before, 'no-op passes must not rewrite the file')
})

test('parallel divisor: missing column + only 1/null results → NOT materialized (engine default is 1)', async () => {
  const path = writeRailFixture('pdiv-absent-noop.arrow', [[0, 0], [0, 0]], undefined, null)
  assert.equal(tableFromIPC(readFileSync(path)).getChild('parallel_divisor'), null, 'fixture sanity')
  const before = readFileSync(path)
  const result = await writeRailParallelDivisor(path, (i) => (i === 0 ? 1 : null))
  assert.equal(result.updated, false)
  assert.deepEqual(readFileSync(path), before, 'an all-1 column must not be added')
})

test('parallel divisor: missing column is added when a row needs a value > 1', async () => {
  const path = writeRailFixture('pdiv-absent-add.arrow', [[0, 0], [0, 0]], undefined, null)
  const result = await writeRailParallelDivisor(path, (i) => (i === 1 ? 3 : null))
  assert.deepEqual({ changedRows: result.changedRows, updated: result.updated }, { changedRows: 1, updated: true })
  const t = tableFromIPC(readFileSync(path))
  const div = t.getChild('parallel_divisor')!
  assert.deepEqual([div.get(0), div.get(1)], [1, 3], 'kept rows default to 1 in the new column')
})

test('parallel divisor: floor — 0 is stored as 1 (writer is policy-free; only-raise lives in the caller)', async () => {
  const path = writeRailFixture('pdiv-floor.arrow', [[0, 0]], undefined, [2])
  const result = await writeRailParallelDivisor(path, () => 0)
  assert.deepEqual({ changedRows: result.changedRows, updated: result.updated }, { changedRows: 1, updated: true })
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('parallel_divisor')!.get(0), 1, '0 floored to 1 — and the writer WILL lower when told to')
})

test('parallel divisor: fail-loud on non-integer / negative / >255, file left unchanged', async () => {
  const path = writeRailFixture('pdiv-invalid.arrow', [[0, 0]])
  const before = readFileSync(path)
  for (const bad of [2.5, -1, 300]) {
    await assert.rejects(writeRailParallelDivisor(path, () => bad), /invalid divisor/)
  }
  assert.deepEqual(readFileSync(path), before, 'failed writes must not mutate the arrow')
})

test('retract: multi-id sourceId disowns rows owned by ANY of the listed ids in one pass', async () => {
  // A migration shape: a dataset absorbing two retired predecessor ids (205,
  // 300) alongside its own (110) disowns all three in a single sweep — a row
  // owned by an id NOT in the list must survive untouched.
  const rows: Array<[railType: number, service: number]> = [[0, 0], [0, 0], [0, 0], [0, 0]]
  const path = writeRailFixture('retract-multi-id.arrow', rows, [110, 205, 300, 99])

  const result = await writeRailTrains(
    path,
    () => null,
    undefined,
    { sourceId: [110, 205, 300], when: () => true },
  )
  assert.equal(result.retracted, 3, 'rows owned by any of the 3 listed ids are disowned')
  assert.equal(result.updated, true)

  const t = tableFromIPC(readFileSync(path))
  const src = [...Array(4)].map((_, i) => t.getChild('source_id')!.get(i))
  assert.deepEqual(src, [0, 0, 0, 99], 'row3 (owned by an unlisted id) is untouched')
  const pax = [...Array(4)].map((_, i) => t.getChild('trains_passenger')!.get(i))
  assert.deepEqual(pax, [0, 0, 0, 13], 'the three disowned rows are zeroed; the untouched row (10+3) keeps its seeded count')
})

test('retract resets parallel_divisor to 1 in BOTH arms; kept and foreign rows keep theirs', async () => {
  // row0: non-service, owned, `when` fires → the when-gated retract arm.
  // row1: now-service, owned → auto-healed via the service-skip arm regardless of `when`.
  // row2: non-service, owned, `when` false → kept, divisor untouched.
  // row3: non-service, owned by a DIFFERENT id → never a retract candidate, divisor untouched.
  const rows: Array<[railType: number, service: number]> = [[0, 0], [0, 2], [0, 0], [0, 0]]
  const path = writeRailFixture('retract-divisor-reset.arrow', rows, [110, 110, 110, 99], [3, 4, 5, 6])

  const result = await writeRailTrains(
    path,
    () => null,
    undefined,
    { sourceId: 110, when: (_row, i) => i === 0 }, // only row0 satisfies `when`
  )
  assert.equal(result.retracted, 2, 'row0 (when-arm) + row1 (service-arm)')

  const t = tableFromIPC(readFileSync(path))
  const div = [...Array(4)].map((_, i) => t.getChild('parallel_divisor')!.get(i))
  assert.deepEqual(div, [1, 1, 5, 6], 'the two retracted rows reset to 1; kept row2 and foreign row3 untouched')
})

test('retract that only fires on already-divisor-1 rows leaves parallel_divisor untouched (no spurious write)', async () => {
  // Every owned row's divisor is already 1 — resetting to 1 is not a value
  // change, so the column must not even be rebuilt (verbatim copy suffices).
  const path = writeRailFixture('retract-divisor-noop.arrow', [[0, 0]], [110], [1])
  const result = await writeRailTrains(path, () => null, undefined, { sourceId: 110, when: () => true })
  assert.equal(result.retracted, 1)
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('parallel_divisor')!.get(0), 1)
})

test('retract on a hex with NO parallel_divisor column leaves it absent (never materializes an all-1 column)', async () => {
  const path = writeRailFixture('retract-divisor-absent.arrow', [[0, 0]], [110], null)
  assert.equal(tableFromIPC(readFileSync(path)).getChild('parallel_divisor'), null, 'fixture sanity')
  const result = await writeRailTrains(path, () => null, undefined, { sourceId: 110, when: () => true })
  assert.equal(result.retracted, 1, 'retract still fires and zeroes the stamp')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('parallel_divisor'), null, 'no column materialized for a never-divisor\'d hex')
  assert.equal(t.getChild('source_id')!.get(0), 0)
})

// ── Value-diff idempotence (world-scale walk re-runs must be byte-no-ops) ───

test('idempotent match: identical pax/frt/sourceId re-stamp does not rewrite the file (matched still counts)', async () => {
  // Row already carries exactly what `match` is about to return — a second
  // pass over already-correct data (the world-scale re-run case).
  const path = writeRailFixture('idempotent-match.arrow', [[0, 0]], [STAMP_ID])
  const before = readFileSync(path)
  const result = await writeRailTrains(path, () => ({ pax: 10, frt: 20, sourceId: STAMP_ID }))
  assert.equal(result.matched, 1, '`matched` still counts the accepted match — callers log it as GTFS-stamped')
  assert.equal(result.updated, false, 'no row value actually changed → byte-identical skip')
  assert.deepEqual(readFileSync(path), before, 'identical re-stamp must not rewrite bytes')
})

test('changed match: a genuinely different pax value DOES rewrite the file', async () => {
  const path = writeRailFixture('changed-match-pax.arrow', [[0, 0]], [STAMP_ID])
  const result = await writeRailTrains(path, () => ({ pax: 999, frt: 20, sourceId: STAMP_ID }))
  assert.equal(result.matched, 1)
  assert.equal(result.updated, true, 'a real value change must still rewrite the file')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('trains_passenger')!.get(0), 999)
})

test('changed match: same pax/frt but a different sourceId still counts as a change', async () => {
  // Unstamped row (source_id=0) already carries the seeded pax/frt fixture
  // values; `match` returns those same counts under a real registered rail id
  // (2000 = ae-national-railway) — the id transition alone must force a write.
  const AE_RAILWAY_ID = 2000
  const path = writeRailFixture('changed-match-source-only.arrow', [[0, 0]])
  const result = await writeRailTrains(path, () => ({ pax: 10, frt: 20, sourceId: AE_RAILWAY_ID }))
  assert.equal(result.matched, 1)
  assert.equal(result.updated, true, 'source_id 0 → real id is a change even when pax/frt are unchanged')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('source_id')!.get(0), AE_RAILWAY_ID)
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

// ── Atomic counts+divisor (2026-07-16 /gg review item A.1): `divisor` on
// RailTrains rides in the SAME write as pax/frt/sourceId — never a separate
// pass a stamp-only/inspection mode could skip. ─────────────────────────────

test('atomic divisor: a match carrying `divisor` sets parallel_divisor in the SAME write, materializing an absent column', async () => {
  const path = writeRailFixture('divisor-set.arrow', [[0, 0]], undefined, null) // no column at all
  assert.equal(tableFromIPC(readFileSync(path)).getChild('parallel_divisor'), null, 'fixture sanity')
  const result = await writeRailTrains(path, () => ({ pax: 5, frt: 0, sourceId: STAMP_ID, divisor: 3 }))
  assert.equal(result.matched, 1)
  assert.equal(result.updated, true)
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('parallel_divisor')!.get(0), 3, 'divisor set in the same match, no separate writeRailParallelDivisor call needed')
  assert.equal(t.getChild('trains_passenger')!.get(0), 5)
})

test('atomic divisor: identical re-run INCLUDING divisor is a byte-no-op (value-diff idempotence now covers divisor)', async () => {
  const path = writeRailFixture('divisor-idempotent.arrow', [[0, 0]], [STAMP_ID], [3])
  const before = readFileSync(path)
  // Fixture seeds pax=10, frt=20 for row 0 (see writeRailFixture doc) — match
  // reproduces exactly what's already on disk, divisor included.
  const result = await writeRailTrains(path, () => ({ pax: 10, frt: 20, sourceId: STAMP_ID, divisor: 3 }))
  assert.equal(result.matched, 1, 'still counts as an accepted match')
  assert.equal(result.updated, false, 'nothing actually changed, incl. divisor — byte-no-op')
  assert.deepEqual(readFileSync(path), before, 'identical re-stamp (incl. divisor) must not rewrite bytes')
})

test('atomic divisor: retract-then-reclaim in the SAME pass ends at the match\'s new divisor, not the retract\'s interim 1', async () => {
  // Row is owned by 110 with a stale divisor (5); the SAME pass both retracts
  // it (fingerprint `when` fires) and immediately re-claims it with a real
  // count carrying a DIFFERENT divisor (7) — order is retract-zeroes then
  // match-sets, so the row must land on 7, never stuck at the retract's
  // interim reset-to-1.
  const path = writeRailFixture('retract-reclaim-divisor.arrow', [[0, 0]], [110], [5])
  const result = await writeRailTrains(
    path,
    () => ({ pax: 144, frt: 12, sourceId: 110, divisor: 7 }),
    undefined,
    { sourceId: 110, when: () => true },
  )
  assert.equal(result.retracted, 1)
  assert.equal(result.matched, 1, 'same-pass re-claim')
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('parallel_divisor')!.get(0), 7, 'ends at the NEW divisor, not voided to 1')
  assert.equal(t.getChild('trains_passenger')!.get(0), 144)
  assert.equal(t.getChild('source_id')!.get(0), 110)
})

// ── #31.7 countryGate: central national-ownership gate ──────────────────────
// Fixture rows march east (start lon 14.0 + 0.001·i, end +0.0005): a border at
// 14.00225 puts rows 0-1 wholly inside, makes row 2 a genuine straddler
// (start in, mid+end out) and row 3 wholly foreign.

test('countryGate: wholly-foreign rows never offered to match; straddlers and domestic rows are', async () => {
  const gate = (_lat: number, lon: number) => lon < 14.00225
  const path = writeRailFixture('country-gate.arrow', [[0, 0], [0, 0], [0, 0], [0, 0]])
  const offered: number[] = []
  const r = await writeRailTrains(
    path,
    (_row, i) => { offered.push(i); return { pax: 7, frt: 1, sourceId: STAMP_ID } },
    undefined,
    undefined,
    gate,
  )
  assert.deepEqual(offered, [0, 1, 2], 'rows 0-1 domestic + row 2 straddler offered; row 3 wholly foreign skipped')
  assert.equal(r.skippedForeign, 1)
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('source_id')!.get(2), STAMP_ID, 'border-straddler IS claimable (R9 semantics)')
  assert.equal(t.getChild('source_id')!.get(3), 0, 'foreign row never stamped')
  assert.equal(t.getChild('trains_passenger')!.get(3), 13, 'foreign row payload untouched')
})

test('countryGate: retract still reaches the foreign rows the gate hides from match', async () => {
  // The heal path: a foreign row THIS id owns must be disownable in the very
  // pass that can no longer stamp it. Border west of everything → all foreign.
  const gate = (_lat: number, lon: number) => lon < 13.0
  const path = writeRailFixture('country-gate-retract.arrow', [[0, 0], [0, 0]], [STAMP_ID, STAMP_ID])
  const r = await writeRailTrains(
    path,
    () => { throw new Error('match must never run — every row is wholly foreign') },
    undefined,
    { sourceId: STAMP_ID, when: () => true },
    gate,
  )
  assert.equal(r.retracted, 2, 'both foreign owned rows disowned')
  assert.equal(r.matched, 0)
  assert.equal(r.skippedForeign, 2)
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('source_id')!.get(0), 0)
  assert.equal(t.getChild('trains_passenger')!.get(0), 0)
})

test('fail-loud: unregistered positive id and non-railways layer id both throw (#31.4b)', async () => {
  // shouldOverwrite deliberately treats an unknown EXISTING id as legacy — so
  // the writer itself must refuse to CREATE one, and a roads id (20,
  // cz-rsd-scitani) must never stamp a rail row.
  const p1 = writeRailFixture('unreg-src.arrow', [[0, 0]])
  await assert.rejects(
    writeRailTrains(p1, () => ({ pax: 1, frt: 0, sourceId: 65000 })),
    /not a registered railways source/,
  )
  const p2 = writeRailFixture('wrong-layer-src.arrow', [[0, 0]])
  await assert.rejects(
    writeRailTrains(p2, () => ({ pax: 1, frt: 0, sourceId: 20 })),
    /not a registered railways source/,
  )
})
