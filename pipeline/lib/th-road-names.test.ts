/**
 * Tests for the TH from-to name matcher (M6 pilot). Pure-function coverage:
 * normalization variants, census/OSM place extraction, class gate, province
 * extents, and the ambiguity rules that turn a collision into NO match.
 *
 * Run: `cd pipeline && npx tsx --test lib/th-road-names.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeThaiPlace,
  stripPlacePrefix,
  extractCensusPlaces,
  extractOsmPlaces,
  buildCensusRows,
  classCompatible,
  buildPrefixExtents,
  inExtent,
  buildPlaceIndex,
  matchByName,
  type DrrCensusRow,
} from './th-road-names.js'

const n = normalizeThaiPlace

test('normalizeThaiPlace: tone marks, sara-am encoding, ณ/น, ร/ล folds, whitespace', () => {
  assert.equal(normalizeThaiPlace('หาดริ้น'), normalizeThaiPlace('หาดริน')) // tone mark dropped
  assert.equal(normalizeThaiPlace('บ้านน้ําย้อย'), normalizeThaiPlace('บ้านน้ำย้อย')) // ํ+า ≡ ำ
  assert.equal(normalizeThaiPlace('พระณรงค์'), normalizeThaiPlace('พระนรงค์')) // ณ→น
  assert.equal(normalizeThaiPlace('โฉลกหลำ'), normalizeThaiPlace('โฉรกหรำ')) // ล→ร
  assert.equal(normalizeThaiPlace('บ้านน้ำ ย้อย'), normalizeThaiPlace('บ้านน้ำย้อย')) // whitespace
  assert.equal(normalizeThaiPlace('Haad Rin'), 'haadrin') // latin lowercase
})

test('stripPlacePrefix: one leading structural word only', () => {
  assert.equal(stripPlacePrefix('บ้านท้องศาลา'), 'ท้องศาลา')
  assert.equal(stripPlacePrefix('หาดริ้น'), 'ริ้น')
  assert.equal(stripPlacePrefix('หมู่บ้านจอมทอง'), 'จอมทอง')
  // interior structural words survive: บ้านทุ่งทอง ≠ บ้านทอง
  assert.equal(stripPlacePrefix('บ้านทุ่งทอง'), 'ทุ่งทอง')
  assert.equal(stripPlacePrefix('ทุ่งทอง'), 'ทุ่งทอง')
})

test('extractCensusPlaces: village pair', () => {
  const p = extractCensusPlaces('บ้านท้องศาลา - บ้านโฉลกหลำ')
  assert.deepEqual([...p].sort(), [n('ท้องศาลา'), n('โฉลกหลำ')].sort())
})

test('extractCensusPlaces: highway-junction side is not a place', () => {
  const p = extractCensusPlaces('แยกทางหลวงหมายเลข 324 (กม.ที่ 18+700) - บ้านบ่อพลอย')
  assert.deepEqual([...p], [n('บ่อพลอย')]) // single usable place → row not name-matchable
})

test('extractCensusPlaces: rural-road junction side is not a place', () => {
  const p = extractCensusPlaces('แยกทางหลวงชนบท สฎ.2007 - บ้านคลองราง')
  assert.deepEqual([...p], [n('คลองราง')])
})

test('extractCensusPlaces: line designation and single-place names yield nothing usable', () => {
  assert.equal(extractCensusPlaces('สาย ก (ง) ผังเมืองรวมเมืองสุราษฎร์ธานี').size, 0)
  assert.equal(extractCensusPlaces('แยกน้ำตกธารเสด็จ').size, 1) // one place → skipped by caller
  assert.equal(extractCensusPlaces('หน้าอำเภอ - บ้านเหนือ').size, 1) // หน้าอำเภอ strips to empty
})

test('extractCensusPlaces: multiline quoted name (real CSV row ตง.3002)', () => {
  const p = extractCensusPlaces('แยกทางหลวงหมายเลข 419   (กม.ที่  2+900) -\nบ้านหลังเขา')
  assert.deepEqual([...p], [n('หลังเขา')])
})

test('extractCensusPlaces: inline junction phrase is cut, road name kept', () => {
  // Real row ชพ.5057: the census name leads with the road's own name, then a
  // rural-road junction reference — the place is อุทุมพร, the rest is noise.
  const p = extractCensusPlaces('ถนนอุทุมพร แยกทางหลวงชนบท ชพ.5056 (กม.ที่ 0+200) - บ้านวังเกลือ')
  assert.deepEqual([...p].sort(), [n('อุทุมพร'), n('วังเกลือ')].sort())
  // Named-road junction: "แยกถนนX (กม.…)" — X is a place anchor, ถนน strips.
  const q = extractCensusPlaces('แยกถนนพัฒนาการคูขวาง (กม.ที่ 3+900) - บ้านนาวง')
  assert.deepEqual([...q].sort(), [n('พัฒนาการคูขวาง'), n('นาวง')].sort())
})

test('extractOsmPlaces: ถนน from-to with บ้าน prefix on one side', () => {
  const p = extractOsmPlaces('ถนนท้องศาลา-บ้านค่าย')
  assert.deepEqual([...p].sort(), [n('ท้องศาลา'), n('ค่าย')].sort())
})

test('extractOsmPlaces: numbered soi keeps its digit (no inheritance)', () => {
  const p = extractOsmPlaces('ซอยบ้านแหลม 4')
  assert.deepEqual([...p], [n('แหลม 4')])
  assert.notEqual([...p][0], n('แหลม'))
})

test('extractOsmPlaces: latin names work, "Road to X" is single-place', () => {
  assert.deepEqual([...extractOsmPlaces('Road to Lost Bar')], [n('Lost Bar')])
  const p = extractOsmPlaces('Chaweng Choengmon Road')
  assert.equal(p.size, 1)
})

test('classCompatible: DRR hierarchy gates', () => {
  assert.equal(classCompatible(6064, 3), true) // 6xxx → secondary ok
  assert.equal(classCompatible(6064, 4), true) // 6xxx → tertiary ok
  assert.equal(classCompatible(6064, 2), false) // 6xxx → never primary
  assert.equal(classCompatible(2007, 2), true) // 2xxx → primary ok
  assert.equal(classCompatible(2007, 5), false) // never residential
  assert.equal(classCompatible(3001, 9), false) // never unclassified
  assert.equal(classCompatible(3001, 12), false) // never a link
  assert.equal(classCompatible(1, 3), false) // ส.0xx Bangkok bridge: not class-mapped
})

test('buildPrefixExtents: median window discards a far mis-tagged ref', () => {
  const pts: [number, number][] = []
  for (let i = 0; i < 10; i++) pts.push([18.7 + i * 0.01, 98.9 + i * 0.01]) // Chiang Mai cluster
  pts.push([13.7, 100.5]) // mis-tag in Bangkok
  const ext = buildPrefixExtents(new Map([['ชม', pts]])).get('ชม')!
  assert.ok(inExtent(18.75, 98.95, ext))
  assert.ok(!inExtent(13.7, 100.5, ext), 'mis-tagged point must not widen the gate')
})

function row(code: string, name: string): DrrCensusRow {
  const dot = code.lastIndexOf('.')
  return {
    code,
    prefix: code.slice(0, dot),
    num: parseInt(code.slice(dot + 1), 10),
    name,
    light: 100,
    medium: 10,
    heavy: 10,
    moto: 100,
    total: 220,
    places: extractCensusPlaces(name),
  }
}

test('matchByName: unique pair match wins; gates and ambiguity behave', () => {
  const rows = [
    row('สฎ.6064', 'บ้านใต้ - หาดริ้น'),
    row('สฎ.6061', 'บ้านใต้ - ท้องนายปาน'),
    row('ชย.3016', 'แยกทางหลวงหมายเลข 202 (กม.ที่ 136+120) - บ้านค่าย'),
  ]
  const idx = buildPlaceIndex(rows)
  const ext = buildPrefixExtents(
    new Map([
      ['สฎ', [[9.7, 100.0]]],
      ['ชย', [[16.0, 102.0]]],
    ]),
  )

  // ถนนบ้านใต้-หาดริ้น on Phangan → สฎ.6064 (unique: 6061 shares only ใต้)
  const m1 = matchByName(extractOsmPlaces('ถนนบ้านใต้-หาดริ้น'), 3, 9.7, 100.02, idx, ext)
  assert.equal(m1.status, 'match')
  assert.equal((m1 as { row: DrrCensusRow }).row.code, 'สฎ.6064')

  // same name in Chaiyaphum (different province extent) → none
  assert.equal(matchByName(extractOsmPlaces('ถนนบ้านใต้-หาดริ้น'), 3, 16.0, 102.0, idx, ext).status, 'none')

  // ถนนท้องศาลา-บ้านค่าย: ชย.3016 has only one usable place (ค่าย side
  // junction-dropped… actually its pair side is a highway junction) → no row
  // ever reaches ≥2 shared places → none (the documented Phangan case)
  assert.equal(matchByName(extractOsmPlaces('ถนนท้องศาลา-บ้านค่าย'), 3, 9.7, 100.02, idx, ext).status, 'none')

  // class gate: 6xxx never claims a primary
  assert.equal(matchByName(extractOsmPlaces('ถนนบ้านใต้-หาดริ้น'), 2, 9.7, 100.02, idx, ext).status, 'none')

  // ambiguity: two rows with the same pair in one extent → NO match
  const rows2 = [row('สฎ.6064', 'บ้านใต้ - หาดริ้น'), row('สฎ.6066', 'หาดริ้น - บ้านใต้')]
  const idx2 = buildPlaceIndex(rows2)
  const m2 = matchByName(extractOsmPlaces('ถนนบ้านใต้-หาดริ้น'), 3, 9.7, 100.02, idx2, ext)
  assert.equal(m2.status, 'ambiguous')
  assert.deepEqual((m2 as { codes: string[] }).codes.sort(), ['สฎ.6064', 'สฎ.6066'])

  // single-place OSM name never matches
  assert.equal(matchByName(extractOsmPlaces('ถนนเพชรเกษม'), 3, 9.7, 100.02, idx2, ext).status, 'none')
})

test('buildCensusRows: split, junction/single-place rows dropped, no-split dropped', () => {
  const rec = (code: string, name: string, mc: string, sum: string): Record<string, string> => ({
    road_code: code,
    road_name: name,
    MC: mc,
    SV: '10',
    SVT: '0',
    TB2: '1',
    TB3: '0',
    T4: '0',
    ART3: '0',
    ART4: '0',
    ART5: '0',
    ART6: '0',
    BD: '1',
    DRT: '0',
    sum_AADT: sum,
  })
  const { rows, noPlaces } = buildCensusRows([
    rec('สฎ.6064', 'บ้านใต้ - หาดริ้น', '100', '220'),
    rec('สฎ.5067', 'แยกทางหลวงชนบท สฎ.2007 - บ้านคลองราง', '10', '100'), // single place
    rec('กจ.3001', 'แยกทางหลวงหมายเลข 324 (กม.ที่ 18+700) - บ้านบ่อพลอย', '10', '100'), // single place
  ])
  assert.equal(rows.length, 1)
  assert.equal(noPlaces, 2)
  const r = rows[0]
  assert.equal(r.code, 'สฎ.6064')
  assert.deepEqual([r.light, r.medium, r.heavy, r.moto], [10, 2, 0, 100])
  assert.equal(r.total, 220)
})
