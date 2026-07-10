/**
 * Writer-level invariant tests for `writeRoadAadt` (A3/C2 of the 2026-06 audit
 * wave). Locks the two safety gates a national enricher cannot be allowed to
 * regress: the `coverage` class gate (a major-road census can never stamp a
 * residential/service street) and the fail-loud malformed-payload check (the
 * IT/SA "wrote zeros" bug class).
 *
 * Run: `cd pipeline && npx tsx --test lib/roads-arrow.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Table, vectorFromArray, tableFromIPC, tableToIPC,
  Float64, Int32, Uint8, Uint16, Utf8,
} from 'apache-arrow'
import { writeRoadAadt, osmRoadClassRank, type RoadRow } from './roads-arrow.js'

// cz-rsd-scitani — a real national-measured registry id, so shouldOverwrite(0, id) passes.
const STAMP_ID = 20

const TMP = mkdtempSync(join(tmpdir(), 'roads-arrow-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** Tiny roads.arrow on disk with the columns writeRoadAadt reads/rewrites.
 *  Seeds distinctive AADT values (1000+i pattern) so "untouched" is provable.
 *  `speeds` (parallel to classes) adds a speed_limit column when given. */
function writeRoadsFixture(name: string, classes: number[], speeds?: number[]): string {
  const idx = [...classes.keys()]
  const table = new Table({
    ref: vectorFromArray(idx.map(i => `R${i}`), new Utf8()),
    start_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001), new Float64()),
    start_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001), new Float64()),
    end_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001 + 0.0005), new Float64()),
    end_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001 + 0.0005), new Float64()),
    road_class: vectorFromArray(classes, new Uint8()),
    ...(speeds ? { speed_limit: vectorFromArray(speeds, new Uint8()) } : {}),
    aadt_light: vectorFromArray(idx.map(i => 1000 + i), new Int32()),
    aadt_medium: vectorFromArray(idx.map(i => 2000 + i), new Int32()),
    aadt_heavy: vectorFromArray(idx.map(i => 3000 + i), new Int32()),
    aadt_moto: vectorFromArray(idx.map(i => 40 + i), new Int32()),
    source_id: vectorFromArray(idx.map(() => 0), new Uint16()),
  })
  const path = join(TMP, name)
  writeFileSync(path, Buffer.from(tableToIPC(table, 'file')))
  return path
}

test('coverage gate: out-of-coverage classes never reach match, columns stay untouched', async () => {
  // Plan C2 fixture: classes 0,2 (in coverage), 5,7,9 (out), link 10 (in).
  const classes = [0, 2, 5, 7, 9, 10]
  const path = writeRoadsFixture('coverage.arrow', classes)
  const coverage: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 10, 11, 12])

  const offered: RoadRow[] = []
  const result = await writeRoadAadt(
    path,
    (row) => {
      offered.push(row)
      // Always-matching payload — if the gate leaked a class-5/7/9 row, it WOULD be stamped.
      return { light: 9999, medium: 888, heavy: 77, moto: 6, sourceId: STAMP_ID }
    },
    undefined,
    coverage,
  )

  assert.deepEqual(
    { rows: result.rows, matched: result.matched, skipped: result.skipped, updated: result.updated },
    { rows: 6, matched: 3, skipped: 3, updated: true },
  )
  assert.deepEqual(offered.map(r => r.roadClass).sort((a, b) => a - b), [0, 2, 10],
    'match must see exactly the in-coverage classes')

  const t = tableFromIPC(readFileSync(path))
  const cls = t.getChild('road_class')!
  const light = t.getChild('aadt_light')!
  const moto = t.getChild('aadt_moto')!
  const src = t.getChild('source_id')!
  for (let i = 0; i < t.numRows; i++) {
    if (coverage.has(cls.get(i) as number)) {
      assert.equal(light.get(i), 9999, `class ${cls.get(i)} row stamped`)
      assert.equal(moto.get(i), 6)
      assert.equal(src.get(i), STAMP_ID)
    } else {
      assert.equal(light.get(i), 1000 + i, `class ${cls.get(i)} row untouched`)
      assert.equal(moto.get(i), 40 + i)
      assert.equal(src.get(i), 0, 'no provenance stamp on a skipped row')
    }
  }
  // Non-AADT columns survive the rebuild verbatim.
  assert.equal(t.getChild('ref')!.get(3), 'R3')
})

