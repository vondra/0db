/**
 * Enrich GE industrial with GEM Global Integrated Power (Georgia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power** (Country_area='Georgia'):
 *     60 total / 27 operating / ~4.06 GW
 *     Hydro-dominated: hydro 19 (Enguri 1,300 MW — one of world's tallest
 *       arch dams 272m + Vardnili/Shuakhevi/Zhinvali/Khrami I+II/Lajanuri/
 *       Dariali), oil/gas 7 (Tbilsresi 572 + Gardabani 485 — Azerbaijan gas),
 *       wind 1. EU candidate 2023.
 *
 * Non-power industrial (OSM only):
 *   - **Rustavi steel** (Rustavi Metallurgical Plant — Soviet-era, declining)
 *   - **Zestaponi ferroalloy** (Georgian Manganese)
 *   - **Batumi oil terminal** (BP Caspian pipeline)
 *   - **Chiatura manganese** (one of world's oldest manganese deposits,
 *     since 1879)
 *   - **Georgian wine** (~8,000 year tradition, world's oldest wine country)
 *   - **Cement** (Heidelberg Kaspi)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ge.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const GE_BBOX: readonly [number, number, number, number] = [41.0, 40.0, 43.6, 46.8]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [43.0, 40.0, 43.6, 46.8],
  [41.0, 40.0, 41.3, 42.5],
  [41.0, 43.5, 41.4, 46.8],
  [41.0, 46.0, 43.6, 46.8],
]

await enrichGemIndustrial({
  countryCode: 'ge',
  countryName: "Georgia",
  bbox: GE_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, GE_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
