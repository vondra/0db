/**
 * Enrich KH industrial with GEM Global Integrated Power (Cambodia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cambodia'):
 *     81 total / 43 operating / ~4.06 GW
 *     Operating fuel: solar 23, coal 10, hydro 6, oil/gas 4
 *
 *   Top operating plants:
 *     **Sihanoukville Chinese coal complex ~1,255 MW** — multiple Chinese-built
 *       coal units at Sihanoukville/Koh Kong coast (Cambodia's dominant coal
 *       base; built ~2017–2023 under heavy Chinese investment)
 *     **Lower Sesan 2 400 MW** — controversial dam on Sesan/Srepok confluence
 *       (Stung Treng province); flooded indigenous Bunong/Khmer Khe communities;
 *       China Huaneng + Royal Group 2018
 *     **Stung Tatay 246 MW** (Koh Kong province, Sinohydro 2014)
 *     **Russei Chrum 338 MW** (Koh Kong province, China Datang 2013)
 *     **Kamchay 194 MW** (Kampot province, Sinohydro 2011 — Cambodia's first
 *       large hydro)
 *
 * Non-power industrial (OSM only):
 *   - **Garment factories** (Phnom Penh / Kandal province) — Cambodia is the
 *     world's #7 garment exporter; ~700 factories, 700 000 workers
 *   - **Phnom Penh Autonomous Port** (Mekong river port, key inland freight hub)
 *   - **Sihanoukville Port** (Cambodia's only deep-water port; massive Chinese
 *     investment 2017–2023, Cosco/CMHI involvement)
 *   - **Chip Mong cement** + **Thai Boon Roong cement** (Phnom Penh suburbs)
 *   - **National Road 3/4 industrial corridor** (Kandal, Kampong Speu)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-kh.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const KH_BBOX: readonly [number, number, number, number] = [10.4, 102.3, 14.7, 107.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [12.0, 102.3, 14.7, 103.0],
  [14.3, 102.3, 14.7, 107.7],
  [10.4, 107.0, 14.3, 107.7],
]

await enrichGemIndustrial({
  countryCode: 'kh',
  countryName: "Cambodia",
  bbox: KH_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, KH_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
