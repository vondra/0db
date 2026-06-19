/**
 * Enrich MN industrial with GEM Global Integrated Power (Mongolia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mongolia'):
 *     81 total / 25 operating / ~1.41 GW
 *     Operating fuel: coal 13 (DOMINANT), wind 3, solar 9
 *
 *   Top operating plants:
 *     **Ulaanbaatar-4 CHP ~889 MW total** (7 units, Soviet-era combined heat &
 *                                           power — coal is non-negotiable in
 *                                           extreme continental winters −40 °C)
 *     **Buuruljuut 150 MW** (coal CHP, central Mongolia)
 *     **Dornod 86 MW** (coal CHP, eastern Mongolia / Choibalsan area)
 *     **Darkhan 35 MW** + **Erdenet 35 MW** (coal CHP, industrial cities)
 *     **Sainshand Wind 55 MW** + **Salkhit Wind 50 MW** + **Tsetsii Wind 50 MW**
 *
 * Non-power industrial (OSM only):
 *   - **Oyu Tolgoi** (Rio Tinto/Turquoise Hill, South Gobi) — one of the world's
 *     largest known copper-gold deposits; underground expansion opened 2023
 *   - **Erdenet Copper** (Erdenet city, Orkhon aimag) — one of the world's largest
 *     open-pit copper mines; entire city of ~100k built around the mine
 *   - **Tavan Tolgoi** (South Gobi, Mongolian state) — world's largest untapped
 *     coking coal deposit
 *   - **Cashmere processing** — Mongolia produces ~40% of world's cashmere
 *     (Gobi, SPS, Buyan cashmere factories in Ulaanbaatar)
 *   - **Darkhan industrial zone** — metallurgy, cement, food processing
 *   - **NO oil refinery** — Mongolia imports all petroleum products from Russia
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-mn.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MN_BBOX: readonly [number, number, number, number] = [41.5, 87.7, 52.2, 119.9]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [50.5, 87.7, 52.2, 119.9],
  [41.5, 87.7, 42.5, 110.0],
  [41.5, 110.0, 42.0, 119.9],
]

await enrichGemIndustrial({
  countryCode: 'mn',
  countryName: "Mongolia",
  bbox: MN_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MN_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
