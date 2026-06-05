/**
 * Enrich NA industrial with GEM Global Integrated Power (Namibia filter).
 *
 * Namibian gov portals (RA, TransNamib, NamPower, MME, MEFT) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Namibia'):
 *     77 total, 28 operating, ~672 MW
 *     Operating fuel: solar 22, coal 4, hydropower 1, wind 1
 *
 *   Top operating plants:
 *     **Ruacana 332 MW** (Kunene River, Angola border — **Namibia's largest
 *                          plant**, run-of-river hydro, 49% of total capacity.
 *                          Supply depends on Angola's upstream Matala Dam
 *                          water management.)
 *     **Van Eck 120 MW** (4×30 MW coal, Windhoek — Namibia's only coal
 *                          plant, obsolete, being decommissioned)
 *     **Mariental Solar 46 MW** (largest solar IPP)
 *     **Omburu Solar 20 MW** (Omaruru/Karibib area)
 *     **22 smaller solar plants** (8-16 MW each — rapid solar rollout)
 *     **Diaz Wind Farm** (Lüderitz area, recent)
 *
 * **Namibia imports ~60% of electricity** from South Africa (NamPower ↔
 * Eskom) + Zimbabwe + Zambia + Mozambique via SAPP (Southern African
 * Power Pool).
 *
 * Non-power industrial (OSM only):
 *   - **Rössing Uranium Mine** (Erongo, near Swakopmund) — **world's
 *     longest-running open-pit uranium mine** (1976-present, Rio Tinto).
 *     Now China General Nuclear Power (CGN) majority since 2019.
 *   - **Husab Uranium Mine** (Erongo) — **one of the world's largest
 *     uranium mines**, Swakop Uranium/CGN. Opened 2017. Together Rössing
 *     + Husab make Namibia world's #3 uranium producer.
 *   - **Skorpion Zinc Mine + Refinery** (Rosh Pinah, //Kharas) —
 *     Vedanta, **closed 2020** due to resource depletion. Was Africa's
 *     only integrated zinc mine+refinery.
 *   - **Langer Heinrich Uranium** (Erongo) — Paladin Energy, reopened 2024
 *     after 6-year care-and-maintenance (uranium price recovery).
 *   - **Tsumeb Smelter** — Dundee Precious Metals. Processes complex
 *     copper/lead/arsenic concentrates. One of the few smelters in the
 *     world that can handle high-arsenic copper ores.
 *   - **Rosh Pinah zinc mine** (//Kharas) — Trevali, zinc/lead
 *   - **B2Gold Otjikoto** — gold mine (Otjozondjupa)
 *   - **Navachab gold mine** (Karibib, QKR Corp)
 *   - **Walvis Bay** — **Namibia's only deep-water port**, fish processing
 *     capital, salt works
 *   - **Cement**: Ohorongo Cement (Otavi, Schwenk), Cheetah Cement (Otjiwarongo)
 *   - **Fishing + fish processing**: Walvis Bay, Lüderitz (one of Africa's
 *     richest fishing grounds — Benguela Current cold upwelling)
 *   - **Salt**: Walvis Bay Salt Works (one of Africa's largest)
 *   - **Diamonds**: Namdeb (De Beers/Namibia 50-50) — marine + alluvial
 *     along Skeleton Coast
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-na.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const NA_BBOX: readonly [number, number, number, number] = [-29.0, 11.7, -17.0, 25.3]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-17.4, 11.7, -17.0, 25.3],
  [-18.5, 25.0, -17.0, 25.3],
  [-29.0, 21.0, -18.5, 25.3],
  [-29.0, 16.0, -28.5, 21.0],
]

await enrichGemIndustrial({
  countryCode: 'na',
  countryName: "Namibia",
  bbox: NA_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, NA_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
