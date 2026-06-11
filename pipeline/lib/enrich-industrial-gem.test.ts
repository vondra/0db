/**
 * Invariant (iii) of the 2026-06 audit wave (A3/C2): power-plant fuel→NACE.
 *
 * Pins `DEFAULT_FUEL_TO_NACE` (the f4818ef9 fix) and statically guards the
 * three bespoke enrichers fixed in 5f1b969f/0a71a30e against the original bug
 * shapes: a GEM loader stamping a hard-coded thermal NACE regardless of fuel
 * (`nace: '351100'`), and the inline ternary that sent wind→351200 with a
 * 351100 catch-all (`...('wind') ? 351200 : 351100`).
 *
 * Run: `cd pipeline && npx tsx --test lib/enrich-industrial-gem.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_FUEL_TO_NACE } from './enrich-industrial-gem.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── DEFAULT_FUEL_TO_NACE pins ───────────────────────────────────────────────
// Engine NACE→noise (industrial.rs): 3599 solar 55 dB, 3512 hydro 90 dB,
// 3511 thermal 97 dB. Wind is source_type=10 (own rotating-source model) and
// blank fuel must not be guessed as 97 dB thermal — both SKIP via null.

test('wind → null (skip — modelled as source_type=10, never an industrial NACE)', () => {
  assert.equal(DEFAULT_FUEL_TO_NACE('wind'), null)
  assert.equal(DEFAULT_FUEL_TO_NACE('offshore wind'), null)
})

test('blank/unknown fuel → null (skip — never guess 97 dB thermal)', () => {
  assert.equal(DEFAULT_FUEL_TO_NACE(''), null)
  assert.equal(DEFAULT_FUEL_TO_NACE('unknown'), null)
})

test('solar → 3599 (55 dB)', () => {
  assert.equal(DEFAULT_FUEL_TO_NACE('solar'), 3599)
})

test('hydro → 3512 (90 dB)', () => {
  assert.equal(DEFAULT_FUEL_TO_NACE('hydro'), 3512)
  assert.equal(DEFAULT_FUEL_TO_NACE('hydropower'), 3512)
})

test('thermal family → 3511 (97 dB)', () => {
  for (const fuel of ['coal', 'gas', 'nuclear', 'biomass', 'oil', 'geothermal']) {
    assert.equal(DEFAULT_FUEL_TO_NACE(fuel), 3511, `${fuel} must map to 3511`)
  }
})

// ── Static-source regression: enrich-industrial-{co,ve,za}.ts ───────────────
// These three keep a bespoke local fuelToNace (fixed in 5f1b969f). The guard is
// scoped to the BUG SHAPE so the legitimate literals survive: the thermal arm
// inside fuelToNace and ve's VE360 loaders (a thermal-only dataset) may return
// '351100'; the GEM loader (mixed fuels) must not.

const BESPOKE_ENRICHERS = ['co', 've', 'za'] as const

/** The body of the function that loads `power-plants-gem.geojson` — top-level
 *  `function …(…) { … }` blocks in these files, so slice from the preceding
 *  `function` keyword to the next column-0 closing brace. */
function gemLoaderBody(source: string, file: string): string {
  const anchor = source.indexOf('power-plants-gem.geojson')
  assert.ok(anchor >= 0, `${file}: GEM loader (power-plants-gem.geojson) not found`)
  const start = source.lastIndexOf('\nfunction ', anchor)
  const end = source.indexOf('\n}', anchor)
  assert.ok(start >= 0 && end > start, `${file}: cannot slice GEM loader body`)
  return source.slice(start, end + 2)
}

for (const cc of BESPOKE_ENRICHERS) {
  const file = `enrich-industrial-${cc}.ts`
  const source = readFileSync(resolve(__dirname, '..', file), 'utf8')

  test(`${file}: GEM loader routes through fuelToNace, no hard-coded NACE literal`, () => {
    const body = gemLoaderBody(source, file)
    assert.ok(/fuelToNace\s*\(/.test(body), `${file}: GEM loader must call fuelToNace()`)
    assert.ok(!/nace:\s*['"`]?\d/.test(body),
      `${file}: GEM loader stamps a literal NACE — the pre-5f1b969f bug shape`)
  })

  test(`${file}: no wind→NACE ternary (pre-0a71a30e bug shape)`, () => {
    // `…includes('wind') ? 351200 : …` — wind must skip, never map to a NACE.
    assert.ok(!/wind[^\n]{0,60}\?\s*['"`]?35\d{2}/.test(source),
      `${file}: wind maps to a 35xx NACE`)
    // `? 351200 : 351100` — the catch-all thermal fallback tail.
    assert.ok(!/\?\s*['"`]?35\d{4}['"`]?\s*:\s*['"`]?351100/.test(source),
      `${file}: catch-all 351100 ternary fallback`)
  })
}
