/**
 * Enrich CV industrial with GEM Global Integrated Power (Cabo Verde filter).
 *
 * Cabo Verde government portals publish no machine-readable power data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cabo Verde'):
 *     8 operating plants, ~46 MW total
 *
 *   Notable operating plants:
 *     **Cabeólica wind 26 MW**   (wind — 4 islands: Santiago, Sal, São Vicente, Boa Vista)
 *     **Solar plants**           (solar PV — various islands, government ELECTRA utility)
 *
 * Non-power industrial (OSM only):
 *   - **Salt** — Sal and Maio islands; traditional salt extraction, "Sal" means salt
 *   - **Fish processing** — Mindelo (São Vicente) and Praia (Santiago); tuna/lobster export
 *   - **Construction materials** — sand/gravel quarries across islands for tourism construction
 *   - **Tourism infrastructure** — hotels, resorts on Sal, Boa Vista, Santiago
 *
 * CV_BBOX: [minLat=14.8, minLon=-25.4, maxLat=17.2, maxLon=-22.6]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cv.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const CV_BBOX: readonly [number, number, number, number] = [14.8, -25.4, 17.2, -22.6]

await enrichGemIndustrial({
  countryCode: 'cv',
  countryName: "Cabo Verde",
  bbox: CV_BBOX,
})
