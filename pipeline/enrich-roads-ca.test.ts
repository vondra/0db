// Unit tests for the Québec MTQ matcher's guard rails — route-ref
// normalisation and the route-number rank map.
// Run: cd pipeline && npx tsx --test enrich-roads-ca.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeQcRef, qcRouteRank } from './enrich-roads-ca.js'

test('normalizeQcRef accepts Québec route refs', () => {
  assert.equal(normalizeQcRef('A-20'), 20)
  assert.equal(normalizeQcRef('R-138'), 138)
  assert.equal(normalizeQcRef('138'), 138)
  assert.equal(normalizeQcRef('138 Est'), 138)
  assert.equal(normalizeQcRef('20;132'), 20) // first token wins
})

test('normalizeQcRef rejects free text and out-of-band tokens', () => {
  assert.equal(normalizeQcRef('Rue Principale 20'), null)
  assert.equal(normalizeQcRef('Chemin 5e Rang'), null)
  assert.equal(normalizeQcRef(''), null)
  assert.equal(normalizeQcRef('1234'), null) // 4-digit = not a QC route ref
})

test('qcRouteRank maps route bands onto the shared 0..4 scale', () => {
  assert.equal(qcRouteRank(20), 0)   // autoroute
  assert.equal(qcRouteRank(440), 0)  // autoroute 400-series
  assert.equal(qcRouteRank(138), 1)  // nationale
  assert.equal(qcRouteRank(245), 2)  // régionale
  assert.equal(qcRouteRank(342), 3)  // collectrice
})