test('osmRoadClassRank: majors 0..4 verbatim, links collapse to parent, minors → 6', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(osmRoadClassRank), [0, 1, 2, 3, 4])
  assert.deepEqual([10, 11, 12].map(osmRoadClassRank), [0, 1, 2], 'links rank as their parent class')
  assert.deepEqual([5, 6, 7, 8, 9].map(osmRoadClassRank), [6, 6, 6, 6, 6], 'minor classes unreachable at ±1 even rank-only')
})

test('fail-loud: NaN column in match payload throws, file left unchanged', async () => {
  const path = writeRoadsFixture('malformed-nan.arrow', [0, 2])
  const before = readFileSync(path)
  await assert.rejects(
    writeRoadAadt(path, () => ({ light: NaN, medium: 1, heavy: 1, moto: 1, sourceId: STAMP_ID })),
    /invalid match/,
  )
  assert.deepEqual(readFileSync(path), before, 'failed write must not mutate the arrow')
})

test('fail-loud: missing field (undefined coerces) throws instead of writing zeros', async () => {
  const path = writeRoadsFixture('malformed-missing.arrow', [0])
  await assert.rejects(
    // The IT-bug shape: a payload that forgot a class column. TypedArrays would
    // silently coerce undefined→0; the writer must abort instead.
    writeRoadAadt(path, () => ({ light: 100, heavy: 5, moto: 1, sourceId: STAMP_ID }) as never),
    /invalid match/,
  )
})

test('fail-loud: sourceId 0/unknown payload throws (SA-bug shape)', async () => {
  const path = writeRoadsFixture('malformed-srcid.arrow', [0])
  await assert.rejects(
    writeRoadAadt(path, () => ({ light: 100, medium: 5, heavy: 5, moto: 1, sourceId: 0 })),
    /invalid match/,
  )
})

test('retract: disowns owned rows (incl. out-of-coverage) and zeroes AADT; counter reports them', async () => {
  // The "Zelená 20" heal shape: a class-7 service row stamped by census id 20
  // must be disowned even though class 7 is outside the dataset's coverage —
  // retraction runs BEFORE the coverage gate. A class-2 row owned by the same
  // id with a healthy ref stays; a row owned by ANOTHER id is never touched.
  const classes = [7, 2, 7]
  const path = writeRoadsFixture('retract.arrow', classes)
  // Re-stamp fixture: row0 owned by 20 (bad: class 7), row1 owned by 20
  // (good: class 2), row2 owned by 99 (foreign — untouchable).
  await writeRoadAadt(path, (row, i) =>
    ({ light: 111, medium: 0, heavy: 0, moto: 0, sourceId: i === 2 ? 99 : 20 }))

  const result = await writeRoadAadt(
    path,
    () => null, // no new matches — pure heal pass
    undefined,
    new Set([0, 1, 2, 3, 4, 10, 11, 12]),
    { sourceId: 20, when: (row) => osmRoadClassRank(row.roadClass) > 4 },
  )
  assert.equal(result.retracted, 1, 'exactly the class-7 row owned by 20')
  assert.equal(result.updated, true)

  const t = tableFromIPC(readFileSync(path))
  const src = [...Array(3)].map((_, i) => t.getChild('source_id')!.get(i))
  const light = [...Array(3)].map((_, i) => t.getChild('aadt_light')!.get(i))
  assert.deepEqual(src, [0, 20, 99], 'row0 disowned, row1 kept, foreign row untouched')
  assert.equal(light[0], 0, 'retracted AADT zeroed')
  assert.equal(light[1], 111, 'kept AADT intact')
  assert.equal(light[2], 111, 'foreign AADT intact')
})

