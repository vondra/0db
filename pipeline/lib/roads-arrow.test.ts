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
 *  Seeds distinctive AADT values (1000+i pattern) so "untouched" is provable. */
function writeRoadsFixture(name: string, classes: number[]): string {
  const idx = [...classes.keys()]
  const table = new Table({
    ref: vectorFromArray(idx.map(i => `R${i}`), new Utf8()),
    start_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001), new Float64()),
    start_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001), new Float64()),
    end_lat: vectorFromArray(idx.map(i => 50.0 + i * 0.001 + 0.0005), new Float64()),
    end_lon: vectorFromArray(idx.map(i => 14.0 + i * 0.001 + 0.0005), new Float64()),
    road_class: vectorFromArray(classes, new Uint8()),
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
