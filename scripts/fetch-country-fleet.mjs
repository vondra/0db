#!/usr/bin/env node
// Fetch per-country registered-vehicle fleet composition (share of powered
// 2-/3-wheelers) from the WHO Global Status Report on Road Safety 2023
// country profiles and fold it into the committed scripts/country-fleet.json.
//
// Source: https://cdn.who.int/media/docs/default-source/country-profiles/
//         road-safety/road-safety-2023-{iso3}.pdf — the "SAFE VEHICLES" block
//         lists total registered vehicles [rate] (year), then four-wheel
//         vehicles, powered 2-/3-wheelers, heavy trucks, buses.
//         (License: CC BY-NC-SA 3.0 IGO; numbers, not text, are reused.)
//
// IMPORTANT: ownership share is a PRIOR for traffic share, not traffic share
// itself (a motorcycle drives fewer daily km than a delivery truck) — the
// ownership→traffic mapping lives in gen-country-fleet.mjs, and calibrated
// per-country overrides live in country-fleet.json next to this data.
//
// This script only refreshes the `fleet` sub-objects; every curated field in
// country-fleet.json is preserved verbatim. Requires `pdftotext` (poppler).
//
// Usage: node scripts/fetch-country-fleet.mjs         # all countries (~190 PDFs)
//        node scripts/fetch-country-fleet.mjs TH VN   # subset by ISO2

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NE_GEOJSON = resolve(__dirname, 'cache', 'ne_10m_admin_0_countries.geojson')
const FLEET_JSON = resolve(__dirname, 'country-fleet.json')
const PDF_URL = (iso3) =>
  `https://cdn.who.int/media/docs/default-source/country-profiles/road-safety/road-safety-2023-${iso3.toLowerCase()}.pdf`

if (!existsSync(NE_GEOJSON)) {
  console.error(`Natural Earth cache missing (${NE_GEOJSON}) — run scripts/build-h3-admin.ts once first.`)
  process.exit(1)
}
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
} catch {
  console.error('pdftotext (poppler-utils) is required to parse the WHO profiles.')
  process.exit(1)
}

/** Natural Earth files a few island states under "Seven seas (open ocean)",
 *  which has no fleet band — remap them to the continent whose usage pattern
 *  they share, or the generator would drop them to WORLD (Maldives at 87 %
 *  moto ownership landing on 1 % was the /gg example). */
const SEVEN_SEAS_CONTINENT = {
  MV: 'Asia', // Maldives
  SC: 'Africa', // Seychelles
  MU: 'Africa', // Mauritius
  IO: 'Asia', // British Indian Ocean Territory
  SH: 'Africa', // Saint Helena
  TF: 'Africa', // French Southern Territories
}

/** ISO2 → { iso3, name, continent } from Natural Earth (the project's country
 *  SSOT — same file build-h3-admin.ts uses). `_EH` variants repair the -99
 *  quirks (France, Norway). */
function loadCountries() {
  const ne = JSON.parse(readFileSync(NE_GEOJSON, 'utf8'))
  const out = new Map()
  for (const f of ne.features) {
    const p = f.properties
    const iso2 = p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2
    const iso3 = p.ISO_A3_EH !== '-99' ? p.ISO_A3_EH : p.ISO_A3
    if (!iso2 || iso2 === '-99' || !iso3 || iso3 === '-99') continue
    const continent = SEVEN_SEAS_CONTINENT[iso2] ?? p.CONTINENT
    if (!out.has(iso2)) out.set(iso2, { iso3, name: p.NAME, continent })
  }
  return out
}

/** Parse the SAFE VEHICLES numeric block out of `pdftotext` output. Layout
 *  (verified on THA/DEU/VNM 2023 profiles): a line
 *  "42 313 968 [59 096.8] (2021)" (total [per-100k rate] (year)), followed by
 *  numeric-only lines in order: four-wheel, powered 2-/3-wheelers, heavy
 *  trucks, buses. Returns null when the block is absent or not numeric (small
 *  states report N/A). */
