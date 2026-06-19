/**
 * Enrich AM industrial with GEM Global Integrated Power (Armenia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Armenia'):
 *     73 total / 50 operating / ~2.61 GW
 *     Operating fuel: solar 38 (all small <15 MW, recent), hydro 7, oil/gas 4, nuclear 1
 *
 *   Top operating plants:
 *     **Metsamor Nuclear 448 MW** (Soviet VVER-440 units 1+2 — only nuclear plant in
 *                                   Caucasus, controversial seismic zone, 35 km W of Yerevan)
 *     **Hrazdan 631 MW** (gas/oil, Hrazdan city — largest thermal plant)
 *     **Yerevan 1+2 496 MW** (gas turbine, Yerevan — combined cycle)
 *     **Vorotan cascade ~404 MW total**: Spandaryan 76 MW + Shamb 171 MW + Tatev 157 MW
 *                                        (Vorotan River gorge, Syunik — operated by ContourGlobal)
 *
 * Non-power industrial (OSM only):
 *   - **Zangezur copper-molybdenum combine** (Kajaran, Syunik — one of world's
 *     largest Cu-Mo deposits, major export earner)
 *   - **Armenian Molybdenum Production** (Yerevan — secondary processing)
 *   - **Ararat cement** (old Soviet + new Turkish-built plant near Ararat/Masis)
 *   - **Nairit rubber** (Yerevan — Soviet-era synthetic rubber plant, closed ~2010s,
 *     major environmental legacy site)
 *   - **ArArAt brandy/cognac** (Yerevan Brandy Company — world-famous brand,
 *     Pernod Ricard; ARARAT cognac exported globally)
 *   - No oil/gas production. No coal. No steel.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-am.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const AM_BBOX: readonly [number, number, number, number] = [38.8, 43.4, 41.35, 46.65]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [38.8, 43.4, 41.35, 43.6],
  [41.2, 43.4, 41.35, 46.65],
  [38.8, 46.0, 41.35, 46.65],
  [38.8, 43.4, 39.0, 46.65],
  [38.8, 43.4, 39.6, 45.0],
]

await enrichGemIndustrial({
  countryCode: 'am',
  countryName: "Armenia",
  bbox: AM_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, AM_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
