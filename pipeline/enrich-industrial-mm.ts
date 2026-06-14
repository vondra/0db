/**
 * Enrich MM industrial with GEM Global Integrated Power (Myanmar filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Myanmar'):
 *     203 total / 55 operating / ~5.66 GW
 *     Hydro 17 (Yeywa 790 + Shweli 600 + Paung Laung 280+140 + Dapein 240 +
 *              Baluchaung 168), oil/gas 15, solar 19, coal 3, wind 1
 *
 * Non-power industrial (OSM only):
 *   - **Yadana/Yetagun/Shwe offshore gas** — TotalEnergies exited 2022;
 *     MOGE (state oil/gas) and Chinese partners now operate
 *   - **Jade mining Hpakant** (Kachin State) — world's richest jade source,
 *     multi-billion USD informal + formal extraction, high labour risk
 *   - **Monywa copper** — Letpadaung mine (Wanbao/NORINCO, Chinese JV),
 *     controversial due to land acquisition, protests (Daw Suu visited 2012)
 *   - **No.1 Iron & Steel** (Myingyan) — small integrated steel plant
 *   - **Thilawa SEZ** — Japanese-backed special economic zone near Yangon,
 *     light manufacturing, garments, food processing
 *   - **Cement**: Myaing cement (Max Myanmar / Asia Cement)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-mm.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into neighbours along the bbox edges).
const MM_BBOX: readonly [number, number, number, number] = [9.5, 92.0, 28.5, 101.2]

await enrichGemIndustrial({
  countryCode: 'mm',
  countryName: "Myanmar",
  bbox: MM_BBOX,
  isInside: makeCountryGate('MM'),
})
