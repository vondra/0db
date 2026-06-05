/**
 * Enrich TL industrial with GEM Global Integrated Power (Timor-Leste filter).
 *
 * Timor-Leste's EDTL (Electricidade de Timor-Leste) publishes no open plant
 * data. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Timor-Leste'):
 *     2 operating plants, ~255 MW total
 *
 *   Notable operating plants:
 *     **Hera Power Station 130 MW**  (diesel/HFO — east of Dili, main grid)
 *     **Betano Power Station 125 MW** (diesel/HFO — south coast, Bayu-Undan support)
 *
 * Non-power industrial (OSM only):
 *   - **Oil & gas** — Bayu-Undan offshore gas condensate field (now depleted);
 *     Greater Sunrise development (joint development zone with Australia) is the
 *     country's main future revenue; Timor Sea Treaty with Australia 2018
 *   - **Coffee** — Timor-Leste's largest export commodity by volume; mainly
 *     Ermera district (Café Timor cooperative, ~20k farming families); organic
 *     arabica from highland shade farms; fair-trade certified
 *   - **Marble/stone** — Baucau district; artisanal quarrying
 *   - **Salt** — traditional salt pans along the north coast (Manatuto, Liquiçá)
 *   - **Fishing** — artisanal; Dili fish market; tuna in Timor Sea; no industrial
 *     processing scale
 *   - **Handicrafts** — tais (traditional woven textiles), bamboo products;
 *     cottage industry; UNESCO heritage recognition sought
 *
 * TL_BBOX: [minLat=-9.5, minLon=124.0, maxLat=-8.1, maxLon=127.4]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-tl.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const TL_BBOX: readonly [number, number, number, number] = [-9.5, 124.0, -8.1, 127.4]

await enrichGemIndustrial({
  countryCode: 'tl',
  countryName: "Timor-Leste",
  bbox: TL_BBOX,
})
