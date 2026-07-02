/**
 * Writer-level invariant tests for `writeBuildingEnrichment` — the two
 * settlement-v2 deploy blockers (/gg phase-2 review): contract-metadata
 * preservation across rewrites and the building_type specificity gate.
 *
 * The v2 fixture mirrors `osm-extract::finalize::write_buildings` on branch
 * settlement-phase2 (70b4dbeb): full column set, `buildings_contract =
 * buildings_v2` schema metadata, `opening_hours_frac` column, POI-join
 * classes 11/12 present.
 *
 * Run: `cd pipeline && npx tsx --test lib/buildings-arrow.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tableFromIPC, tableToIPC, tableFromArrays } from 'apache-arrow'
import { writeBuildingEnrichment } from './buildings-arrow.js'

// cz-ruian-vfr — a real national registry id, so shouldOverwrite(0, id) passes.
const STAMP_ID = 200

const TMP = mkdtempSync(join(tmpdir(), 'buildings-arrow-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** v2 buildings.arrow fixture: 6 rows covering coarse (0,1) and POI-join
 *  (11 HOUSE, 12 FOOD_RETAIL) classes. types[i] / floors 0 for i<2. */
function writeV2Fixture(name: string, types: number[]): string {
  const n = types.length
  const t = tableFromArrays({
    osm_id: BigInt64Array.from(types.map((_, i) => BigInt(1000 + i))),
    centroid_lat: Float64Array.from(types.map((_, i) => 49.9 + i * 1e-4)),
    centroid_lon: Float64Array.from(types.map((_, i) => 14.2 + i * 1e-4)),
    building_type: Uint8Array.from(types),
    building_use: new Uint8Array(n),
    height: Float32Array.from(types.map(() => 7.5)),
    floors: Uint8Array.from(types.map((_, i) => (i < 2 ? 0 : 2))),
    area_m2: Float32Array.from(types.map(() => 120)),
    source_id: new Uint16Array(n),
    opening_hours_frac: Uint8Array.from(types.map(() => 2)),
  })
  t.schema.metadata.set('buildings_contract', 'buildings_v2')
  const path = join(TMP, name)
  writeFileSync(path, Buffer.from(tableToIPC(t, 'file')))
  return path
}

function readTable(path: string) {
  return tableFromIPC(readFileSync(path))
}

function typeHistogram(t: ReturnType<typeof readTable>): Map<number, number> {
  const col = t.getChild('building_type')!
  const h = new Map<number, number>()
  for (let i = 0; i < t.numRows; i++) h.set(col.get(i) as number, (h.get(col.get(i) as number) ?? 0) + 1)
  return h
}

test('v2 contract metadata + columns survive a floors-only rewrite', async () => {
  const path = writeV2Fixture('meta.arrow', [0, 1, 11, 12, 0, 1])
  const before = readTable(path)
  const histBefore = typeHistogram(before)

  const r = await writeBuildingEnrichment(path, (row) =>
    row.floors === 0 ? { floors: 4, sourceId: STAMP_ID } : null)
  assert.equal(r.matched, 2)
  assert.equal(r.updated, true)

  const after_ = readTable(path)
  assert.equal(after_.schema.metadata.get('buildings_contract'), 'buildings_v2',
    'the per-file contract stamp the heatmap loader fail-loud asserts must survive')
  assert.ok(after_.getChild('opening_hours_frac'), 'v2 column must survive')
  assert.equal(after_.getChild('opening_hours_frac')!.get(0), 2)
  assert.deepEqual([...typeHistogram(after_)], [...histBefore],
    'a floors-only enrichment must not move the building_type histogram')
  // nullable flags preserved (v2 writes floors/building_type non-null)
  const f = after_.schema.fields.find(x => x.name === 'height')!
  assert.equal(f.nullable, before.schema.fields.find(x => x.name === 'height')!.nullable)
})

test('coarse type never downgrades a v2 POI-join class; floors still apply', async () => {
  const path = writeV2Fixture('specificity.arrow', [1, 11, 12, 13, 10, 0])
  // a RÚIAN-style coarse refinement on every row: type 0, floors 5
  const r = await writeBuildingEnrichment(path, () => ({ floors: 5, buildingType: 0, sourceId: STAMP_ID }))
  assert.equal(r.typeDowngradesBlocked, 4, 'all four 10-13 rows keep their class')

  const t = readTable(path)
  const types = Array.from({ length: t.numRows }, (_, i) => t.getChild('building_type')!.get(i))
  assert.deepEqual(types, [0, 11, 12, 13, 10, 0], 'coarse rows updated, specific rows kept')
  const floors = Array.from({ length: t.numRows }, (_, i) => t.getChild('floors')!.get(i))
  assert.deepEqual(floors, [5, 5, 5, 5, 5, 5], 'floors from the same match still apply everywhere')
})

test('upgrade coarse → specific is allowed', async () => {
  const path = writeV2Fixture('upgrade.arrow', [1, 1])
  await writeBuildingEnrichment(path, () => ({ buildingType: 12, sourceId: STAMP_ID }))
  const t = readTable(path)
  assert.equal(t.getChild('building_type')!.get(0), 12)
  assert.equal(t.schema.metadata.get('buildings_contract'), 'buildings_v2')
})

test('no-op match leaves the file byte-identical', async () => {
  const path = writeV2Fixture('noop.arrow', [0, 1, 11])
  const bytesBefore = readFileSync(path)
  const r = await writeBuildingEnrichment(path, () => null)
  assert.equal(r.updated, false)
  assert.ok(bytesBefore.equals(readFileSync(path)))
})

test('a v1 arrow (no contract metadata) round-trips without inventing one', async () => {
  const t = tableFromArrays({
    centroid_lat: Float64Array.from([49.9]),
    centroid_lon: Float64Array.from([14.2]),
    building_type: Uint8Array.from([1]),
    floors: Uint8Array.from([0]),
    source_id: new Uint16Array(1),
  })
  const path = join(TMP, 'v1.arrow')
  writeFileSync(path, Buffer.from(tableToIPC(t, 'file')))
  await writeBuildingEnrichment(path, () => ({ floors: 3, sourceId: STAMP_ID }))
  const out = readTable(path)
  assert.equal(out.schema.metadata.get('buildings_contract'), undefined)
  assert.equal(out.getChild('floors')!.get(0), 3)
})

test('malformed patch fails loud', async () => {
  const path = writeV2Fixture('badpatch.arrow', [0])
  await assert.rejects(
    () => writeBuildingEnrichment(path, () => ({ floors: NaN as number, sourceId: STAMP_ID })),
    /invalid patch/)
  await assert.rejects(
    () => writeBuildingEnrichment(path, () => ({ buildingType: 14, sourceId: STAMP_ID })),
    /invalid patch/, 'class ids above MAX_BUILDING_TYPE never reach the file')
  await assert.rejects(
    () => writeBuildingEnrichment(path, () => ({ floors: 2, sourceId: 0 })),
    /invalid patch/)
})
