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

test('Wien gate: city points in, Lower Austria out', () => {
  const wien = makeCityGate('AUT', 'Wien(Stadt)')
  assert.equal(wien(48.2086, 16.3733), true, 'Stephansplatz')
  assert.equal(wien(48.247, 16.442), true, 'Kagran (Donaustadt)')
  assert.equal(wien(48.1381, 16.4786), false, 'Schwechat')
  assert.equal(wien(48.3045, 16.325), false, 'Klosterneuburg')
  assert.equal(wien(48.0856, 16.2831), false, 'Mödling')
})

test('Brno gate: city points in, Brno-venkov out', () => {
  const brno = makeCityGate('CZE', 'Brno-City')
  assert.equal(brno(49.1951, 16.6068), true, 'náměstí Svobody')
  assert.equal(brno(49.227, 16.523), true, 'Bystrc')
  assert.equal(brno(49.127, 16.613), false, 'Modřice')
  assert.equal(brno(49.169, 16.728), false, 'Šlapanice')
  assert.equal(brno(49.299, 16.531), false, 'Kuřim')
})

test('unknown ADM2 name fails loud with hints', () => {
  assert.throws(() => makeCityGate('CZE', 'Hlavní město Praha'), /not found in gbOpen CZE/)
})
