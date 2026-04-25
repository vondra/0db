/**
 * Enrich NP industrial with GEM Global Integrated Power (Nepal filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Nepal'):
 *     366 total / 85 operating / ~2.66 GW
 *     Operating fuel: 100% RENEWABLE — 64 hydropower + 21 solar,
 *     ZERO fossil fuel in GEM. Nepal is one of only a handful of countries
 *     with a completely renewable operating fleet.
 *     ~83 GW theoretical hydro potential but only ~2.66 GW installed =
 *     massive underexploitation of one of the world's best hydro resources.
 *
 *   Top operating plants:
 *     **Upper Tamakoshi 456 MW** (2022, Dolakha — Nepal's largest, on
 *                                 Tamakoshi River, EPC by China Gezhouba)
 *     **Kali Gandaki A 144 MW** (Mustang/Syangja border — 2002,
 *                                 Nepal's first major hydro, ADB-financed)
 *     **Madhya Marsyangdi 70 MW** (Lamjung district, run-of-river)
 *     **Khimti 60 MW** (Dolakha, private, Statkraft/Himal Power)
 *     **Kulekhani 60 MW** (Makwanpur — Nepal's only reservoir-based
 *                          storage hydro, critical for dry season)
 *
 * Non-power industrial (OSM only):
 *   - **Cement**: Hongshi-Shivam Cement (Nawalparasi — Chinese JV,
 *     largest, ~2.1 MT/yr), Hetauda Cement (Hetauda Industrial District),
 *     Udayapur Cement (Udayapur, east)
 *   - **Steel**: Himal Iron & Steel (Bara district, Terai industrial corridor)
 *   - **Textiles**: carpet/pashmina weaving (Kathmandu Valley — major
 *     export, UNESCO-recognized Tibetan carpet industry)
 *   - No oil/gas/mining of significance — Nepal imports all petroleum
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-np.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const NP_BBOX: readonly [number, number, number, number] = [26.3, 80.0, 30.5, 88.2]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [26.3, 80.0, 26.7, 88.2],
  [29.5, 80.0, 30.5, 84.0],
  [28.5, 84.0, 30.5, 88.2],
]

await enrichGemIndustrial({
  countryCode: 'np',
  countryName: "Nepal",
  bbox: NP_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, NP_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
