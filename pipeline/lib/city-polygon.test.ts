/**
 * Tests for the gbOpen ADM2 city gate. Uses the on-demand cached GeoJSON
 * (downloads once on a fresh host, same convention as country-polygon).
 * Run: `npx tsx --test pipeline/lib/city-polygon.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCityGate } from './city-polygon.js'

test('Prague gate: city points in, neighbours out', () => {
  const praha = makeCityGate('CZE', 'Prague')
  assert.equal(praha(50.081, 14.427), true, 'Václavské náměstí')
  assert.equal(praha(50.0726, 14.4304), true, 'Legerova')
  assert.equal(praha(50.05, 14.65), true, 'Dubeč (city edge district)')
  assert.equal(praha(49.8466, 14.2166), false, 'Kytín')
  assert.equal(praha(49.9916, 14.6547), false, 'Říčany')
  assert.equal(praha(50.1585, 14.3975), false, 'Roztoky')
})

test('unknown ADM2 name fails loud with hints', () => {
  assert.throws(() => makeCityGate('CZE', 'Hlavní město Praha'), /not found in gbOpen CZE/)
})
