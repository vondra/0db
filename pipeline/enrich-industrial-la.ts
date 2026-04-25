/**
 * Enrich LA industrial with GEM Global Integrated Power (Laos filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Laos'):
 *     124 total / 58 operating / ~11.7 GW
 *     Operating fuel: hydro 44, solar 11, coal 3
 *
 *   Hydro is overwhelmingly dominant — Laos pursues the "Battery of SE Asia"
 *   strategy, exporting power to Thailand, Vietnam, and China.
 *
 *   Top hydro plants:
 *     **Xayaburi 1,285 MW** — controversial first dam on lower Mekong mainstream
 *                              (EGCO/Thai consortium, completed 2019)
 *     **Nam Theun 2 1,070 MW** — World Bank-backed flagship hydro (2010),
 *                                 Nakai plateau reservoir, NT Power/EdL/EDF/LHSE
 *     **Nam Theun 1 650 MW** — upper Theun River
 *     **Nam Ngum 2 615 MW** — Nam Ngum basin, GMS power corridor
 *     **Theun Hinboun 440 MW** — Bolikhamxai Province
 *     **Xe Pian 410 MW** — Xe Pian–Xe Namnoy, saddle dam collapsed 2018
 *                           killing 71+ in catastrophic failure
 *     **Don Sahong 260 MW** — 2nd Mekong mainstream dam (near Khone Falls)
 *
 *   Coal:
 *     **Hongsa 1,878 MW** = 3×626 MW — one of SE Asia's largest coal plants,
 *     Xayaburi Province; Ratchaburi/BANPU/LHSE Thai JV, exports 95% to Thailand
 *
 * Non-power industrial (OSM only):
 *   - **Phu Bia Mining** — gold/copper/silver, Xaysomboun Province
 *     (Pan American Silver / Lane Xang Minerals JV)
 *   - **Sepon (Vilabouly) gold/copper** — Savannakhet Province,
 *     formerly MMG (Australian), closed operations 2024
 *   - **Lao Cement** — construction materials, national production
 *   - **Beerlao** — flagship beer (Carlsberg 25% stake), Vientiane
 *     brewery; Laos's most recognized export brand
 *   - No oil/gas/refinery — landlocked country, no petroleum production
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-la.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const LA_BBOX: readonly [number, number, number, number] = [13.9, 100.0, 22.5, 107.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [19.0, 100.0, 22.5, 100.5],
  [21.5, 100.0, 22.5, 107.7],
  [13.9, 106.0, 22.0, 107.7],
  [13.9, 100.0, 14.5, 107.7],
  [13.9, 100.0, 19.0, 101.0],
]

await enrichGemIndustrial({
  countryCode: 'la',
  countryName: "Laos",
  bbox: LA_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, LA_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
