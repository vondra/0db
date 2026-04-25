/**
 * Enrich ZW industrial with GEM Global Integrated Power (Zimbabwe filter).
 *
 * All Zimbabwean gov portals (ZINARA, NRZ, ZESA, ZPC, ZETDC, Ministry of
 * Energy and Power Development) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Zimbabwe')
 *   - Plus supplementary Kariba Dam entry (GEM lists the dam under Zambia
 *     but the 1,050 MW Kariba South Power Station is Zimbabwean).
 *
 *   Operating fleet: 34 plants, ~2.96 GW
 *   Fuel breakdown: solar 21, coal 10, bioenergy 2, hydropower 1
 *
 *   Top operating plants:
 *     **Kariba South 1,050 MW** (Zambezi River at Kariba Dam — Zimbabwe's
 *                                 largest, shared with Zambia/Kariba North
 *                                 on the opposite bank. Kariba was the
 *                                 world's largest dam when built 1959.
 *                                 Combined Kariba Dam capacity = 2,130 MW.
 *                                 Supply severely constrained by drought
 *                                 2022-2024.)
 *     **Hwange Thermal 1,590 MW total** (6 units ×335+×220+×120 MW coal,
 *                                         Hwange coalfield, **Zimbabwe's
 *                                         main coal plant**, Sinohydro
 *                                         extension Units 7+8 added 600 MW 2023)
 *     **Harare 30 MW** (coal, small)
 *     **Munyati + Bulawayo thermal** (coal, small)
 *     **ZhongXin 50 MW** (coal IPP, Hwange)
 *     **Hippo Valley Estate 39 MW + Triangle 35 MW** (bioenergy — sugarcane
 *                                                      bagasse cogeneration,
 *                                                      Lowveld sugar plantations)
 *     **Vungu, Nyabira, Blanket Mine, Masvingo, Guruve Solar** (small solar
 *                                                                 plants, 5-30 MW)
 *
 * Non-power industrial (OSM only):
 *   - **Zimplats (Zimbabwe Platinum Mines)** — Ngezi/Selous, world-class
 *     platinum reserves on the Great Dyke. **World's #3 platinum reserves
 *     area** (after Bushveld RSA and Great Dyke). Implats subsidiary.
 *   - **Unki Mine** (Shurugwi) — Anglo American Platinum
 *   - **Mimosa Mine** (Zvishavane) — Sibanye-Stillwater + Implats JV
 *   - **Bikita Minerals** — **world's oldest and largest lithium mine**
 *     (operating since 1953, being expanded by Sinomine post-2022 lithium
 *     boom)
 *   - **Arcadia Lithium** (Goromonzi, near Harare) — Prospect Resources →
 *     Huayou Cobalt (Chinese, 2022 acquisition)
 *   - **Zulu Lithium** (Premier African Minerals, near Bulawayo)
 *   - **ZISCO (Zimbabwe Iron and Steel Company)** — Redcliff, Kwekwe.
 *     Historically Africa's largest integrated steel mill, **defunct since
 *     ~2008** economic collapse. Under discussion for revival.
 *   - **Hwange Colliery** — Zimbabwe's only major coal mine
 *   - **Gold mines**: numerous, including Freda Rebecca (Bindura), Blanket
 *     (Gwanda), How Mine (Bulawayo), Mazowe, Bulawayo mines
 *   - **Marange Diamonds** (controversial, MMCZ/ZCDC)
 *   - **Chisumbanje Bio-ethanol** (Green Fuel, sugarcane-based)
 *   - **Tobacco processing**: Kutsaga + numerous Mashonaland tobacco belt
 *   - **Hippo Valley + Triangle sugar estates** (Lowveld)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-zw.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const ZW_BBOX: readonly [number, number, number, number] = [-22.42, 25.2, -15.6, 33.1]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-16.15, 25.2, -15.6, 33.1],
  [-22.42, 32.6, -15.6, 33.1],
  [-22.42, 25.2, -22.1, 32.6],
  [-22.42, 25.2, -20.0, 27.5],
]

await enrichGemIndustrial({
  countryCode: 'zw',
  countryName: "Zimbabwe",
  bbox: ZW_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, ZW_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
