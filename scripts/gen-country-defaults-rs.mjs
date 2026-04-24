#!/usr/bin/env node
// Generate engine/noise-compute/src/country_defaults_generated.rs from
// World Bank country data (see scripts/fetch-wb-country-data.mjs).
//
// Per-country motorway AADT scale factor (plan v5 §I.3 revised):
//   scale(country) = clamp(0.7, 1.3,
//                          1.0 + 0.3 * tanh(log2(density / WORLD_MEDIAN_DENSITY)))
//
// Why density (not GDP):
// AADT on an existing road is fleet/km, not wealth. Wealth drives
// motorization, but fleet gets diluted by road network length.
// Norway is wealthy + sparse → low AADT. Egypt is poor + dense →
// high AADT. GDP mis-ranks both. Population density is the best
// single signal we have through WB API (road_km + fleet have been
// discontinued since 2011).
//
// tanh smooths the log-ratio (Singapore at 8000/km² doesn't get a
// runaway factor). ±30% band per explicit user request — in the
// absence of fleet/road_km data, a tight band avoids over-confident
// departures from WORLD_DEFAULT.
//
// WORLD_MEDIAN_DENSITY = 60 people/km² (approx median of the ~240
// countries in wb-country-2022.json).
//
// Future refinement (see scripts/fetch-wiki-roads-fleet.mjs, plan v5 §I.3b):
// when real vehicles_per_km data is available from Wikipedia or a
// national agency, override the density fallback with an explicit
// entry. Implemented via a wiki-sourced explicit_arm layer in
// country_defaults_generated.rs.
//
// Applied to classes 0 (motorway), 1 (trunk), 2 (primary) and the ramp
// classes 10-12. Local classes 3-9 stay at WORLD — local AADT doesn't
// correlate tightly with GDP (informal transport, pedestrians, bicycles).
//
// Continent defaults are generated as population-weighted averages of
// their countries' scale factors, for hexes whose country arm isn't
// populated (micro-states, ocean-side hexes near dual boundaries).
//
// Usage:
//   cd /home/vondra/0db-app && node scripts/gen-country-defaults-rs.mjs
//
// Commit both the input JSON and the generated .rs file.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = resolve(ROOT, 'scripts', 'wb-country-2022.json')
const OUTPUT = resolve(ROOT, 'engine', 'noise-compute', 'src', 'country_defaults_generated.rs')

const WORLD_MEDIAN_DENSITY = 60.0  // people/km², ~median of populated countries
const SCALE_MIN = 0.7               // ±30% band per user's conservative guidance
const SCALE_MAX = 1.3
const SCALE_SPAN = (SCALE_MAX - SCALE_MIN) / 2  // 0.3 — tanh amplitude

// ISO alpha-2 → continent. Must match
// engine/noise-compute/src/admin.rs::Continent and
// scripts/h3-admin-metros.json continent ids.
// Source: UN standard M49 region codes (https://unstats.un.org/unsd/methodology/m49/).
const CONTINENT = {
  Europe: new Set('AD,AL,AM,AT,AX,AZ,BA,BE,BG,BY,CH,CY,CZ,DE,DK,EE,ES,FI,FO,FR,GB,GE,GG,GI,GR,HR,HU,IE,IM,IS,IT,JE,LI,LT,LU,LV,MC,MD,ME,MK,MT,NL,NO,PL,PT,RO,RS,RU,SE,SI,SJ,SK,SM,TR,UA,VA,XK'.split(',')),
  NorthAmerica: new Set('AG,AI,AW,BB,BL,BM,BQ,BS,BZ,CA,CR,CU,CW,DM,DO,GD,GL,GP,GT,HN,HT,JM,KN,KY,LC,MF,MQ,MS,MX,NI,PA,PM,PR,SV,SX,TC,TT,US,VC,VG,VI'.split(',')),
  SouthAmerica: new Set('AR,BO,BR,CL,CO,EC,FK,GF,GY,PE,PY,SR,UY,VE'.split(',')),
  Asia: new Set('AE,AF,BD,BH,BN,BT,CC,CN,CX,HK,ID,IL,IN,IO,IQ,IR,JO,JP,KG,KH,KP,KR,KW,KZ,LA,LB,LK,MM,MN,MO,MV,MY,NP,OM,PH,PK,PS,QA,SA,SG,SY,TH,TJ,TL,TM,TW,UZ,VN,YE'.split(',')),
  Africa: new Set('AO,BF,BI,BJ,BW,CD,CF,CG,CI,CM,CV,DJ,DZ,EG,EH,ER,ET,GA,GH,GM,GN,GQ,GW,KE,KM,LR,LS,LY,MA,MG,ML,MR,MU,MW,MZ,NA,NE,NG,RE,RW,SC,SD,SH,SL,SN,SO,SS,ST,SZ,TD,TG,TN,TZ,UG,YT,ZA,ZM,ZW'.split(',')),
  Oceania: new Set('AS,AU,CK,FJ,FM,GU,KI,MH,MP,NC,NF,NR,NU,NZ,PF,PG,PN,PW,SB,TK,TO,TV,UM,VU,WF,WS'.split(',')),
}

