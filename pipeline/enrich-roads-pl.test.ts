/**
 * parseGprXls: the national GPR sheet has extra "kraj."+"E" columns that the
 * provincial sheet lacks — fixed indices shifted every provincial value one
 * column left (cars → motorcycles; audit 2026-06-10 R1, DW943 moto=1704).
 * These tests pin the header-detected parser on BOTH layouts plus its two
 * fail-loud tripwires. Run: cd pipeline && npx tsx --test enrich-roads-pl.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { parseGprXls } from './enrich-roads-pl.js'

/** Header block shared by both layouts (rows 0-4 of the real files). */
const PREAMBLE = [
  ['GENERALNY POMIAR RUCHU 2020/2021'],
  ['ŚREDNI DOBOWY RUCH ROCZNY (SDRR)'],
  [' '],
  ['KRAJ'],
  [],
]

/** National layout: ...kraj. | E | Pikietaż... (SDRR at col 7, Motocykle 8, Sam. osob. 9). */
function nationalSheet(dataRows: unknown[][]): unknown[][] {
  return [
    ...PREAMBLE,
    ['Numer punktu pomiar.', 'Numer drogi', null, 'Opis odcinka', null, null, null, 'SDRR poj. silnik. ogółem', 'Rodzajowa struktura ruchu pojazdów silnikowych', null, null, null, null, null, null, 'Nr woj.'],
    [null, 'kraj.', 'E', 'Pikietaż', null, 'Długość (km)', 'Nazwa', null, 'Motocykle', 'Sam. osob. i mikrobusy', 'Lekkie sam. ciężarowe (dostawcze)', 'Sam. ciężarowe', null, 'Autobusy', 'Ciągniki rolnicze', null],
    [null, null, null, 'pocz. ', 'końc.', null, null, null, null, null, null, 'bez przycz.', 'z przycz.', null, null, null],
    [null, null, null, null, null, null, null, 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', null],
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'],
    ...dataRows,
  ]
}

/** Provincial layout: NO kraj./E columns — everything from col 2 sits one left. */
function provincialSheet(dataRows: unknown[][]): unknown[][] {
  return [
    ...PREAMBLE,
    ['Numer punktu pomiar.', 'Numer drogi', 'Opis odcinka', null, null, null, 'SDRR poj. silnik. ogółem', 'Rodzajowa struktura ruchu pojazdów silnikowych', null, null, null, null, null, null, 'Nr woj.', 'Kolejny'],
    [null, null, 'Pikietaż', null, 'Długość (km)', 'Nazwa', null, 'Motocykle', 'Sam. osob. mikrobusy', 'Lekkie sam. ciężarowe (dostawcze)', 'Sam. ciężarowe', null, 'Autobusy', 'Ciągniki rolnicze', null, null],
    [null, null, 'pocz. ', 'końc.', null, null, null, null, null, null, 'bez przycz.', 'z przycz.', null, null, null, null],
    [null, null, null, null, null, null, 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', 'poj./dobę', null, null],
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'],
    ...dataRows,
  ]
}

let dir: string
function writeXls(name: string, aoa: unknown[][]): string {
  dir ??= mkdtempSync(join(tmpdir(), 'gpr-test-'))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Tab02')
  const path = join(dir, name)
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xls' }))
  return path
}
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

// DW943 Koniaków–Laliki, row 24245 of the real provincial XLS (all eight values
// read from the cached file, 2026-06-11).
const DW943 = { sdrr: 2017, moto: 64, cars: 1704, light: 157, noTrail: 23, withTrail: 66, bus: 1, tractors: 2 }

test('national layout parses via header detection', () => {
  const path = writeXls('national.xls', nationalSheet([
    [10101, '1', 'E75', 0, 12.5, 12.5, 'GDAŃSK–TORUŃ', 30000, 300, 24000, 3000, 1500, 900, 250, 50, 14],
  ]))
  const rec = parseGprXls(path, 'national-test').get('10101')!
  assert.equal(rec.ref, '1')
  assert.equal(rec.imdTot, 30000)
  assert.equal(rec.motorcycles, 300)
  assert.equal(rec.cars, 24000)
  assert.equal(rec.lightTrucks, 3000)
  assert.equal(rec.trucksNoTrailer, 1500)
  assert.equal(rec.trucksWithTrailer, 900)
  assert.equal(rec.buses, 250)
})

test('provincial layout (no kraj./E columns) parses to the same fields — DW943 regression', () => {
  const path = writeXls('provincial.xls', provincialSheet([
    [24245, '943', 'KONIAKÓW–LALIKI', 0, 9.1, null, DW943.sdrr, DW943.moto, DW943.cars, DW943.light, DW943.noTrail, DW943.withTrail, DW943.bus, DW943.tractors, 24, 1],
  ]))
  const rec = parseGprXls(path, 'provincial-test').get('24245')!
  assert.equal(rec.ref, '943')
  assert.equal(rec.imdTot, 2017)
  // The v2 bug read cars (1704) into motorcycles; header detection must not.
  assert.equal(rec.motorcycles, 64)
  assert.equal(rec.cars, 1704)
  assert.equal(rec.lightTrucks, 157)
  assert.equal(rec.trucksNoTrailer, 23)
  assert.equal(rec.trucksWithTrailer, 66)
  assert.equal(rec.buses, 1)
  // CNOSSOS mapping downstream: light = cars + lightTrucks
  assert.equal(Math.round(rec.cars + rec.lightTrucks), 1861)
})

test('missing header column fails loud with the column name', () => {
  const broken = provincialSheet([[1, '1', 'X', 0, 1, null, 100, 1, 80, 10, 5, 2, 2, 0, 1, 1]])
    .map(row => row.map(c => (typeof c === 'string' && c.includes('Motocykle') ? 'Jednoślady' : c)))
  const path = writeXls('broken.xls', broken)
  assert.throws(() => parseGprXls(path, 'broken-test'), /motorcycles.*refusing to guess/s)
})

test('column-scramble tripwire: moto share > 15% throws', () => {
  // Simulate the v2 bug shape: cars-sized numbers in the Motocykle column.
  const path = writeXls('scrambled.xls', provincialSheet([
    [1, '943', 'A–B', 0, 1, null, 2017, 1704, 157, 33, 12, 34, 13, 24, 24, 1],
  ]))
  assert.throws(() => parseGprXls(path, 'scrambled-test'), /motorcycle share.*column-scramble/s)
})
