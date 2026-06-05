/**
 * Enrich WS industrial with GEM Global Integrated Power (Samoa filter).
 *
 * All Samoan government portals publish corporate HTML only. GEM is the only
 * machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Samoa'):
 *     4 tiny solar plants, ~8.1 MW total, all on Upolu island near Apia
 *
 *   Operating plants:
 *     **Satapuala solar 2.6 MW**     (solar — Upolu, NW coast)
 *     **Satapuala solar 2.0 MW**     (solar — Upolu, NW coast)
 *     **Faleolo Airport solar 2.1 MW** (solar — Upolu, Faleolo international airport)
 *     **Faleata solar 1.4 MW**       (solar — Upolu, Faleata industrial area near Apia)
 *
 * Non-power industrial (OSM only):
 *   - **EPC (Electric Power Corporation)** — state utility; diesel generators
 *     (below GEM threshold) provide backup power alongside solar/hydro
 *   - **Yazaki** — Japanese automotive wiring harness manufacturer; largest
 *     private-sector employer in Samoa, factory in Apia area
 *   - **Tui Brewery** — Samoa Breweries Ltd, produces Vailima and Taula beers
 *   - **Fishing/tuna**: small-scale canneries; Samoa is a signatory to Pacific
 *     tuna management agreements
 *   - **Coconut products**: virgin coconut oil, copra — traditional export
 *   - **Taro and nonu (noni) fruit**: smallholder agricultural processing
 *   - **Tourism**: Aggie Grey's, Sheraton; tourism is top foreign-exchange earner
 *
 * Bbox note:
 *   Samoa lies between ~171°W and ~172.8°W — standard negative longitudes,
 *   no antimeridian handling needed. Both main islands (Upolu + Savai'i) are
 *   covered by WS_BBOX. No neighbor excludes — island nation.
 *   WS_BBOX: minLat=-14.1, minLon=-172.8, maxLat=-13.4, maxLon=-171.2
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ws.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const WS_BBOX: readonly [number, number, number, number] = [-14.1, -172.8, -13.4, -171.2]

await enrichGemIndustrial({
  countryCode: 'ws',
  countryName: "Samoa",
  bbox: WS_BBOX,
})
