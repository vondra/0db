/**
 * Enrich ER industrial with GEM Global Integrated Power (Eritrea filter).
 *
 * Eritrea's Ministry of Energy publishes no open GIS or power plant data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Eritrea'):
 *     5 operating plants, ~99 MW total
 *
 *   Notable operating plants:
 *     **Hirgigo Power Station ~88 MW**  (HFO — Red Sea coast near Massawa, largest)
 *     **Asmara diesel ~11 MW**          (diesel — capital backup capacity)
 *     Small solar/wind micro-grids in off-grid towns
 *
 * Non-power industrial (OSM only):
 *   - **Port of Massawa** — main Red Sea port, salt flats (Recd Sea evaporation),
 *     small fish processing plants
 *   - **Asmara** — small light manufacturing, beverages (Asmara Brewery), textiles
 *   - **Mining** — gold (Bisha Mine, Nevsun/Zijin; Asmara project, Orca Gold);
 *     copper, zinc at Bisha (western lowlands near Sudan border)
 *   - **Cement** — Massawa Cement Factory (SNIM-linked); very small scale
 *   - **Salt** — Massawa salt works (Red Sea coast), significant export
 *
 * "North Korea of Africa" — extreme isolation, no open data, mandatory national service.
 * No railway: Italian colonial Asmara↔Massawa (73 km) is heritage/tourist only, not operational.
 *
 * ER_BBOX: [minLat=12.3, minLon=36.4, maxLat=18.0, maxLon=43.2]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-er.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const ER_BBOX: readonly [number, number, number, number] = [12.3, 36.4, 18.0, 43.2]

await enrichGemIndustrial({
  countryCode: 'er',
  countryName: "Eritrea",
  bbox: ER_BBOX,
})
