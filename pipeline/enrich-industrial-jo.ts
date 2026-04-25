/**
 * Enrich JO industrial with GEM Global Integrated Power (Jordan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Jordan'):
 *     167 total / 159 operating / ~6.75 GW
 *
 *     Operating fuel: solar 134, oil/gas 16, wind 9
 *
 *     Jordan is a SOLAR POWERHOUSE — one of MENA's leading solar markets,
 *     driven by extremely high solar irradiance (>300 sunny days/yr) and
 *     near-total energy import dependency. Solar share of installed capacity
 *     is among the highest in the Middle East.
 *
 *   Top operating plants:
 *     **Samra combined-cycle ~1,241 MW** (Zarqa — Jordan's main thermal base,
 *                                          multiple gas/oil units since 1970s)
 *     **IPP3 (Al-Qatrana) 574 MW** (gas/oil combined-cycle)
 *     **Zarqa Power Station 485 MW** (Zarqa, oil/gas steam)
 *     **Amman East 400 MW** (IPP1, combined-cycle)
 *     **Al-Qatrana 373 MW** (older IPP)
 *     **Rehab 300 MW** (gas turbine peakers)
 *     **Attarat oil shale 470 MW** — world's first commercial oil shale
 *                                     power plant (2020), uses Jordan's
 *                                     enormous oil shale reserves (2nd global)
 *     **Tafila Wind Farm 117 MW** — MENA's first utility-scale wind farm (2015)
 *
 * Non-power industrial (OSM only):
 *   - **JPRC (Jordan Petroleum Refining Company)** — Zarqa, Jordan's only
 *     oil refinery, ~100,000 bpd capacity
 *   - **Jordan Phosphate Mines Company (JPMC)** — Al-Abyad + Al-Hasa +
 *     Eshidiya mines; Jordan is one of the world's top-5 phosphate producers,
 *     3rd-largest exporter; phosphate is Jordan's top export commodity
 *   - **Arab Potash Company (APC)** — Dead Sea, Safi; world's 8th-largest
 *     potash producer; Dead Sea solar evaporation ponds visible from space
 *   - **ASEZA Aqaba Special Economic Zone** — Jordan's only sea outlet
 *     (Red Sea), strategic port, tourism, industrial free zone
 *   - **Cement**: Lafarge Jordan (Rashadiyya), Qatrana Cement, Jordan Cement
 *     Factories (Al-Fuheis) — cement tied to Gulf construction cycles
 *   - **Dead Sea Industries** — bromine, potassium compounds, magnesium
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-jo.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const JO_BBOX: readonly [number, number, number, number] = [29.1, 34.9, 33.4, 39.4]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [33.0, 34.9, 33.4, 39.4],
  [29.1, 39.0, 33.4, 39.4],
  [29.1, 36.0, 30.0, 39.0],
  [29.1, 34.9, 29.3, 36.0],
  [29.1, 34.9, 32.5, 35.5],
]

await enrichGemIndustrial({
  countryCode: 'jo',
  countryName: "Jordan",
  bbox: JO_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, JO_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
