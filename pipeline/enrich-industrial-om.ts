/**
 * Enrich OM industrial with GEM Global Integrated Power (Oman filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Oman'):
 *     123 total / 52 operating / ~15.5 GW
 *     Operating fuel: oil/gas 43 (gas-dominant), solar 8, wind 1
 *
 *   Top operating plants:
 *     **Sohar III 1,740 MW** (2×870 MW CCGT, Sohar industrial port)
 *     **Ibri IPP 1,539 MW** (largest single IPP, Al Dhahirah)
 *     **Sur 1,600 MW** (2×800 MW CCGT, Sur industrial area)
 *     **Barka III + Sohar II + Barka II + Barka I + Sohar** —
 *                         massive coastal CCGT corridor (Al Batinah coast)
 *     **Al Mazyunah solar ~430 MW** + **Ibri 2 solar ~500 MW** +
 *     **Manah solar ~628 MW** — ~1,558 MW solar portfolio
 *     **Dhofar Wind 50 MW** — Oman's first utility-scale wind farm (Dhofar)
 *     **Sohar Aluminium 1,000 MW** — captive gas turbine plant
 *
 * Non-power industrial (OSM only):
 *   - **Oman LNG** (Qalhat, near Sur) — 6.6 Mtpa LNG export terminal
 *   - **Sohar Industrial Port** — mega-port complex: Oman Refinery Company
 *     (ORPIC, 198k bpd), petrochemicals (Oman Polymers/Aromatics),
 *     OHPC (HDPE/LLDPE), Sohar Aluminium 390 ktpa, steel, fertilizers
 *   - **Mina al-Fahal refinery** (Muscat, Qurum) — 106k bpd, operated by OQ
 *   - **PDO** (Petroleum Development Oman — Shell/Total/Partex partnership)
 *     — main oil/gas operator, fields across interior (Fahud, Yibal, Nimr)
 *   - **Duqm** — new $10B industrial port city (Special Economic Zone):
 *     Duqm Refinery 230k bpd (OQ + Kuwait Petroleum), petrochemicals, shipyard
 *   - **Raysut Cement** (Salalah, Dhofar) — largest cement producer in Oman
 *   - **Port of Salalah** — major transshipment hub (container + LPG)
 *
 * NOTE: NO RAILWAY. Oman Rail 2,135 km was planned but never built.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-om.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const OM_BBOX: readonly [number, number, number, number] = [16.6, 51.9, 26.4, 59.9]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [24.7, 51.9, 26.4, 56.1],
  [16.6, 51.9, 18.0, 54.5],
  [16.6, 52.5, 16.8, 59.9],
  [18.5, 51.9, 23.0, 55.0],
]

await enrichGemIndustrial({
  countryCode: 'om',
  countryName: "Oman",
  bbox: OM_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, OM_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
