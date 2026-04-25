/**
 * Enrich SS industrial with GEM Global Integrated Power (South Sudan filter).
 *
 * South Sudan's government publishes no open GIS or power plant data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='South Sudan'):
 *     5 operating plants, ~137 MW total
 *
 *   Notable operating plants:
 *     **Juba Power Station ~90 MW**   (diesel/HFO — main plant, Juba; severe reliability issues)
 *     **Jonglei Hydropower**          (hydro — planned but not operational)
 *     Small diesel gensets in state capitals (Wau, Malakal, Bor)
 *
 * Non-power industrial (OSM only):
 *   - **Oil extraction** — Unity State (Unity/Adar fields, CNPC/Petrodar consortium),
 *     Upper Nile (Melut Basin, CNPC), Jonglei (Block B, Total, suspended since 2013);
 *     oil accounts for ~90% of government revenue
 *   - **Oil pipeline** — GNOP/CNPC pipeline to Sudan's Port Sudan; cross-border oil
 *     transit through Sudan after 2011 independence (controversial transit fees)
 *   - **Timber** — Equatoria forests (largely unregulated logging, foreign-operated)
 *   - **Juba** — small informal manufacturing, food processing; very limited formal industry
 *   - **Construction sector** — Juba has seen construction boom (Chinese contractors)
 *     despite civil war
 *
 * World's newest country (independence July 9, 2011 from Sudan).
 * Civil war 2013-2020 (Kiir vs Machar factions); peace agreement but fragile.
 * Worst infrastructure in the world (World Bank rankings).
 *
 * SS_BBOX: [minLat=3.5, minLon=24.0, maxLat=12.2, maxLon=36.0]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ss.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SS_BBOX: readonly [number, number, number, number] = [3.5, 24.0, 12.2, 36.0]

await enrichGemIndustrial({
  countryCode: 'ss',
  countryName: "South Sudan",
  bbox: SS_BBOX,
})
