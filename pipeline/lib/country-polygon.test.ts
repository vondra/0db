/**
 * Pins the three country-polygon predicates the #31/#32 ownership machinery
 * stands on: makeCountryGate membership, the shared segmentWhollyOutside
 * R9 rule (straddlers stay claimable), and the makeAnyCountryGate world
 * membership behind auditor R13 / heal-industrial-orphans.
 *
 * Needs the CGAZ cache (scripts/cache/geoBoundariesCGAZ_ADM0_s0005.geojson) —
 * present on every dev/build host; the gate self-downloads on a fresh one.
 *
 * Run: `cd pipeline && npx tsx --test lib/country-polygon.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCountryGate, makeAnyCountryGate, makeOwnershipGate, segmentWhollyOutside } from './country-polygon.js'

test('makeCountryGate: Dobříš is CZ, Vienna and Dresden are not', () => {
  const cz = makeCountryGate('CZ')
  assert.equal(cz(49.781, 14.167), true, 'Dobříš')
  assert.equal(cz(48.208, 16.373), false, 'Vienna')
  assert.equal(cz(51.050, 13.738), false, 'Dresden')
})

test('segmentWhollyOutside: only start+mid+end all-foreign is foreign (R9)', () => {
  const cz = makeCountryGate('CZ')
  // Dobříš→Dobříš: wholly inside.
  assert.equal(segmentWhollyOutside(cz, 49.781, 14.167, 49.78, 14.16, 49.782, 14.174), false)
  // Vienna→Vienna: wholly outside.
  assert.equal(segmentWhollyOutside(cz, 48.21, 16.37, 48.20, 16.36, 48.22, 16.38), true)
  // Border straddler Šatov(CZ)→Retz(AT): mid+end Austrian, start Czech — NOT foreign.
  assert.equal(segmentWhollyOutside(cz, 48.78, 15.98, 48.793, 16.006, 48.767, 15.955), false)
})

test('makeAnyCountryGate: Praha in some country, mid-Atlantic in none, NC via the non-CGAZ registry', () => {
  const anyCountry = makeAnyCountryGate()
  assert.equal(anyCountry(50.087, 14.421), true, 'Praha')
  assert.equal(anyCountry(0, -30), false, 'mid-Atlantic')
  assert.equal(anyCountry(-45, -140), false, 'south Pacific')
  // Nouméa has NO CGAZ feature — covered only by NON_CGAZ_OWNERSHIP_BBOXES;
  // if this fails, R14/heal-industrial-orphans starts eating legitimate NC
  // stamps again (Usine Koniambo was the round-3 false positive).
  assert.equal(anyCountry(-22.2758, 166.458), true, 'Nouméa (non-CGAZ ownership bbox)')
})

test('makeOwnershipGate: MA includes Western Sahara via COUNTRY_TERRITORY_EXTENSIONS', () => {
  const ma = makeOwnershipGate('MA')
  assert.equal(ma(34.02, -6.84), true, 'Rabat')
  assert.equal(ma(27.15, -13.20), true, 'Laâyoune (EH) — the extension, not MA proper')
  assert.equal(ma(27.2, -2.5), false, 'Algerian side (Tindouf province) stays out')
})
