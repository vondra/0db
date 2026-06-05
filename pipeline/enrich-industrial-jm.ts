/**
 * Enrich JM industrial with GEM Global Integrated Power (Jamaica filter).
 *
 * Jamaica's power sector is partially liberalized; Jamaica Public Service (JPS,
 * majority-owned by EWP/Marubeni) is the sole distributor. IPPs supply ~60%.
 * GEM is the only machine-readable open source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Jamaica'):
 *     ~13 operating plants, ~885 MW total
 *
 *   Top operating plants:
 *     **Old Harbour** (oil — 200 MW; 17.94°N, 77.10°W)
 *     **Old Harbour B** (oil/gas — 120 MW; 17.94°N, 77.10°W)
 *     **Bogue** (oil/gas — 120 MW, St. James; 18.47°N, 77.93°W)
 *     **Wigton Wind Farm** (wind — 62 MW, Manchester; 18.03°N, 77.43°W)
 *     **Maggotty** (hydro — 21 MW, St. Elizabeth; 18.15°N, 77.76°W)
 *
 * Non-power industrial (OSM only):
 *   - **Bauxite/alumina**: Jamaica's #1 export. Alpart (Nain), Windalco (Kirkvine/Ewarton),
 *     Jamaica Bauxite Institute. Caribbean's largest bauxite producer.
 *   - **Sugar**: Appleton Estate rum/sugar (St. Elizabeth), Worthy Park, Hampden distillery
 *   - **Rum**: Appleton, Wray & Nephew, Worthy Park (global rum destination)
 *   - **Tourism**: #1 foreign exchange. Montego Bay, Negril, Ocho Rios resorts.
 *   - **Port of Kingston**: major transhipment hub (Kingston Container Terminal, KCT)
 *   - **Desnoes & Geddes**: Red Stripe brewery (Heineken)
 *
 * JM is an island — no neighbor-border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-jm.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const JM_BBOX: readonly [number, number, number, number] = [17.7, -78.4, 18.6, -76.2]

await enrichGemIndustrial({
  countryCode: 'jm',
  countryName: "Jamaica",
  bbox: JM_BBOX,
})
