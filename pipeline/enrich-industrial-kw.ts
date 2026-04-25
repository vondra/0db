/**
 * Enrich KW industrial with GEM Global Integrated Power (Kuwait filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Kuwait'):
 *     80 total / 60 operating / ~19.6 GW — 100% fossil fuel dominated
 *     (56 oil/gas, 3 solar, 1 wind).
 *     Az-Zour South ~4,645 MW (7 units — massive), Sabiya ~3,647 MW
 *     (5 units), Az-Zour North 1,632 MW. One of world's highest per-capita
 *     electricity consumption (extreme AC demand 50°C+ summers, ~99%
 *     from gas/oil).
 *
 * Non-power industrial (OSM only):
 *   - **Burgan oil field** (world's 2nd largest after Ghawar Saudi Arabia;
 *     ~70 billion barrels recoverable, produced since 1946)
 *   - **KNPC refineries**: Mina Al-Ahmadi 460k bpd + Mina Abdullah 270k bpd
 *     + Al-Zour New Refinery 615k bpd — one of world's newest mega-refineries
 *     (2022), total ~1,345k bpd refining capacity
 *   - **KPC** (Kuwait Petroleum Corporation) — state oil company, upstream +
 *     downstream
 *   - **EQUATE** petrochemical complex (Al Ahmadi) — ethylene, polyethylene,
 *     ethylene glycol; joint venture with Dow Chemical
 *   - **PIC** (Petrochemical Industries Company) — fertilizers (ammonia,
 *     urea) at Shuaiba Industrial Area
 *   - **Shuaiba Industrial Area** — large coastal industrial zone south of
 *     Kuwait City: petrochemical, desalination, power
 *   - **Mina Al-Ahmadi** — Kuwait's main export terminal + refinery city
 *   - NO RAILWAY — GCC Railway/Kuwait Metro planned but never built
 *   - Kuwait is essentially a city-state; virtually all population and
 *     industry concentrated in Kuwait City metropolitan area
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-kw.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const KW_BBOX: readonly [number, number, number, number] = [28.5, 46.5, 30.1, 48.5]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [30.0, 46.5, 30.1, 47.8],
  [28.5, 46.5, 28.7, 48.5],
]

await enrichGemIndustrial({
  countryCode: 'kw',
  countryName: "Kuwait",
  bbox: KW_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, KW_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