export function parseSafeVehiclesBlock(text) {
  const lines = text.split('\n').map((l) => l.trim())
  const totalRe = /^([\d][\d ]*)\s*\[[\d .,]*\]\s*\((\d{4})\)$/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(totalRe)
    if (!m) continue
    const total = Number(m[1].replace(/ /g, ''))
    const year = Number(m[2])
    const following = []
    for (let j = i + 1; j < lines.length && following.length < 4; j++) {
      if (lines[j] === '') continue
      if (!/^[\d][\d ]*$/.test(lines[j])) break
      following.push(Number(lines[j].replace(/ /g, '')))
    }
    if (following.length < 2 || !Number.isFinite(total) || total <= 0) continue
    const [fourWheel, wheelers23] = following
    if (wheelers23 === undefined || fourWheel + wheelers23 > total * 1.05) continue
    // Consistency: the categories must roughly reconstruct the total. India's
    // profile lists only a partial breakdown (categories sum to 25 % of the
    // 326 M total, giving a nonsense 4 % two-wheeler share for the world's
    // most two-wheeler-heavy country) — reject those; the country falls to
    // its calibrated override or continent band instead.
    const categorySum = following.reduce((a, b) => a + b, 0)
    if (categorySum < total * 0.7) continue
    return { total_registered: total, powered_2_3_wheelers: wheelers23, year }
  }
  return null
}

async function main() {
  const countries = loadCountries()
  const onlyIso2 = process.argv.slice(2).map((s) => s.toUpperCase())
  const fleet = existsSync(FLEET_JSON) ? JSON.parse(readFileSync(FLEET_JSON, 'utf8')) : { countries: {} }
  fleet.countries ??= {}

  const tmp = mkdtempSync(join(tmpdir(), 'who-fleet-'))
  let ok = 0
  let missing = 0
  let unparsed = 0
  try {
    for (const [iso2, meta] of [...countries.entries()].sort()) {
      if (onlyIso2.length && !onlyIso2.includes(iso2)) continue
      // EVERY country gets a row with name + continent, fleet data or not —
      // the generator only emits countries present in the JSON, so a missing
      // row would silently bypass the documented country → continent → WORLD
      // cascade (JP/AT/UA landed on WORLD instead of their continent band,
      // /gg diff review CRITICAL).
      const row = (fleet.countries[iso2] ??= {})
      row.name = meta.name
      row.continent = meta.continent
      const res = await fetch(PDF_URL(meta.iso3), {
        headers: { 'User-Agent': 'quietmap-country-fleet-fetch/1.0' },
      })
      if (!res.ok) {
        missing++
        continue
      }
      const pdfPath = join(tmp, `${meta.iso3}.pdf`)
      writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()))
      const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' })
      const parsed = parseSafeVehiclesBlock(text)
      if (!parsed) {
        unparsed++
        console.error(`  ${iso2}/${meta.iso3}: profile fetched but SAFE VEHICLES block absent/partial — skipped`)
        // A previous run may have stored a row this stricter parse now rejects
        // (the India partial-breakdown case) — stale fleet priors must not
        // survive a refresh.
        if (row.fleet) delete row.fleet
        continue
      }
      row.fleet = {
        moto_fleet_share: Number((parsed.powered_2_3_wheelers / parsed.total_registered).toFixed(4)),
        total_registered: parsed.total_registered,
        powered_2_3_wheelers: parsed.powered_2_3_wheelers,
        year: parsed.year,
        source: `WHO GSRRS 2023 country profile (road-safety-2023-${meta.iso3.toLowerCase()}.pdf)`,
      }
      ok++
      await new Promise((r) => setTimeout(r, 150)) // be polite to the WHO CDN
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  fleet.fleet_fetched_at = new Date().toISOString()
  writeFileSync(FLEET_JSON, JSON.stringify(fleet, null, 2) + '\n')
  console.log(`country-fleet.json: ${ok} countries updated, ${missing} without a WHO profile, ${unparsed} unparsable`)
  console.log('Now regenerate the compiled table: node scripts/gen-country-fleet.mjs')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
