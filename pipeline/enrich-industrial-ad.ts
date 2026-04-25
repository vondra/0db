/**
 * Enrich AD industrial with GEM Global Integrated Power (Andorra filter).
 *
 * Andorra has no official open industrial data portal.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Andorra'):
 *     2 operating plants, ~46 MW total
 *
 *   Notable operating plants:
 *     **FEDA hydro plants**   (hydro — Valira del Nord and Valira d'Orient rivers;
 *                              Forces Elèctriques d'Andorra, state utility)
 *
 * Non-power industrial (OSM only):
 *   - **Duty-free retail** — major commercial zones in Andorra la Vella and
 *     Escaldes; tobacco, alcohol, electronics, perfume; drives enormous tourist
 *     traffic (~10 M visitors/year, 130x population)
 *   - **Tourism/ski** — Grandvalira (largest ski area in Pyrenees), Vallnord;
 *     ~300 ski days/year; significant snowmaking infrastructure
 *   - **Construction** — continuous resort, hotel, and road construction
 *   - **Banking/finance** — financial services concentrated in Andorra la Vella
 *
 * AD_BBOX: [minLat=42.4, minLon=1.4, maxLat=42.7, maxLon=1.8]
 *
 * Border excludes:
 *   lat < 42.43 → Spain
 *   lat > 42.66 → France
 *   lon < 1.41  → Spain
 *   lon > 1.79  → France/Spain
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ad.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const AD_BBOX: readonly [number, number, number, number] = [42.4, 1.4, 42.7, 1.8]

await enrichGemIndustrial({
  countryCode: 'ad',
  countryName: "Andorra",
  bbox: AD_BBOX,
  isInside: (lat, lon) => {
    if (lat < AD_BBOX[0] || lat > AD_BBOX[2]) return false
    if (lon < AD_BBOX[1] || lon > AD_BBOX[3]) return false
    if (lat < 42.43) return false  // Spain
    if (lat > 42.66) return false  // France
    if (lon < 1.41) return false   // Spain
    if (lon > 1.79) return false   // France/Spain
    return true
  },
})
