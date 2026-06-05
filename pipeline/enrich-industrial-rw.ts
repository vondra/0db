/**
 * Enrich RW industrial with GEM Global Integrated Power (Rwanda filter).
 *
 * GEM only has 6 entries for Rwanda (4 operating) — this severely under-
 * represents Rwanda's actual ~220 MW installed fleet, since most capacity
 * is in **many small hydros (2-20 MW each)** that fall below GEM's
 * reporting threshold.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Rwanda'):
 *     6 total, 4 operating, ~68 MW
 *     Operating fuel: oil/gas 1 (actually methane), solar 3
 *
 *   Known plants:
 *     **KivuWatt 26-56 MW** (GEM shows 56 MW — Lake Kivu dissolved methane
 *                             extraction. **World's only operational lake
 *                             methane power plant.** Contour Global operated.
 *                             Methane dissolved in Lake Kivu at depth, pumped
 *                             and burned in gas engines. Lake Kivu contains
 *                             ~65 km³ of dissolved CO₂ + methane — a **limnic
 *                             eruption risk** if not managed.)
 *     **Agahozo Solar 7 MW** (Rwamagana, one of East Africa's first utility
 *                              solar, 2014)
 *     **Nasho Solar 3.3 MW**, **Bugesera Solar 1.8 MW**
 *
 * **NOT in GEM but significant** (small hydros below reporting threshold):
 *     - **Ntaruka 11 MW** (Lake Burera → Ruhondo)
 *     - **Mukungwa I+II ~16 MW** (Musanze)
 *     - **Nyabarongo I 28 MW** (Muhanga, opened 2014)
 *     - **Rusumo Falls 80 MW** (Akagera River, shared Rwanda/Tanzania/Burundi,
 *                                opened 2023 — binational Nile Equatorial Lakes
 *                                Subsidiary Action Program)
 *     - **Rugezi, Gihira, Keya, Mukungwa III** — numerous 2-10 MW micro-hydros
 *     - **Jabana diesel/HFO** (Kigali — emergency thermal)
 *
 * Non-power industrial (OSM only):
 *   - **No heavy industry** — Rwanda's economy is service-oriented (tourism,
 *     coffee, tea, minerals, ICT)
 *   - **Tin/Tantalum/Tungsten (3T) mining** — Rwanda is a significant
 *     processor of Central African conflict minerals (DRC origin) at
 *     various smelters (Piran, LuNa, MSA). Regulated under Dodd-Frank
 *   - **Cement**: CIMERWA (LafargeHolcim, Rusizi) — only cement plant
 *   - **Coffee**: Rwanda specialty coffee processing (washed arabica,
 *     high premium)
 *   - **Tea**: NAEB-managed plantations (Mulindi, Nyabihu, Rubaya)
 *   - **Kigali Special Economic Zone** — IT hub (Carnegie Mellon Africa,
 *     Andela, VW mobility hub)
 *   - **Bugesera International Airport** — under construction since 2017
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-rw.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const RW_BBOX: readonly [number, number, number, number] = [-2.85, 28.85, -1.05, 30.9]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1.1, 28.85, -1.05, 30.9],
  [-2.85, 30.8, -1.05, 30.9],
  [-2.85, 29.4, -2.3, 30.9],
  [-2.85, 28.85, -1.05, 29.0],
]

await enrichGemIndustrial({
  countryCode: 'rw',
  countryName: "Rwanda",
  bbox: RW_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, RW_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
