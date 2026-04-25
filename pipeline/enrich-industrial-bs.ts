/**
 * Enrich BS industrial with GEM Global Integrated Power (Bahamas filter).
 *
 * All Bahamas government portals (BEC, Department of Public Works) publish
 * no open machine-readable plant data. GEM is the only usable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Bahamas'):
 *     2 operating plants, ~184 MW total
 *
 *   Notable operating plants:
 *     **BEC Clifton Pier 132 MW**     (HFO — New Providence, main island)
 *     **BEC Grand Bahama 52 MW**      (HFO — Grand Bahama / Freeport)
 *
 * Non-power industrial (OSM only):
 *   - **Tourism infrastructure** — cruise ship terminals (Nassau, Freeport),
 *     resort complexes (Atlantis Paradise Island, Grand Lucayan); largest
 *     economic sector by far
 *   - **Bunkering / fuel** — Nassau is a major Caribbean bunkering hub;
 *     BORCO (South Riding Point, Grand Bahama) is one of the world's largest
 *     private oil storage terminals (~26 M barrels)
 *   - **Salt** — Inagua Islands; Morton Salt operates the second-largest
 *     solar evaporation works in the Western Hemisphere
 *   - **Cement / aggregates** — sand dredging from offshore banks
 *   - **Banking / financial services** — major offshore sector (Nassau);
 *     not industrial but significant economic driver
 *
 * BS_BBOX: [minLat=20.9, minLon=-80.5, maxLat=27.3, maxLon=-72.7]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bs.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BS_BBOX: readonly [number, number, number, number] = [20.9, -80.5, 27.3, -72.7]

await enrichGemIndustrial({
  countryCode: 'bs',
  countryName: "Bahamas",
  bbox: BS_BBOX,
})
