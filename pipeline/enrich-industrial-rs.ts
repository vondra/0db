/**
 * Enrich RS industrial with GEM Global Integrated Power (Serbia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Serbia'):
 *     148 total / 44 operating / ~7.3 GW
 *     Operating fuel: coal 18 (DOMINANT), hydro 6, wind 7, solar 8, oil/gas 4, bioenergy 1
 *
 *   Top operating plants:
 *     **TENT Nikola Tesla** ~2,837 MW (lignite, 7 units, Obrenovac —
 *                            Serbia's largest, feeds from Kolubara mines)
 *     **Kostolac** 1,260 MW (lignite, 4 units, Požarevac)
 *     **Bajina Basta** 1,034 MW (pumped 614 + conventional 420,
 *                                Drina River, reversible storage)
 *     **Đerdap/Iron Gates I+II** ~1,160 MW Serbia's half
 *                                (listed under Romania in GEM, shared with RO)
 *     **Čibuk 1** 158 MW (wind — Serbia's first large wind farm)
 *
 * Non-power industrial (OSM only):
 *   - **NIS refinery Pančevo** (Gazprom Neft, 100k bpd — Russian-controlled,
 *     largest refinery in Western Balkans)
 *   - **HBIS Smederevo** (formerly US Steel, sold to Chinese HBIS 2016,
 *     ~2.2 MT/yr, Serbia's largest employer)
 *   - **RTB Bor** (state copper mine, one of Europe's largest,
 *     Bor/Majdanpek, expanded with Chinese investment)
 *   - **Vreoci/Kolubara lignite mines** (Obrenovac — Serbia's largest coal
 *     complex, feeds TENT power plant)
 *   - **Cement**: CRH Kosjerić, Lafarge Beočin (oldest cement plant in Serbia)
 *   - **Fiat Chrysler/Stellantis** Kragujevac (Tipo, Fiat 500L, ~200k units/yr)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-rs.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const RS_BBOX: readonly [number, number, number, number] = [42.2, 18.8, 46.2, 23.1]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [46.0, 18.8, 46.2, 23.1],
  [44.8, 21.5, 46.2, 23.1],
  [42.2, 22.3, 43.2, 23.1],
  [42.2, 18.8, 42.4, 23.1],
  [42.3, 18.8, 43.0, 21.2],
  [42.2, 18.8, 43.8, 19.4],
  [43.8, 18.8, 46.2, 19.4],
  [45.5, 18.8, 46.2, 19.4],
]

await enrichGemIndustrial({
  countryCode: 'rs',
  countryName: "Serbia",
  bbox: RS_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, RS_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
