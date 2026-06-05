/**
 * Enrich MC industrial with GEM Global Integrated Power (Monaco filter).
 *
 * GEM reports 0 operating power plants for Monaco.
 * Script is a no-op for GEM matching but scans OSM industrial for completeness.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Monaco'):
 *     0 operating plants
 *
 * Non-power industrial (OSM only):
 *   - **Port Hercule** — the famous harbour; superyachts, cruise ships,
 *     cargo operations; Monaco's main commercial port
 *   - **Monte Carlo Casino** — landmark; not industrial but a major noise
 *     generator through traffic; OSM-tagged as tourism/casino
 *   - **Construction** — continuous luxury residential and hotel construction
 *     on land reclaimed from the sea (Fontvieille district)
 *   - **F1 infrastructure** — Circuit de Monaco; temporary barriers/grandstands
 *     during Grand Prix; permanent pitlane facilities in La Rascasse area
 *   - Note: Monaco bbox entirely within France's enriched area; France (FR)
 *     is already enriched. skip-existing (trafficSource>0) will handle overlap.
 *
 * MC_BBOX: [minLat=43.72, minLon=7.40, maxLat=43.76, maxLon=7.44]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-mc.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const MC_BBOX: readonly [number, number, number, number] = [43.72, 7.40, 43.76, 7.44]

await enrichGemIndustrial({
  countryCode: 'mc',
  countryName: "Monaco",
  bbox: MC_BBOX,
})
