/**
 * Enrich TT industrial with GEM Global Integrated Power (Trinidad and Tobago filter).
 *
 * T&T has the Caribbean's most energy-intensive industrial sector.
 * The state-owned Trinidad and Tobago Electricity Commission (T&TEC) distributes
 * power generated almost entirely from natural gas (T&T is a major LNG exporter).
 * GEM is the primary open source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Trinidad and Tobago'):
 *     ~17 operating plants, ~2,057 MW total
 *
 *   Top operating plants:
 *     **Point Lisas Power** (gas — 720 MW, Point Lisas industrial complex; 10.41°N, 61.48°W)
 *     **Trinity Power** (gas — 294 MW; 10.63°N, 61.52°W)
 *     **Penal/Debe** (gas — 200+ MW)
 *     **Point Fortin** (gas — associated with Atlantic LNG; 10.17°N, 61.70°W)
 *     Small solar installations (<10 MW each, nascent sector).
 *
 * Non-power industrial (OSM only):
 *   - **Atlantic LNG** (Point Fortin) — Caribbean's ONLY LNG export terminal; ~15 Mtpa, one of world's
 *     largest. Trains 1–4 (Shell, BP, BG Group). Major global LNG supplier.
 *   - **Point Lisas Industrial Estate** — Caribbean's largest industrial complex: ammonia (7 plants,
 *     ~5 Mt/year, world's largest export cluster), methanol (4 plants), iron/steel (ArcelorMittal),
 *     urea, direct-reduced iron, plastics. The industrial heartland of the entire Caribbean.
 *   - **Petroleum refining**: Petrotrin Pointe-à-Pierre refinery (privatized post-2018 → Paria Fuel Trading)
 *   - **Asphalt**: Pitch Lake (La Brea) — world's largest natural asphalt lake; industrial export
 *   - **Rum/spirits**: Angostura bitters (Port of Spain) — world's most famous bitters; also rum
 *   - **Food/beverage**: Carib Brewery, Solo drinks
 *
 * TT is an island pair — no neighbor-border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tt.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const TT_BBOX: readonly [number, number, number, number] = [10.0, -61.9, 10.9, -60.5]

await enrichGemIndustrial({
  countryCode: 'tt',
  countryName: "Trinidad and Tobago",
  bbox: TT_BBOX,
})
