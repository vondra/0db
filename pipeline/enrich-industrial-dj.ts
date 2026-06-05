/**
 * Enrich DJ industrial with GEM Global Integrated Power (Djibouti filter).
 *
 * Djibouti's government publishes no open GIS or power plant data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Djibouti'):
 *     2 operating plants, ~167 MW total
 *
 *   Notable operating plants:
 *     **Doraleh LNG / Horizon Terminal** — oil terminal + fuel import infrastructure
 *     **Tadjourah Wind Farm ~60 MW**    (wind — Ghoubet area, Siemens Gamesa turbines)
 *     **Damerjog power station ~87 MW** (HFO — main thermal plant, south of Djibouti City)
 *
 * Non-power industrial (OSM only):
 *   - **Port of Djibouti / Doraleh** — critical Horn of Africa transshipment hub;
 *     DP World operated (until 2018 dispute), Doraleh Container Terminal;
 *     handles ~80% of Ethiopia's imports/exports
 *   - **Foreign military bases** — US Camp Lemonnier (AFRICOM HQ), French Base
 *     Interarmées de Djibouti, Chinese PLA Naval Base (first overseas), Japanese
 *     JMSDF, Italian/Spanish/German contingents — significant vehicle/generator noise
 *   - **Damerjog industrial zone** — planned free zone south of city
 *   - **Doraleh Multipurpose Port** — China Merchants Port Holdings 23.5% stake
 *
 * Addis-Djibouti Electrified Railway (Ethiopian enrichment handles it — starts in ET).
 *
 * DJ_BBOX: [minLat=10.9, minLon=41.7, maxLat=12.8, maxLon=43.5]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-dj.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const DJ_BBOX: readonly [number, number, number, number] = [10.9, 41.7, 12.8, 43.5]

await enrichGemIndustrial({
  countryCode: 'dj',
  countryName: "Djibouti",
  bbox: DJ_BBOX,
})