// ── R7 taper: the speed_taper derived-annotation column ─────────────────────

// Taper id from the registry (baseline rank — writes only onto empty rows).
const TAPER_ID = 9862

test('speedTaper: column created on first write; OSM speed_limit never touched', async () => {
  const path = writeRoadsFixture('taper-write.arrow', [4, 4], [0, 90])
  await writeRoadAadt(path, (_row, i) =>
    i === 0 ? { light: 500, medium: 10, heavy: 20, moto: 5, sourceId: TAPER_ID, speedTaper: 73 } : null)
  const t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('speed_taper')!.get(0), 73, 'graded speed in its own column')
  assert.equal(t.getChild('speed_taper')!.get(1), 0, 'untouched row reads 0')
  assert.equal(t.getChild('speed_limit')!.get(0), 0, 'OSM tag column untouched (row untagged)')
  assert.equal(t.getChild('speed_limit')!.get(1), 90, 'OSM tag preserved verbatim')
  assert.equal(t.getChild('source_id')!.get(0), TAPER_ID)

  // AADT-only write on a schema WITHOUT the column must not invent it.
  const plain = writeRoadsFixture('taper-nocol.arrow', [2])
  await writeRoadAadt(plain, () => ({ light: 700, medium: 1, heavy: 2, moto: 3, sourceId: 20 }))
  assert.equal(tableFromIPC(readFileSync(plain)).getChild('speed_taper'), null, 'no column invented')

  // Out-of-range payloads fail loud (0 means "omit", 255 is the derestricted sentinel).
  for (const bad of [0, 255, 70.5]) {
    await assert.rejects(
      writeRoadAadt(path, () => ({ light: 1, medium: 0, heavy: 0, moto: 0, sourceId: TAPER_ID, speedTaper: bad })),
      /invalid speedTaper/,
      `speedTaper ${bad} rejected`,
    )
  }
})

test('speedTaper is a derived annotation: any overwrite or retract clears it unless restated', async () => {
  const path = writeRoadsFixture('taper-clear.arrow', [4, 4], [0, 0])
  await writeRoadAadt(path, (_row, i) =>
    i === 0
      ? { light: 500, medium: 10, heavy: 20, moto: 5, sourceId: TAPER_ID, speedTaper: 73 }
      : { light: 0, medium: 0, heavy: 0, moto: 0, sourceId: TAPER_ID, speedTaper: 61 })

  // Taper re-run restates row 0 (new grade) and drops row 1 (retract sweep).
  await writeRoadAadt(
    path,
    (_row, i) => (i === 0 ? { light: 450, medium: 9, heavy: 18, moto: 4, sourceId: TAPER_ID, speedTaper: 68 } : null),
    undefined,
    undefined,
    { sourceId: TAPER_ID, when: (_row, i) => i !== 0 },
  )
  let t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('speed_taper')!.get(0), 68, 'restated grade wins')
  assert.equal(t.getChild('speed_taper')!.get(1), 0, 'retracted row cleared')
  assert.equal(t.getChild('source_id')!.get(1), 0)

  // A higher-rank census overwrite of the tapered row clears the annotation —
  // the ramp was computed from the state the census just replaced.
  await writeRoadAadt(path, (_row, i) =>
    i === 0 ? { light: 9000, medium: 200, heavy: 300, moto: 20, sourceId: 20 } : null)
  t = tableFromIPC(readFileSync(path))
  assert.equal(t.getChild('source_id')!.get(0), 20, 'census owns the row now')
  assert.equal(t.getChild('speed_taper')!.get(0), 0, 'stale graded speed cannot hide behind the census stamp')
})
