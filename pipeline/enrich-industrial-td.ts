/**
 * Enrich TD industrial with GEM Global Integrated Power (Chad filter).
 *
 * All Chad government portals (SNE, Ministère du Pétrole) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Chad'):
 *     1 operating plant, ~60 MW total
 *     Operating fuel: oil/gas (diesel) 1
 *
 *   Top operating plants:
 *     **Farcha 60 MW** (diesel — N'Djamena, SNE main thermal plant)
 *
 *   Note: Chad has ~11% electrification — one of the world's lowest.
 *   GEM coverage is extremely sparse; virtually all power is off-grid
 *   diesel generators not captured in GEM.
 *
 * Non-power industrial (OSM only):
 *   - **Oil**: Doba Basin (ExxonMobil→Savannah Energy) — Chad-Cameroon
 *       pipeline (1,070 km to Kribi port, completed 2003, one of Africa's
 *       largest infrastructure projects)
 *   - **Cement**: Cimenterie Nationale du Tchad (Pala)
 *   - **Gala Brewery** (Moundou — Castel Group, Chad's main beer)
 *   - **CotonTchad** (Moundou/Sarh — cotton ginning, was main export
 *       before oil)
 *   - **Natron** extraction (Lake Chad basin)
 *   - **Lake Chad** — shrunk 90% since 1960s (25,000→~1,350 km²),
 *       ecological catastrophe
 *   - **~11% electrification** — one of world's lowest
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-td.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const TD_BBOX: readonly [number, number, number, number] = [7.4, 13.5, 23.5, 24.0]

await enrichGemIndustrial({
  countryCode: 'td',
  countryName: "Chad",
  bbox: TD_BBOX,
})
