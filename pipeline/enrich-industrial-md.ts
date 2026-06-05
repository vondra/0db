/**
 * Enrich MD industrial with GEM Global Integrated Power (Moldova filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Moldova'):
 *     28 total / 18 operating / ~1.24 GW
 *     Operating fuel: oil/gas 7, solar 10, hydro 1
 *
 *   Top operating plants:
 *     **Kuchurgan/MGRES 910 MW** (Moldavskaya GRES — oil/gas combined cycle,
 *                                  IN TRANSNISTRIA breakaway region,
 *                                  Russian-controlled, fed by Russian gas.
 *                                  Transnistria controls ~73% of Moldova's
 *                                  installed capacity!)
 *     **Chișinău CHP 258 MW** (combined heat+power, oil/gas, Moldova proper)
 *     **Dubăsari 48 MW** (hydro on Dniester — also Transnistria)
 *     Solar: 10 plants, 2–5 MW each (Moldova proper, various locations)
 *
 * Non-power industrial (OSM only):
 *   - **Moldova Steel Works** (Rîbnița, Transnistria — Russian-controlled,
 *     electric arc furnace, ~600k t/yr steel)
 *   - Moldova's economy: agriculture (wine — one of Europe's largest by
 *     vineyard area/capita), remittances (~30% of GDP from diaspora),
 *     textiles. No oil/gas production, no significant heavy industry.
 *   - EU candidate since 2022. Europe's poorest country by GDP per capita.
 *   - Gagauzia: autonomous region (Turkic/Orthodox minority in south).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-md.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MD_BBOX: readonly [number, number, number, number] = [45.4, 26.6, 48.5, 30.2]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [45.4, 30.1, 48.5, 30.2],
  [45.4, 26.6, 48.5, 26.65],
]

await enrichGemIndustrial({
  countryCode: 'md',
  countryName: "Moldova",
  bbox: MD_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MD_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
