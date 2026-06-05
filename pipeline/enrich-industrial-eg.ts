/**
 * Enrich EG industrial with GEM Global Integrated Power (Egypt filter).
 *
 * All Egyptian gov portals are dead/blocked:
 *   - MOT, GARBLT, EETC, NREA, NAT, Ministry of Petroleum — TCP timeout/refused
 *   - ENR/enr.gov.eg — redirects to Vaadin login
 *   - CAPMAS — HTML SPA only, no REST
 * GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Egypt'):
 *     309 total, 200 operating
 *     Operating fuel breakdown:
 *       oil/gas: 109 (Beni Suef 4×1.2 GW, Burullus 4×1.2 GW, New Capital
 *                    4×1.2 GW — all 2018 Siemens "world record" CCGT trio,
 *                    6 October 919 MW, Banha 750 MW, Nubaria, El-Kureimat,
 *                    Dairut, Sidi Krir, Damietta, Suez Bay, etc.)
 *       solar:   71 (Benban Solar Park — Africa's largest, ~1.8 GW PV)
 *       wind:    14 (Gabal El-Zeit — Africa's largest wind farm, 580 MW,
 *                    Zafarana, Gulf El-Zeit, Ras Ghareb)
 *       hydro:    6 (**Aswan High Dam 2,100 MW** — iconic, Old Aswan Dam,
 *                    High Dam Power Station, Low Dam, Isna barrage)
 *
 * Refineries (MIDOR/ANRPC/ASORC) — Alexandria El Mex, Amriya, ASORC Asyut,
 * Suez Oil Processing, Mostorod Cairo — rely on OSM `landuse=industrial`
 * (no NACE classification).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-eg.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const EG_BBOX: readonly [number, number, number, number] = [22.0, 24.7, 31.7, 36.9]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [22.0, 24.7, 31.7, 25.0],
  [22.0, 24.7, 22.1, 36.9],
  [29.5, 34.25, 31.7, 34.9],
  [22.0, 34.95, 29.3, 36.9],
  [29.5, 34.95, 30.3, 35.2],
]

await enrichGemIndustrial({
  countryCode: 'eg',
  countryName: "Egypt",
  bbox: EG_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, EG_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
