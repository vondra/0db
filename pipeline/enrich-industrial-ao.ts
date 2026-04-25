/**
 * Enrich AO industrial with GEM Global Integrated Power (Angola filter).
 *
 * All Angolan gov portals (Sonangol, Prodel, RNT, Ministério dos Recursos
 * Minerais e Petróleo) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Angola'):
 *     76 total, 26 operating, ~5.1 GW
 *     Operating fuel: solar 14, hydropower 6, oil/gas 4, bioenergy 1, wind 1
 *
 *   Top operating plants:
 *     **Laúca 2,070 MW** (Kwanza River, opened 2017 — **Africa's 6th largest
 *                         hydropower, Angola's largest single plant**)
 *     **Cambambe II 700 MW** (Kwanza River, 2017)
 *     **Capanda 520 MW** (Kwanza River, 2004)
 *     **Soyo 720 MW** (2×360 MW CCGT, Zaire province — Angola's main gas plant,
 *                      fed by Congo River basin gas)
 *     **Biópio Solar 189 MW** (Benguela — Angola's largest utility solar)
 *     **Cambambe I 180 MW** (Kwanza River, 1963 — Angola's oldest major hydro)
 *     **CFL power station 125 MW** (oil/gas, Luanda railway depot)
 *     **Biocom bioenergy 100 MW** (sugarcane bagasse, Malanje — Biocom
 *                                   sugar-ethanol complex)
 *     **Benguela Solar 97 MW**, **Baía Farta 96 MW**, **Quileva 84 MW gas**
 *     **Gove Dam 60 MW**, **Lomaúm 50 MW** (hydros)
 *     **Morro do Ouro Wind 50 MW** (near Tombwa, Namibe — Angola's first wind farm)
 *
 *  **Under construction (not counted as operating)**:
 *     **Caculo Cabaça 2,172 MW** — Kwanza River, under construction since 2018,
 *                                   when complete will be **Angola's largest
 *                                   power plant**, overtaking Laúca
 *
 * Non-power industrial (OSM only):
 *   - **Sonangol** — state oil company, one of Africa's largest
 *     - **Offshore oil fields**: Kizomba, Plutonio, CLOV, Dalia, Girassol,
 *       Pazflor (deep-water Atlantic, Block 15/17/18)
 *     - **Angola is Africa's 2nd largest oil producer** after Nigeria
 *       (~1.1 Mbbl/day, historically OPEC member until 2023)
 *     - **Luanda Refinery** — ~65k bpd, old (1950s)
 *     - **Lobito Refinery** — under construction (new 200k bpd facility)
 *     - **Angola LNG (Soyo)** — opened 2013, Chevron/Sonangol/BP/ENI/TotalEnergies
 *   - **Cabinda enclave** — separated from mainland by DRC strip, hosts
 *     significant offshore operations (Malongo terminal, Cabinda Gulf Oil)
 *   - **Cement**: Nova Cimangola (Luanda), Ciment de Lobito, Empresa de Cimentos de Angola
 *   - **Diamonds**: **Catoca mine** (Lunda Sul — world's #4 diamond mine,
 *     Alrosa + Endiama), Lunda Norte alluvial operations
 *   - **Iron ore**: Cassinga (historic, reopening), Cassala-Kitungo
 *   - **Luanda Port** — Africa's busiest lusophone port
 *   - **Biocom sugar-ethanol** (Malanje) — integrated sugarcane complex
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ao.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const AO_BBOX: readonly [number, number, number, number] = [-18.1, 11.6, -4.3, 24.2]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-6.05, 11.6, -5.85, 13.20],
  [-5.85, 13.20, -4.3, 24.2],
  [-6.5, 16.0, -4.3, 24.2],
  [-17.0, 22.5, -11.0, 24.2],
  [-18.1, 11.6, -17.0, 24.2],
]

await enrichGemIndustrial({
  countryCode: 'ao',
  countryName: "Angola",
  bbox: AO_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, AO_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
