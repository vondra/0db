/**
 * Enrich MW industrial with GEM Global Integrated Power (Malawi filter).
 *
 * Malawian gov portals (Roads Authority, Ministry of Transport, ESCOM,
 * Ministry of Energy, EGENCO) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Malawi'):
 *     38 total, 7 operating, **only ~453 MW** — one of Africa's smallest
 *     power fleets. Reflects Malawi's ~14% electrification rate (lowest
 *     in Africa).
 *     Operating fuel: solar 4, hydropower 3
 *
 *   Top operating plants:
 *     **Kapichira 130 MW** (Shire River, 2000 with extension — Malawi's
 *                            largest single plant. **Damaged by Cyclone Ana
 *                            January 2022**, causing severe supply crisis
 *                            2022-2024)
 *     **Tedzani Falls 121 MW** (Shire River cascade, 4 stages I-IV)
 *     **Nkula B 100 MW** (Shire River — oldest major Malawian hydro)
 *     **Salima Solar 60 MW** (Malawi's largest solar farm)
 *     **Nkhotakota Solar 21 MW**
 *     **Golomoti Solar 20 MW**
 *     **Lilongwe Solar 1.1 MW**
 *
 * **Under construction / planned (not counted)**:
 *     **Kammwamba coal 300 MW** (NW Malawi) — Chinese-financed, delayed
 *     **Mpatamanga 350 MW hydro** (Shire River) — under development
 *     **Songwe River hydro 340 MW** — Tanzania border, joint project
 *
 * Non-power industrial (OSM only):
 *   - **Kayelekera Uranium Mine** (Karonga N) — Paladin Energy. **Closed
 *     2014** due to low uranium prices. Rehabilitation/restart discussed
 *     2023+ with uranium price recovery.
 *   - **Emerging lithium**: Mangochi/Liwonde area — Sovereign Metals
 *     (rutile+graphite) + Globe Metals (niobium)
 *   - **Tobacco processing**: **Auction Holdings** at Limbe + Kanengo —
 *     **Malawi's dominant export** (tobacco is historically 60%+ of
 *     Malawi's export earnings)
 *   - **Tea plantations**: Mulanje + Thyolo (south) — Satemwa, Eastern
 *     Produce Malawi, Makandi
 *   - **Sugar**: Illovo Sugar at Dwangwa (central coast Lake Malawi) and
 *     Nchalo (Lower Shire)
 *   - **Cement**: Shayona Cement, Cement Products Limited (Lafarge)
 *   - **Fishing**: Lake Malawi chambo (cichlid) — major domestic sector
 *   - **No oil/gas industry** — Malawi has no hydrocarbons
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mw.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MW_BBOX: readonly [number, number, number, number] = [-17.1, 32.7, -9.4, 35.95]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-9.6, 33.5, -9.4, 35.95],
  [-14.0, 35.5, -11.5, 35.95],
  [-17.1, 34.6, -16.0, 35.9],
  [-17.1, 32.7, -14.3, 34.0],
  [-12.0, 32.7, -9.4, 33.2],
]

await enrichGemIndustrial({
  countryCode: 'mw',
  countryName: "Malawi",
  bbox: MW_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MW_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
