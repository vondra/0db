/**
 * Enrich ZM industrial with GEM Global Integrated Power (Zambia filter).
 *
 * All Zambian gov portals (RDA, ZRL, ZESCO, CEC, Ministry of Energy, Ministry
 * of Mines) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Zambia'):
 *     82 total, 15 operating, ~4.76 GW — **one of Africa's largest hydro fleets**
 *     Operating fuel: hydropower 5, solar 5, coal 3, oil/gas 1, bioenergy 1
 *
 *   Top operating plants:
 *     **Kariba Dam 2,130 MW** (Zambezi at Kariba — GEM lists whole dam
 *                               under Zambia; **world's largest dam when
 *                               built 1959**, shared with Zimbabwe/Kariba
 *                               South on opposite bank. Kariba North Bank
 *                               was upgraded 2014 from 720 MW to ~1,080 MW
 *                               by Sinohydro. **Severely drought-constrained
 *                               2022-2024**.)
 *     **Kafue Gorge Upper 990 MW** (Kafue River, 1971 — Zambia's second-
 *                                    largest plant, ZESCO-owned)
 *     **Kafue Gorge Lower 750 MW** (Kafue River, **opened 2024** — Zambia's
 *                                    newest major hydro, Sinohydro-built,
 *                                    downstream of Upper)
 *     **Maamba Coal 300 MW** (2×150 MW — **Zambia's only coal plant**,
 *                              SE Zambia at Maamba Collieries)
 *     **Itezhi-Tezhi 120 MW** (Kafue River regulator dam, 2016)
 *     **Victoria Falls Power Station 108 MW** (old colonial-era 3 plants)
 *     **Ndola Energy HFO 105 MW** (oil/gas — Copperbelt emergency)
 *     **Itimpi + Bangweulu + Ngonye + Riverside Solar** (~185 MW total)
 *     **Nakambala 40 MW bioenergy** (sugarcane bagasse cogeneration —
 *                                     Zambia Sugar Company Mazabuka)
 *     **Ndola Cement 30 MW coal** (captive for cement plant)
 *
 * Non-power industrial (OSM only):
 *   - **Copperbelt Province** — Zambia's industrial heartland
 *   - **Konkola Copper Mines (KCM)** — Chingola/Chililabombwe, Vedanta
 *     (struggling, state dispute 2019+)
 *   - **Mopani Copper Mines** — Mufulira/Kitwe (formerly Glencore, now
 *     ZCCM-IH majority state-owned after 2021 sale)
 *   - **First Quantum Minerals (FQM)** — **Kansanshi (Solwezi)** + **Sentinel
 *     (Kalumbila)**, NW Province. **Kansanshi is Africa's largest copper
 *     mine by production**. Both open pit.
 *   - **Barrick Lumwana** — Solwezi NW, open-pit copper
 *   - **Copper refining**: Nkana Refinery (Kitwe), Ndola Copper Refinery,
 *     Mufulira Smelter (Mopani), Nchanga Smelter (KCM)
 *   - **Kafue Steel** (Kafue) — moderate steel production
 *   - **Cement**: Lafarge Zambia (Chilanga), Dangote Cement (Masaiti),
 *     Mpande, Ndola Cement Plant
 *   - **INDENI Petroleum Refinery** (Ndola) — **closed 2019**, converted
 *     to fuel storage
 *   - **Emeralds**: **Kagem** (Lufwanyama Copperbelt) — **world's largest
 *     emerald mine**, Gemfields operated (75% state)
 *   - **Manganese**: Serenje area
 *   - **Chilanga Cement** (Lusaka area, Lafarge)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-zm.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const ZM_BBOX: readonly [number, number, number, number] = [-18.1, 21.9, -8.2, 33.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-11.7, 22.0, -8.2, 30.5],
  [-9.2, 31.0, -8.2, 33.7],
  [-16.0, 33.0, -9.0, 33.7],
  [-17.5, 32.0, -15.5, 33.7],
  [-17.0, 27.5, -16.0, 31.5],
  [-18.1, 25.0, -17.75, 25.5],
  [-18.1, 21.9, -17.45, 25.3],
  [-15.5, 21.9, -8.2, 23.5],
]

await enrichGemIndustrial({
  countryCode: 'zm',
  countryName: "Zambia",
  bbox: ZM_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, ZM_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
