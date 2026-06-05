/**
 * Enrich BB industrial with GEM Global Integrated Power (Barbados filter).
 *
 * The Barbados Light & Power Company (BLPC) and Fair Trading Commission
 * publish no open machine-readable plant data. GEM is the only usable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Barbados'):
 *     11 operating plants, ~83 MW total (mostly small solar)
 *
 *   Notable operating plants:
 *     **BLPC Spring Garden 52 MW**       (HFO — Bridgetown, main thermal)
 *     **Trident Power 11 MW**            (HFO — St. Michael)
 *     **Barbados Solar 1 5 MW**          (solar — Christ Church)
 *     **Barbados Solar 2 5 MW**          (solar — St. Philip)
 *     **Various rooftop/small solar**    (solar — distributed, BREA-registered)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar** — Mount Gay Rum and Foursquare distillery are major exporters;
 *     Barbados claims to be the birthplace of rum (c. 1640s); Andrews sugar
 *     factory (last operational cane crusher); sugar cane still grown but
 *     industry much diminished from colonial peak
 *   - **Tourism / hospitality** — dominant economic sector; west coast
 *     (Platinum Coast) luxury hotels; east coast (Bathsheba) surfing;
 *     Grantley Adams International Airport is eastern Caribbean hub
 *   - **Financial services** — major offshore banking jurisdiction
 *   - **Light manufacturing** — food processing, garments (EPZ)
 *   - **Petroleum** — small onshore Woodbourne oilfield (St. Philip);
 *     Barbados National Oil Company (BNOC) produces ~1000 bbl/day
 *
 * BB_BBOX: [minLat=13.0, minLon=-59.7, maxLat=13.4, maxLon=-59.4]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-bb.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BB_BBOX: readonly [number, number, number, number] = [13.0, -59.7, 13.4, -59.4]

await enrichGemIndustrial({
  countryCode: 'bb',
  countryName: "Barbados",
  bbox: BB_BBOX,
})
