/**
 * Enrich AL industrial with GEM Global Integrated Power (Albania filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Albania'):
 *     66 total / 20 operating / ~1.99 GW
 *     100% RENEWABLE in GEM (7 hydro + 13 solar, ZERO fossil fuel —
 *     Albania is one of Europe's only countries with nearly 100% renewable
 *     generation, alongside Norway and Iceland).
 *
 *   Drin River cascade (Albania's hydro backbone):
 *     **Koman 600 MW** + **Fierza 500 MW** + **Vau i Dejës 250 MW** = 1,350 MW
 *
 *   Devoll cascade (Statkraft/Shell 2020):
 *     **Moglicë 197 MW** + **Banjë 72 MW**
 *
 *   **Karavasta Solar 140 MW** — largest solar plant, Adriatic coast
 *
 * Non-power industrial (OSM only):
 *   - **Bankers Petroleum Patos-Marinza** (Fier) — Europe's largest onshore
 *     oil field by surface area; Chinese Geo-Jade since 2016
 *   - **ARMO refinery** (Ballsh/Fier) — old, small
 *   - **Kurum International steel** (Elbasan) — EAF/rolling mill
 *   - **Chrome mining Bulqizë** — world's 3rd largest chrome reserves
 *   - **Antea Cement** (Krujë, Holcim-Titan joint venture)
 *   - **Fushe-Krujë ferrochrome** smelter
 *   - **Albanian RTZ copper** (Rubik/Rrëshen)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-al.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const AL_BBOX: readonly [number, number, number, number] = [39.6, 19.25, 42.7, 21.1]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [42.55, 19.25, 42.7, 21.1],
  [42.0, 20.5, 42.55, 21.1],
  [39.6, 20.9, 42.0, 21.1],
  [39.6, 19.25, 39.65, 21.1],
]

await enrichGemIndustrial({
  countryCode: 'al',
  countryName: "Albania",
  bbox: AL_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, AL_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
