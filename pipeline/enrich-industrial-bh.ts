/**
 * Enrich BH industrial with GEM Global Integrated Power (Bahrain filter).
 *
 * HIGHEST power density per km² of ANY enriched country: 11.1 MW/km²
 * (778 km² total land area, ~8.6 GW installed capacity).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Bahrain'):
 *     33 total / 25 operating / ~8.6 GW
 *     Fuel: oil/gas 24, solar 1
 *
 *   **Bahrain is an island archipelago** — no neighbor-country exclude
 *   zones needed. The King Fahd Causeway connects to Saudi Arabia but it
 *   is a 25 km sea bridge, not a land border.
 *
 *   Top operating plants:
 *     **ALBA (Aluminium Bahrain) captive 2,848 MW** (5 units — dedicated
 *                                                      to the 1.56 Mtpa
 *                                                      aluminium smelter,
 *                                                      one of world's
 *                                                      largest single-site)
 *     **Al-Dur IWPP 2,726 MW** (independent water+power project,
 *                                Marafiq — combined desal+power)
 *     **Al Hidd IWPP 987 MW** (north Muharraq, desal+power)
 *     **Al Ezzel 942 MW** (Sitrah/Sitra island, merchant IPP)
 *
 * Non-power industrial (OSM only):
 *   - **ALBA (Aluminium Bahrain)** — 1.56 Mtpa capacity, 5th largest
 *     single-site aluminium smelter globally, Askar (south Bahrain)
 *   - **BAPCO refinery** (Sitra, 267k bpd) — Bahrain's oldest industry
 *     since 1932; first oil refinery in the Gulf region
 *   - **Bahrain Petroleum Field** (Jebel Dukhan) — Gulf's first oil
 *     discovery 1932; still producing (mature onshore field)
 *   - **GPIC** (Gulf Petrochemical Industries, Sitra) — methanol,
 *     ammonia, urea; JV Bahrain/Saudi/Kuwait
 *   - **King Fahd Causeway** (25 km to Saudi Arabia, ~65,000 vehicles/day
 *     — major freight + weekend Saudi tourist corridor)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-bh.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BH_BBOX: readonly [number, number, number, number] = [25.75, 50.35, 26.35, 50.85]

await enrichGemIndustrial({
  countryCode: 'bh',
  countryName: "Bahrain",
  bbox: BH_BBOX,
})