function isoContinent(iso) {
  for (const [c, set] of Object.entries(CONTINENT)) if (set.has(iso)) return c
  return null
}

const data = JSON.parse(readFileSync(INPUT, 'utf8'))
const countries = data.countries

// ── Per-country scaling factor (density-based, tanh-smoothed) ───────────
// scale = 1.0 + SCALE_SPAN * tanh(log2(density / WORLD_MEDIAN_DENSITY))
// Falls into [SCALE_MIN, SCALE_MAX] asymptotically; clamp only guards
// against infinities (e.g. Vatican pop_density 1800+, Macao 21000+).
function densityScale(density) {
  if (density == null || density <= 0) return null
  const ratio = density / WORLD_MEDIAN_DENSITY
  const raw = 1.0 + SCALE_SPAN * Math.tanh(Math.log2(ratio))
  const clamped = Math.max(SCALE_MIN, Math.min(SCALE_MAX, raw))
  return Math.round(clamped * 1000) / 1000
}

const countryScale = {}       // iso → scale ∈ [SCALE_MIN, SCALE_MAX]
const unscaled = []           // iso with no density data
for (const [iso, row] of Object.entries(countries)) {
  const scale = densityScale(row.pop_density)
  if (scale == null) { unscaled.push(iso); continue }
  countryScale[iso] = scale
}

// ── Continent averages (population-weighted) ─────────────────────────────
const contAccum = {}  // continent → { sumWeightedScale, sumWeight, scaledN, allN }
for (const [iso, row] of Object.entries(countries)) {
  const cont = isoContinent(iso)
  if (!cont) continue
  if (!contAccum[cont]) contAccum[cont] = { weighted: 0, weight: 0, scaledN: 0, allN: 0 }
  contAccum[cont].allN += 1
  const scale = countryScale[iso]
  const pop = row.population
  if (scale == null || pop == null) continue
  contAccum[cont].weighted += scale * pop
  contAccum[cont].weight += pop
  contAccum[cont].scaledN += 1
}
const continentScale = {}
for (const [cont, a] of Object.entries(contAccum)) {
  if (a.weight > 0) {
    continentScale[cont] = Math.round((a.weighted / a.weight) * 1000) / 1000
  }
}

// ── Emit Rust ────────────────────────────────────────────────────────────
const sortedCountries = Object.keys(countryScale).sort()

