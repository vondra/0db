/**
 * Enrich KP industrial with GEM Global Integrated Power (North Korea filter).
 *
 * North Korea publishes no open energy data. GEM is the only machine-readable
 * source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='North Korea'):
 *     62 operating plants, ~6,482 MW total
 *
 *   Notable operating plants:
 *     **Supung hydro 800 MW**           (hydro — Yalu River, shared with China; largest in KP)
 *     **Bukchang thermal 1,600 MW**     (coal — South Pyongan, major Soviet-era plant)
 *     **Pyongyang thermal 500 MW**      (coal — capital district supply)
 *     **Sunchon thermal 400 MW**        (coal — South Pyongan, near Bukchang)
 *     **Huichon hydro cascade 300 MW**  (hydro — Chongchon River, Kim Jong-un priority)
 *     **Thaechon hydro 188 MW**         (hydro — Pyongbuk, Chinese-aided)
 *     **Wonsan thermal 200 MW**         (coal — east coast)
 *     **Ungi thermal 200 MW**           (coal — Rason SEZ, NE corner)
 *     **Chongjin steelworks CHP**       (coal CHP — Kim Chaek Iron & Steel, NE industrial hub)
 *     **Nampo smelter CHP**             (coal CHP — West Sea Barrage port)
 *
 * Non-power industrial (OSM only):
 *   - **Steel** — Kim Chaek Iron & Steel (Chongjin), Hwanghae Iron & Steel (Songnim);
 *     historically significant but severely underutilized due to sanctions
 *   - **Mining** — coal (Sunchon, Anju, Tokchon basins), magnesite (world's
 *     largest reserves at Tanchon), zinc/lead (Komdok Mine, largest in Asia),
 *     gold, iron ore; mineral exports primary hard-currency earner
 *   - **Chemical** — Hungnam Chemical Complex (fertilizers, explosives), Namhung
 *     Youth Chemical Plant; Soviet-era complex
 *   - **Cement** — Sungan Cement, Pyongyang Cement; major construction focus
 *     under Kim Jong-un "construction revolution"
 *   - **Military-industrial** — munitions factories throughout; not in OSM
 *   - **Textiles** — Pyongyang textile mills, Korean silk; domestic consumption
 *   - **Seafood processing** — Wonsan, Chongjin; fish/seafood export to China
 *
 * KP_BBOX: [minLat=37.6, minLon=124.2, maxLat=43.0, maxLon=130.7]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-kp.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const KP_BBOX: readonly [number, number, number, number] = [37.6, 124.2, 43.0, 130.7]

await enrichGemIndustrial({
  countryCode: 'kp',
  countryName: "North Korea",
  bbox: KP_BBOX,
})
