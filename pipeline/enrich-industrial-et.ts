/**
 * Enrich ET industrial with GEM Global Integrated Power (Ethiopia filter).
 *
 * All Ethiopian gov portals publish HTML/corporate sites only. GEM is the
 * only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ethiopia'):
 *     90 total, 25 operating
 *     Operating fuel breakdown: hydropower 12, wind 7, bioenergy 5, solar 1
 *
 *   Top operating plants:
 *     **Gilgel Gibe III 1,870 MW** (Omo River, commissioned 2016 — Africa's
 *                                    tallest RCC dam, 243 m)
 *     **GERD (Grand Ethiopian Renaissance Dam) 750 MW operating** (2 of 13
 *                                    turbines commissioned 2022-2023; full
 *                                    5,700 MW still under construction — will
 *                                    be **Africa's largest power plant**)
 *     **Gilgel Gibe II 420 MW** (Omo River, 2010)
 *     **Gilgel Gibe I 184 MW** (Omo River, 2004)
 *     **Tekeze 300 MW** (Tigray, Tekeze River)
 *     **Beles 460 MW** (Tana-Beles, Blue Nile basin)
 *     **Finchaa 134 MW** (Blue Nile basin)
 *     **Melka Wakana 153 MW** (Wabe Shebelle River)
 *     **Adama Wind I+II ~204 MW** (near Adama/Nazret)
 *     **Ashegoda Wind 120 MW** (Tigray, 2013 — first commercial wind farm)
 *     **Aysha Wind 120 MW** (Somali Region)
 *
 * **Under construction (not counted as operating)**:
 *     **GERD full capacity 5,700 MW** — to be **Africa's largest** when
 *        complete, surpassing Inga I+II DRC (1,775+710 MW) and Aswan (2.1 GW)
 *     **Koysha 2,160 MW** (Omo River)
 *
 * Non-power industrial (OSM only):
 *   - Cement: Dangote Mugher, Habesha, Messebo, National Cement
 *   - Sugar: EIH Metahara, Wonji-Shoa, Fincha, Tendaho sugar factories
 *   - Leather + textiles industrial parks (Hawassa, Bole Lemi, Bomboloi)
 *   - No oil refinery (Assab refinery closed 1997 during Eritrean independence)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-et.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const ET_BBOX: readonly [number, number, number, number] = [3.4, 33.0, 14.9, 48.0]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [3.4, 33.0, 14.9, 35.0],
  [3.4, 33.0, 5.5, 36.0],
  [3.4, 36.0, 5.0, 42.0],
  [3.4, 42.0, 12.0, 48.0],
  [10.9, 41.7, 12.7, 43.3],
  [14.3, 36.0, 14.9, 43.3],
]

await enrichGemIndustrial({
  countryCode: 'et',
  countryName: "Ethiopia",
  bbox: ET_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, ET_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