const out = []
out.push(`//! Per-country and per-continent AADT scale factors relative to
//! WORLD_DEFAULT. Generated from \`scripts/wb-country-${data.year}.json\`
//! by \`scripts/gen-country-defaults-rs.mjs\`.
//!
//! Source: World Bank indicator \`EN.POP.DNST\` (people per km², ${data.year}).
//!
//! Method (plan v5 §I.3, density-based):
//!   scale(country) = clamp(${SCALE_MIN.toFixed(1)}, ${SCALE_MAX.toFixed(1)},
//!                          1.0 + ${SCALE_SPAN.toFixed(1)} × tanh(log₂(density / ${WORLD_MEDIAN_DENSITY.toFixed(0)})))
//!
//! Why population density:
//!   AADT on an existing road is vehicle fleet / road km. Wealth drives
//!   motorization but sparse networks (Norway, Canada) dilute AADT and
//!   dense networks (Egypt, India) concentrate it. Density is the best
//!   single proxy we can pull from WB API; direct road_km + fleet have
//!   been discontinued since 2011.
//!
//!   tanh smooths the log-ratio so Singapore (8000/km²) and Macao
//!   (21000/km²) don't explode the scale. ±30% band is deliberately
//!   conservative — in the absence of direct fleet/road data we prefer
//!   modest departures from WORLD_DEFAULT over overconfident ones.
//!
//! Applied to motorway/trunk/primary/link classes (0/1/2/10/11/12) in
//! \`defaults.rs::country_default\`. Local road classes (3-9) stay at
//! WORLD_DEFAULT — density is still a weak signal for local streets,
//! whose AADT depends more on informal transport + pedestrian share.
//!
//! Continent scales are population-weighted averages of their countries'
//! factors (reaches only hexes whose country centroid fell outside every
//! Natural Earth polygon, e.g. contested boundaries, micro-ocean cells).
//!
//! To refresh:
//!   node scripts/fetch-wb-country-data.mjs ${data.year}
//!   node scripts/gen-country-defaults-rs.mjs
//!   # commit both JSON + this file

use crate::admin::Continent;

/// Per-country scale factor vs WORLD_DEFAULT motorway. ${sortedCountries.length} entries.
pub const COUNTRY_SCALES: &[(&[u8; 2], f64)] = &[`)

for (const iso of sortedCountries) {
  const scale = countryScale[iso]
  const dens = countries[iso].pop_density?.toFixed(1) ?? '?'
  out.push(`    (b"${iso}", ${scale.toFixed(3)}), // pop_density ${data.year} ${dens}/km²`)
}

out.push('];')
out.push('')
out.push('/// Binary-search lookup. O(log N), N = ' + sortedCountries.length + '.')
out.push('pub fn country_scale(iso: &[u8; 2]) -> Option<f64> {')
out.push('    COUNTRY_SCALES')
out.push('        .binary_search_by_key(iso, |(k, _)| **k)')
out.push('        .ok()')
out.push('        .map(|idx| COUNTRY_SCALES[idx].1)')
out.push('}')
out.push('')
out.push('/// Continent scale factor (population-weighted mean of member countries).')
out.push('/// Returned when a hex has no country arm (e.g. oceanic cells near coasts).')
out.push('pub fn continent_scale(continent: Continent) -> Option<f64> {')
out.push('    match continent {')
for (const [cont, scale] of Object.entries(continentScale).sort()) {
  out.push(`        Continent::${cont} => Some(${scale.toFixed(3)}),`)
}
out.push('        Continent::Unknown => None,')
out.push('    }')
out.push('}')
out.push('')

writeFileSync(OUTPUT, out.join('\n') + '\n')
console.log(`Wrote ${OUTPUT}`)
console.log(`  countries scaled: ${sortedCountries.length}`)
console.log(`  countries without GDP: ${unscaled.length} (${unscaled.slice(0, 10).join(', ')}...)`)
console.log(`  continents: ${Object.keys(continentScale).join(', ')}`)
console.log('\n  Continent scales:')
for (const [c, s] of Object.entries(continentScale).sort()) {
  const a = contAccum[c]
  console.log(`    ${c.padEnd(14)} ${s.toFixed(3)}  (${a.scaledN}/${a.allN} countries, ${(a.weight/1e6).toFixed(0)}M pop)`)
}
