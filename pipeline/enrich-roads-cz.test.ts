// Unit tests for the CZ ŘSD matcher's guard rails — the strict ref
// normalisation and the ŘSD-category rank map behind the class gate.
// Run: cd pipeline && npx tsx --test enrich-roads-cz.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeOsmRef, rsdRank } from './enrich-roads-cz.js'

test('normalizeOsmRef keeps real road refs', () => {
  assert.equal(normalizeOsmRef('I/34'), '34')
  assert.equal(normalizeOsmRef('II/150'), '150')
  assert.equal(normalizeOsmRef('III/11620'), '11620')
  assert.equal(normalizeOsmRef('D1'), 'D1')
  assert.equal(normalizeOsmRef('150'), '150')
  assert.equal(normalizeOsmRef('104a'), '104') // letter suffix variants
})

test('normalizeOsmRef rejects non-road refs', () => {
  // The Plzeň bug: a street address mis-tagged as ref must NOT reduce to a
  // road number and inherit silnice I/20's 17k count.
  assert.equal(normalizeOsmRef('Zelená 20'), '')
  assert.equal(normalizeOsmRef('K Šeberovu 33'), '')
  assert.equal(normalizeOsmRef('E50'), '')  // international numbering
  assert.equal(normalizeOsmRef(''), '')
  assert.equal(normalizeOsmRef('ulice 5. května'), '')
})

test('rsdRank maps PKOD_R categories onto the shared 0..4 scale', () => {
  // Shapes measured from the 2026 ŘSD cache: PSILNICE is a bare number for
  // everything but D-roads; the category is PKOD_R.
  assert.equal(rsdRank('D1', '1'), 0)
  assert.equal(rsdRank('D4', '5'), 0)   // expressway
  assert.equal(rsdRank('3', '2'), 1)    // silnice I/3
  assert.equal(rsdRank('34', '6'), 1)   // silnice I/34 (E-route code)
  assert.equal(rsdRank('603', '3'), 3)  // silnice II/603
  assert.equal(rsdRank('11628', '4'), 4) // silnice III/11628
})
