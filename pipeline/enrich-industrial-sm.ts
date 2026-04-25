/**
 * Enrich SM industrial with GEM Global Integrated Power (San Marino filter).
 *
 * GEM reports 0 operating power plants for San Marino.
 * Script is a no-op for GEM matching but scans OSM industrial for completeness.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='San Marino'):
 *     0 operating plants
 *
 * Non-power industrial (OSM only):
 *   - **Tourism** — ~2 M visitors/year; souvenir shops, hotels on Monte Titano;
 *     Three Towers (Guaita, Cesta, Montale); UNESCO World Heritage Site
 *   - **Banking/finance** — offshore financial services, philately, numismatics
 *   - **Ceramics** — traditional craft production
 *   - **Construction** — continuous residential and hotel development
 *   - Note: SM bbox overlaps Italy; Italy (IT) already enriched.
 *     skip-existing (trafficSource>0) handles overlap.
 *
 * SM_BBOX: [minLat=43.89, minLon=12.40, maxLat=43.99, maxLon=12.52]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-sm.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SM_BBOX: readonly [number, number, number, number] = [43.89, 12.40, 43.99, 12.52]

await enrichGemIndustrial({
  countryCode: 'sm',
  countryName: "San Marino",
  bbox: SM_BBOX,
})
