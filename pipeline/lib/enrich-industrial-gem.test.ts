/**
 * Invariant (iii) of the 2026-06 audit wave (A3/C2): power-plant fuel→NACE.
 *
 * Pins `DEFAULT_FUEL_TO_NACE` (the f4818ef9 fix) and statically guards the
 * three bespoke enrichers fixed in 5f1b969f/0a71a30e against the original bug
 * shapes: a GEM loader stamping a hard-coded thermal NACE regardless of fuel
 * (`nace: '351100'`), and the inline ternary that sent wind→351200 with a
 * 351100 catch-all (`...('wind') ? 351200 : 351100`).
 *
 * Also pins the #31.1 country-scoped ownership of `stampOneWinner`: sibling
 * passes share source_id 330, so a pass may reset (and stamp) ONLY rows inside
 * its own COUNTRY polygon — never its whole hand bbox (the
 * ML-bbox-blankets-BF data-loss shape), and never proximity-scoped (which
 * broke CO's two-tier sweep and stayed border-ambiguous).
 *
 * Run: `cd pipeline && npx tsx --test lib/enrich-industrial-gem.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromIPC, tableToIPC, vectorFromArray, Table, Float64, Uint8, Uint16 } from 'apache-arrow'
import { cellToLatLng, latLngToCell } from 'h3-js'
import { DEFAULT_FUEL_TO_NACE, NATIONAL_MIX, stampOneWinner } from './enrich-industrial-gem.js'
import { inBbox } from './spatial.js'

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

// ── stampOneWinner: country-scoped ownership (#31.1) ────────────────────────
// Two "country" passes share source_id 330; their hand BBOXES overlap (the
// BF/ML shape) but their COUNTRY polygons are disjoint (a border at
// C_LON + 0.075). Pass A stamps its winner inside the bbox overlap; pass B must
// (a) NOT reset A's row — inside B's bbox but inside country A (the old
//     blanket clear zeroed it),
// (b) still reset ITS OWN stale stamp anywhere in country B (self-heal is
//     country-wide — the CO two-tier sweep semantics), and
// (c) stamp its own winner.

const HEX = latLngToCell(0.1, -0.3, 4)
const [C_LAT, C_LON] = cellToLatLng(HEX)
// Overlapping bboxes around the hex centre: A reaches 0.3° east of centre,
// B starts 0.3° west of it — everything below sits inside BOTH.
const BBOX_A: readonly [number, number, number, number] = [C_LAT - 1, C_LON - 1.7, C_LAT + 1, C_LON + 0.3]
const BBOX_B: readonly [number, number, number, number] = [C_LAT - 1, C_LON - 0.3, C_LAT + 1, C_LON + 1.7]
const inA = (lat: number, lon: number) => inBbox(lat, lon, BBOX_A)
const inB = (lat: number, lon: number) => inBbox(lat, lon, BBOX_B)
// Disjoint "country polygons": the border runs at C_LON + 0.075.
const BORDER_LON = C_LON + 0.075
const countryA = (_lat: number, lon: number) => lon < BORDER_LON
const countryB = (_lat: number, lon: number) => lon >= BORDER_LON

// row 0: A's winner polygon (bbox-overlap zone, country A, ~550 m from plant A)
// row 1: B's winner polygon (country B, ~110 m from plant B)
// row 2: B's STALE stamp from a previous run (country B, ~1.1 km from plant B)
const POLY = [
  { lat: C_LAT, lon: C_LON - 0.1 },
  { lat: C_LAT, lon: C_LON + 0.25 },
  { lat: C_LAT + 0.01, lon: C_LON + 0.25 },
]
const PLANT_A = { lat: C_LAT, lon: C_LON - 0.1 + 0.005, nace4: 3511, ...NATIONAL_MIX }
const PLANT_B = { lat: C_LAT, lon: C_LON + 0.25 + 0.001, nace4: 3599, ...NATIONAL_MIX }

const stampDir = mkdtempSync(join(tmpdir(), 'gem-stamp-'))
after(() => rmSync(stampDir, { recursive: true, force: true }))

function writeIndustrialArrow(sourceIds: number[], naces: number[]): string {
  const table = new Table({
    centroid_lat: vectorFromArray(POLY.map((p) => p.lat), new Float64()),
    centroid_lon: vectorFromArray(POLY.map((p) => p.lon), new Float64()),
    area_m2: vectorFromArray([10_000, 10_000, 10_000], new Float64()),
    site_subtype: vectorFromArray([0, 0, 0], new Uint8()),
    nace_4digit: vectorFromArray(naces, new Uint16()),
    source_id: vectorFromArray(sourceIds, new Uint16()),
  })
  const hexDir = join(stampDir, 'h3r4', HEX)
  mkdirSync(hexDir, { recursive: true })
  const path = join(hexDir, 'industrial.arrow')
  writeFileSync(path, Buffer.from(tableToIPC(table, 'file')))
  return path
}

function readStamps(path: string): Array<{ src: number; nace: number }> {
  const t = tableFromIPC(readFileSync(path))
  const src = t.getChild('source_id')!
  const nace = t.getChild('nace_4digit')!
  return [...Array(t.numRows).keys()].map((i) => ({ src: src.get(i) as number, nace: nace.get(i) as number }))
}

test('stampOneWinner: overlapping sibling pass never clears across the border, own stale stamp heals country-wide', async () => {
  // Start state: row 2 carries B's stale 330 stamp from "yesterday's" run.
  const arrowPath = writeIndustrialArrow([0, 0, NATIONAL_MIX.id], [0, 0, 3511])
  const h3r4Dir = join(stampDir, 'h3r4')

  await stampOneWinner({
    facilities: [PLANT_A], isInside: inA, countryGate: countryA, searchRadiusM: 2000,
    resetSourceIds: [NATIONAL_MIX.id], label: 'AA', h3r4Dir,
  })
  let rows = readStamps(arrowPath)
  assert.equal(rows[0].src, NATIONAL_MIX.id, 'pass A stamps its winner')
  assert.equal(rows[0].nace, 3511)
  assert.equal(rows[2].src, NATIONAL_MIX.id,
    "pass A must NOT reset B's stale row — inside A's bbox but inside country B")

  await stampOneWinner({
    facilities: [PLANT_B], isInside: inB, countryGate: countryB, searchRadiusM: 2000,
    resetSourceIds: [NATIONAL_MIX.id], label: 'BB', h3r4Dir,
  })
  rows = readStamps(arrowPath)
  assert.equal(rows[0].src, NATIONAL_MIX.id,
    "pass B must NOT zero A's winner — the ML-blankets-BF data-loss shape")
  assert.equal(rows[0].nace, 3511)
  assert.equal(rows[1].src, NATIONAL_MIX.id, 'pass B stamps its own winner')
  assert.equal(rows[1].nace, 3599)
  assert.equal(rows[2].src, 0, 'pass B resets its own stale stamp — own country, no proximity needed')
  assert.equal(rows[2].nace, 0)
})

test('stampOneWinner: stale stamp of a DELETED site sweeps (country scope, not proximity); sweep-only run heals with zero facilities', async () => {
  // Row 2's site vanished from the dataset entirely (the CO tier-2 / deleted-site
  // shape a proximity scope could never heal): with searchRadiusM=300 no facility
  // is near row 2, yet the country-wide reset must still sweep it.
  const arrowPath = writeIndustrialArrow([0, 0, NATIONAL_MIX.id], [0, 0, 3599])
  const h3r4Dir = join(stampDir, 'h3r4')

  await stampOneWinner({
    facilities: [PLANT_B], isInside: inB, countryGate: countryB, searchRadiusM: 300,
    resetSourceIds: [NATIONAL_MIX.id], label: 'BB', h3r4Dir,
  })
  let rows = readStamps(arrowPath)
  assert.equal(rows[1].src, NATIONAL_MIX.id, 'winner still stamped')
  assert.equal(rows[2].src, 0, "deleted site's stale stamp swept — ownership is the country, not a radius")

  // Sweep-only: every plant retired (facilities []), dataset provably parsed →
  // stale stamps heal; without the parsed proof the pass must stay a no-op.
  const arrowPath2 = writeIndustrialArrow([0, 0, NATIONAL_MIX.id], [0, 0, 3599])
  await stampOneWinner({
    facilities: [], isInside: inB, countryGate: countryB, searchRadiusM: 2000,
    resetSourceIds: [NATIONAL_MIX.id], label: 'BB', h3r4Dir,
  })
  assert.equal(readStamps(arrowPath2)[2].src, NATIONAL_MIX.id, 'no facilities + no parsed dataset → hard no-op')
  await stampOneWinner({
    facilities: [], isInside: inB, countryGate: countryB, searchRadiusM: 2000,
    resetSourceIds: [NATIONAL_MIX.id], datasetNonEmpty: true, label: 'BB', h3r4Dir,
  })
  assert.equal(readStamps(arrowPath2)[2].src, 0, 'retired-only country heals its stale stamps (sweep-only run)')
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
