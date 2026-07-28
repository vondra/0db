/**
 * Pins AdminAt (lib/admin-at.ts) — the ONE point → country/city/continent
 * resolver (plan M2 §1): exact CGAZ PIP over the global part index, the
 * uniquely-attributable 2 km coastal fallback (never first-candidate-wins),
 * country-gated metros, the shared continent table, and antimeridian handling
 * (Fiji's split parts + Antarctica's pole-enclosing seam ring).
 *
 * Needs the CGAZ cache (scripts/cache/geoBoundariesCGAZ_ADM0_s0005.geojson) —
 * same requirement as country-polygon.test.ts; registered as a network test in
 * scripts/test.mjs (self-downloads on a fresh host).
 *
 * Run: `cd pipeline && npx tsx --test lib/admin-at.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adminAt,
  antimeridianLerp,
  antimeridianMidpoint,
  cityAt,
  continentForIso,
} from './admin-at.js'

test('adminAt: exact PIP on known points', () => {
  assert.equal(adminAt(50.087, 14.421).iso2, 'CZ', 'Praha')
  assert.equal(adminAt(1.352, 103.82).iso2, 'SG', 'Singapore')
  // Koh Phangan interior — the M2 trigger case: a sea-centroid hex whose
  // segments must still resolve TH.
  assert.equal(adminAt(9.705, 100.017).iso2, 'TH', 'Koh Phangan')
  // Hlučínsko salient — Natural Earth said PL; CGAZ says CZ.
  assert.equal(adminAt(49.98953, 18.1288).iso2, 'CZ', 'Hlučínsko salient')
})

test('adminAt: holes and microstates', () => {
  assert.equal(adminAt(-29.31, 27.48).iso2, 'LS', 'Maseru (Lesotho hole in ZA)')
  assert.equal(adminAt(43.7384, 7.4246).iso2, 'MC', 'Monaco')
  assert.equal(adminAt(41.9029, 12.4534).iso2, 'VA', 'Vatican inside IT')
  assert.equal(adminAt(43.9424, 12.4578).iso2, 'SM', 'San Marino inside IT')
})

test('adminAt: open sea and strait ambiguity stay undefined', () => {
  assert.equal(adminAt(0, -30).iso2, undefined, 'mid-Atlantic')
  assert.equal(adminAt(-45, -140).iso2, undefined, 'south Pacific')
  // Johor Strait mid-channel: SG and MY coasts both within the 2 km buffer —
  // uniquely attributable NEVER fires across a narrow strait.
  assert.equal(adminAt(1.452, 103.768).iso2, undefined, 'Johor Strait mid-channel')
})

test('adminAt: coastal fallback attributes only when uniquely attributable', () => {
  // ~500 m west of the Koh Phangan coast: over sea, TH coast uniquely within
  // 2 km → TH (piers / reclaimed land case). (9.72, 99.985 is INSIDE the
  // polygon — not a fallback probe; 99.975 is offshore, verified 2026-07-28.)
  assert.equal(adminAt(9.72, 99.975).iso2, 'TH', 'offshore Koh Phangan')
  // >2 km off the same coast → open sea.
  assert.equal(adminAt(9.72, 99.95).iso2, undefined, 'open sea off Koh Phangan')
})

test('adminAt: antimeridian — Fiji parts on both sides of ±180°', () => {
  assert.equal(adminAt(-18.1416, 178.4419).iso2, 'FJ', 'Suva (east of seam)')
  assert.equal(adminAt(-16.83, -179.97).iso2, 'FJ', 'Taveuni (west of seam)')
  assert.equal(adminAt(-16.5, 180).iso2, 'FJ', 'right on the seam near Fiji')
})

test('adminAt: Antarctica via the pole-enclosing seam ring', () => {
  assert.equal(adminAt(-80, 120).iso2, 'AQ', 'interior (pole-spike meridian)')
  assert.equal(adminAt(-85, 50).iso2, 'AQ', 'deep interior')
  assert.equal(adminAt(-80, 0).iso2, 'AQ', 'interior at the prime meridian')
  assert.equal(adminAt(-66, 110).iso2, undefined, 'offshore — CGAZ coast at 110E is ~-66.5')
  assert.equal(adminAt(-60, -70).iso2, undefined, 'Drake Passage')
})

test('adminAt: invalid input fails safe', () => {
  assert.equal(adminAt(NaN, 14).iso2, undefined)
  assert.equal(adminAt(91, 14).iso2, undefined)
})

test('cityAt: metro assigns only inside its own country', () => {
  assert.equal(cityAt(13.75, 100.5, 'TH'), 22, 'Bangkok metro id')
  assert.equal(cityAt(13.75, 100.5, 'KH'), 0, 'gated: right rectangle, wrong country')
  assert.equal(cityAt(13.75, 100.5, undefined), 0, 'no country → no metro')
  assert.equal(cityAt(49.0, 10.0, 'DE'), 0, 'rural Bavaria → no metro')
})

test('continentForIso: the ONE shared table', () => {
  assert.equal(continentForIso('CZ'), 'Europe')
  assert.equal(continentForIso('FJ'), 'Oceania')
  assert.equal(continentForIso('CL'), 'SouthAmerica')
  assert.equal(continentForIso('AQ'), undefined, 'Antarctica has no continent arm')
  assert.equal(continentForIso('XX'), undefined)
})

test('antimeridianMidpoint/Lerp: longitude wraps the short way', () => {
  const [lat, lon] = antimeridianMidpoint(0, 179.9, 0, -179.9)
  assert.equal(lat, 0)
  assert.ok(Math.abs(Math.abs(lon) - 180) < 1e-9, `expected ±180, got ${lon}`)
  // Same result via lerp at t=0.5; endpoints interpolate normally inland.
  assert.deepEqual(antimeridianLerp(0, 179.9, 0, -179.9, 0.5), [lat, lon])
  assert.deepEqual(antimeridianLerp(10, 14, 20, 24, 0.25), [12.5, 16.5])
})
