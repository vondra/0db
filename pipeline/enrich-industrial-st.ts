/**
 * Enrich ST industrial with GEM Global Integrated Power (São Tomé and Príncipe filter).
 *
 * GEM reports 0 operating power plants for São Tomé and Príncipe.
 * Script is a no-op for GEM matching but scans OSM industrial for completeness.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Sao Tome and Principe'):
 *     0 operating plants
 *
 * Non-power industrial (OSM only):
 *   - **Cocoa/chocolate** — São Tomé is famous for single-origin fine cocoa;
 *     Roça plantations (colonial-era estates) across the island: Roça Agostinho
 *     Neto, Roça Monte Café, Roça Boa Entrada; Claudio Corallo, Färm brands
 *   - **Palm oil** — secondary crop on old roças; small-scale local processing
 *   - **Fish processing** — artisanal fisheries, tuna; main landing site São Tomé city
 *   - **Tourism** — eco-lodges, resorts; small but growing; São Tomé is Africa's
 *     2nd smallest country (after Seychelles)
 *   - **Construction** — sand quarrying on beaches (environmental concern)
 *
 * ST_BBOX: [minLat=0.0, minLon=6.4, maxLat=1.7, maxLon=7.5]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-st.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const ST_BBOX: readonly [number, number, number, number] = [0.0, 6.4, 1.7, 7.5]

await enrichGemIndustrial({
  countryCode: 'st',
  countryName: "Sao Tome and Principe",
  bbox: ST_BBOX,
})
