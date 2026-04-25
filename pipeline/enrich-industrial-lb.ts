/**
 * Enrich LB industrial with GEM Global Integrated Power (Lebanon filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Lebanon'):
 *     49 total / 19 operating / ~2.84 GW
 *     Operating fuel: oil/gas 17 (almost entirely oil-fired — no coal, no nuclear,
 *                                  no wind, no solar in operating fleet!), hydro 2
 *
 *   Top operating plants:
 *     **Zouk Mosbeh 805 MW** (1960s oil, Keserwan coast — chronic pollution,
 *                              one of Middle East's most polluted power plants)
 *     **Jieh 540 MW** (4 units oil, south of Beirut coast)
 *     **Deir Ammar 465 MW** (north Lebanon, oil)
 *     **Zahrani 465 MW** (Sidon area, oil)
 *     **Litani River cascade ~200 MW hydro** (2 stations: Markabi + Brachit)
 *
 *   EDL (Électricité du Liban) state utility BANKRUPT since 2019 — 12–20 hour
 *   daily blackouts nationwide. MOST electricity in Lebanon actually comes from
 *   PRIVATE DIESEL GENERATORS (not in GEM — estimated 6,000+ private generators
 *   across the country, a multi-billion USD grey-market industry).
 *
 *   Lebanon is one of the SMALLEST countries enriched (10,452 km²) — only
 *   a handful of OSM industrial sites expected.
 *
 * Non-power industrial (OSM only):
 *   - **Tripoli oil refinery** (1950s, closed 2020 — was Lebanon's only refinery)
 *   - **Cement**: Sibline (Ciments de Siblin / Holcim), Chekka (Cimenterie
 *     Nationale Chekka) — two major plants dominate exports
 *   - **Beirut Port** (devastated by August 2020 ammonium nitrate explosion —
 *     218 killed, 6,000+ injured, one of largest non-nuclear industrial disasters)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-lb.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const LB_BBOX: readonly [number, number, number, number] = [33.05, 35.1, 34.7, 36.65]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [33.05, 36.6, 34.7, 36.65],
  [34.65, 35.1, 34.7, 36.65],
  [33.05, 35.1, 33.1, 36.65],
]

await enrichGemIndustrial({
  countryCode: 'lb',
  countryName: "Lebanon",
  bbox: LB_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, LB_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
