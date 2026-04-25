/**
 * Enrich GH industrial with GEM Global Integrated Power (Ghana filter).
 *
 * Ghana's gov data portal (data.gov.gh) — first sub-Saharan African open
 * data initiative (2012) — has been dormant since ~2015. VRA, BPA, ECG,
 * GRIDCo all publish WordPress corporate sites only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ghana'):
 *     98 total, 33 operating
 *     Fuel breakdown: oil/gas 15, solar 15, hydropower 3
 *
 *   Top operating plants:
 *     Akosombo 1,020 MW (hydro, Africa's largest by reservoir area — Lake
 *                        Volta 8,502 km², built 1965 by VRA, funded by
 *                        US + UK + World Bank)
 *     Karpowership Osman Khan 450 MW (oil/gas, floating powership)
 *     Bui 400 MW (hydro, BPA, opened 2013 on Black Volta)
 *     Aksa Ghana HFO 370 MW (heavy fuel oil, Turkish IPP)
 *     Sunon Asogli 360 + 200 MW (oil/gas, Shenzhen Energy)
 *     Kpone IPP (KIPP) 350 MW (oil/gas)
 *     Takoradi TAPCO 330 MW (oil/gas, VRA + CMS)
 *     Takoradi TICO 320 MW (oil/gas)
 *     Amandi 203 MW (oil/gas)
 *     Kpong 160 MW (hydro, VRA, downstream of Akosombo)
 *
 * Non-power industrial (OSM only):
 *   - **Tema Oil Refinery (TOR)** — 45k bpd, mostly non-operational
 *   - **VALCO Tema** — aluminum smelter (200 ktpa capacity, mostly idle)
 *   - **Gold mines**: AngloGold Ashanti **Obuasi**, Newmont **Ahafo** +
 *     **Akyem**, Goldfields **Tarkwa** + **Damang**, Asanko Gold
 *   - **Nsuta manganese mine** (Ghana Manganese Company)
 *   - **Awaso bauxite mine** (Ghana Bauxite Company)
 *   - **Cocoa processing** (Cocobod + private: Barry Callebaut, Cargill,
 *     Niche Cocoa) — Ghana is world's 2nd largest cocoa producer after CI
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-gh.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const GH_BBOX: readonly [number, number, number, number] = [4.6, -3.3, 11.2, 1.2]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4.6, -3.3, 11.2, -2.8],
  [11.0, -3.3, 11.2, 1.2],
  [6.0, 1.0, 11.2, 1.2],
]

await enrichGemIndustrial({
  countryCode: 'gh',
  countryName: "Ghana",
  bbox: GH_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, GH_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
