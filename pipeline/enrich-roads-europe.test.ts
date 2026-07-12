/**
 * #31.6: the EU-city loader normalizes staged `<City>_<METRIC>_<YEAR>.geojson`
 * raws into the consumed `<city>.geojson` under --enrich-only, so all 36 cities
 * load offline (was 2/36). Pins the latest-year pick + case-insensitive match.
 *
 * Run: `cd pipeline && npx tsx --test enrich-roads-europe.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pickLatestRawForCity } from './enrich-roads-europe.js'

const TMP = mkdtempSync(join(tmpdir(), 'eu-city-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

for (const f of [
  'Berlin_AADT_AAWT_2021.geojson',
  'Berlin_AADT_AAWT_2023.geojson', // latest → this one
  'Brno_AADT_2019.geojson',
  'trafico.geojson',               // junk with no city prefix
  'Barcelona_AAWT_2024.geojson',
]) writeFileSync(join(TMP, f), '{"type":"FeatureCollection","features":[]}')

test('pickLatestRawForCity: picks the latest year for the city', () => {
  assert.equal(basename(pickLatestRawForCity('Berlin', TMP)!), 'Berlin_AADT_AAWT_2023.geojson')
  assert.equal(basename(pickLatestRawForCity('Brno', TMP)!), 'Brno_AADT_2019.geojson')
  assert.equal(basename(pickLatestRawForCity('Barcelona', TMP)!), 'Barcelona_AAWT_2024.geojson')
})

test('pickLatestRawForCity: case-insensitive prefix, no cross-city match', () => {
  // lower-case query still matches the capitalised raw
  assert.equal(basename(pickLatestRawForCity('berlin', TMP)!), 'Berlin_AADT_AAWT_2023.geojson')
  // a city with no staged raw → null (the loader then SKIPs it, marker = partial)
  assert.equal(pickLatestRawForCity('Paris', TMP), null)
  // the junk file (no `<city>_` prefix, no year) is never picked
  assert.equal(pickLatestRawForCity('trafico', TMP), null)
})
