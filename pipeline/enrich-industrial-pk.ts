/**
 * Enrich PK industrial with GEM Global Integrated Power (Pakistan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Pakistan'):
 *     432 total / 203 operating / ~46.3 GW
 *     Operating fuel: oil/gas 60, solar 57, wind 36, coal 21, hydropower 18, nuclear 6
 *
 *   Top operating plants:
 *     **Tarbela 4,888 MW** (Indus River, KPK — Pakistan's largest hydro,
 *                            world's 9th largest earth-filled dam)
 *     **Ghazi Barotha 1,450 MW** (Indus near Attock, run-of-river)
 *     **Mangla 1,070 MW** (Jhelum River, AJK)
 *     **Neelum-Jhelum 969 MW** (AJK, underground powerhouse)
 *     **Karachi Nuclear 2,200 MW** (KANUPP-2 & KANUPP-3, Hualong One,
 *                                   2021/2022 — China-Pakistan nuclear deal,
 *                                   largest nuclear capacity in Muslim world)
 *     **Balloki RLNG 1,223 MW** + **Trimmu RLNG 900 MW** +
 *     **HBS RLNG 1,230 MW** + **Bhikki RLNG 1,180 MW** —
 *                            Pakistan's ~5,000+ MW RLNG gas fleet
 *                            (LNG imported via Port Qasim, Karachi)
 *
 * Non-power industrial (OSM only):
 *   - **Pakistan Steel Mills** (Karachi, Bin Qasim) — integrated steel
 *     plant, 1.1 MT/yr capacity, **largely defunct** since 2015 (PSM crisis)
 *   - **Faisalabad** — "Manchester of Pakistan", Pakistan's largest textile
 *     hub; 600+ export-oriented units, denim, knit, yarn, knitwear
 *   - **Cement**: Lucky Cement (DG Khan, Pezu), DG Khan Cement, Bestway
 *     (Hattar, Farooqia), Maple Leaf (Mianwali), Fauji Cement (Jhang)
 *   - **Oil refineries**: PRL (Pakistan Refinery Ltd, Karachi), ARL
 *     (Attock Refinery, Rawalpindi/Morgah), NRL (National Refinery, Karachi),
 *     Byco (Balochistan)
 *   - **Fertilizers**: Fauji Fertilizer (Goth Machhi, Sadiqabad), Engro
 *     Fertilizers (Daharki, Sindh), Fatima Fertilizer (Multan)
 *   - **CPEC (China-Pakistan Economic Corridor)**: Gwadar Port (deep-water,
 *     Balochistan), Gwadar Free Zone, Sahiwal Coal Power Plant (2×660 MW),
 *     Hub Power (1,320 MW CPEC coal)
 *   - **Chemicals/pharma**: ICI Pakistan (soda ash, Khewra Salt Mine area),
 *     Searle, Ferozsons
 *   - **Sugar mills**: Punjab/Sindh belt — Pakistan 5th largest sugar producer
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-pk.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const PK_BBOX: readonly [number, number, number, number] = [23.6, 60.8, 37.1, 77.8]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [23.6, 74.5, 34.0, 77.8],
  [36.0, 74.0, 37.1, 77.8],
  [30.0, 60.8, 37.1, 66.0],
  [33.0, 60.8, 37.1, 70.0],
  [23.6, 60.8, 28.0, 63.0],
]

await enrichGemIndustrial({
  countryCode: 'pk',
  countryName: "Pakistan",
  bbox: PK_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, PK_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
