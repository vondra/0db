/**
 * Enrich SC industrial with GEM Global Integrated Power (Seychelles filter).
 *
 * Seychelles' PUC (Public Utilities Corporation) publishes limited corporate
 * data only. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Seychelles'):
 *     4 operating plants, ~72 MW total
 *
 *   Notable operating plants:
 *     **Roche Caiman Power Station 40 MW** (diesel — Mahé island main grid;
 *       PUC-operated; HFO + diesel; main supply for Mahé and Praslin via cable)
 *     **Grand Anse Praslin 10 MW**         (diesel — Praslin island; PUC)
 *     **La Digue Power Station 3 MW**      (diesel — La Digue island; PUC)
 *     **Offshore solar + battery 19 MW**   (solar — various outer islands; ADB-funded)
 *
 * Non-power industrial (OSM only):
 *   - **Tuna fishing/canning** — Indian Ocean Tuna Ltd (IOTL, Heinz JV) in
 *     Victoria; largest employer; up to 50k tonnes canned tuna/year; pole-and-line
 *     (MSC), EU export; Port Victoria is Indian Ocean's #1 tuna port
 *   - **Tourism infrastructure** — luxury resort construction and support
 *     (Four Seasons, Raffles, Six Senses, Fregate Island private); service
 *     industries dominant employer
 *   - **Fishing support** — fuel supply, ice plants, boat repair in Victoria
 *   - **Construction materials** — granite quarrying on Mahé, Praslin (inner
 *     islands are granitic — part of Gondwana continental shelf fragment)
 *   - **Beverages** — Seybrew brewery (lager + Eku), SeyPearl mineral water;
 *     local consumption + tourist market
 *   - **Coconut products** — copra/coconut oil (outer Amirantes islands);
 *     Silhouette Island plantation
 *   - **Vanilla** — niche cultivation (Curieuse, outer islands)
 *
 * SC_BBOX: [minLat=-10.2, minLon=46.2, maxLat=-3.7, maxLon=56.3]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-sc.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SC_BBOX: readonly [number, number, number, number] = [-10.2, 46.2, -3.7, 56.3]

await enrichGemIndustrial({
  countryCode: 'sc',
  countryName: "Seychelles",
  bbox: SC_BBOX,
})
