/**
 * Enrich HT industrial with GEM Global Integrated Power (Haiti filter).
 *
 * Haiti has **0 utility-scale power plants** in GEM — the poorest country in
 * the Western Hemisphere. Électricité d'Haïti (EDH) provides intermittent grid
 * power to ~30% of the population, mostly from small diesel generators and
 * a handful of micro-hydro sites. No plant meets GEM's reporting threshold.
 *
 * This script will find 0 GEM plants and produce 0 NACE updates.
 * It still runs cleanly and logs correct totals.
 *
 * Non-power industrial (OSM only):
 *   - **Textiles/garment assembly**: ~90% of export value. CODEVI free trade zone
 *     (Ouanaminthe), SONAPI industrial park (Port-au-Prince). US buyers: Hanes, Gap, Fruit of the Loom.
 *   - **Cement**: Cimenterie d'Haïti (Cap-Haïtien area), CEMEX Haïti
 *   - **Rum/spirits**: Barbancourt distillery (Portail Léogâne, Port-au-Prince) — Haiti's best-known export
 *   - **Vetiver**: Haiti is world's #1 vetiver oil producer (south peninsula, Les Cayes area)
 *   - **Mangoes/coffee**: Madame Francis mangoes — top agricultural export
 *
 * Bbox note:
 *   Haiti shares Hispaniola with the Dominican Republic. The land border runs
 *   roughly at 71.7°W. Exclude lon > -71.7 to avoid DR territory.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ht.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const HT_BBOX: readonly [number, number, number, number] = [18.0, -74.5, 20.1, -71.6]

await enrichGemIndustrial({
  countryCode: 'ht',
  countryName: "Haiti",
  bbox: HT_BBOX,
  isInside: (lat, lon) => {
    if (lat < HT_BBOX[0] || lat > HT_BBOX[2]) return false
    if (lon < HT_BBOX[1] || lon > HT_BBOX[3]) return false
    if (lat < HT_BBOX[0] || lat > HT_BBOX[2]) return false
    if (lon < HT_BBOX[1] || lon > HT_BBOX[3]) return false
    if (lon > -71.7) return false
    return true
  },
})
