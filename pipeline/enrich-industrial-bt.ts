/**
 * Enrich BT industrial with GEM Global Integrated Power (Bhutan filter).
 *
 * Bhutan's Druk Green Power Corporation (DGPC) publishes limited corporate
 * data only. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Bhutan'):
 *     6 operating plants, ~2,326 MW total
 *
 *   Notable operating plants:
 *     **Tala hydro 1,020 MW**       (hydro — Wangchu River, Chukha district; largest in BT)
 *     **Chhukha hydro 336 MW**      (hydro — Wangchu River; first major plant 1988)
 *     **Kurichu hydro 60 MW**       (hydro — Kuri Chhu River, Mongar; Indian-aided)
 *     **Basochhu hydro 24 MW**      (hydro — Basochhu River, Wangdue Phodrang)
 *     **Dorjibi hydro 1.5 MW**      (hydro — small run-of-river)
 *     **Basochu Lower hydro 64 MW** (hydro — Wangdue Phodrang)
 *
 * Non-power industrial (OSM only):
 *   - **Ferroalloy** — Bhutan Ferro Alloys Ltd (BFAL) in Penden, Chhukha;
 *     silicon manganese alloy production; cheap hydropower advantage
 *   - **Cement** — Penden Cement Authority (Penden, Chhukha); domestic supply
 *     plus export to India and Bangladesh
 *   - **Calcium carbide** — Bhutan Carbide & Chemicals (Penden); industrial
 *     chemical, exports to India
 *   - **Wood products** — small sawmills; Bhutan restricts logging (75%+ forest cover)
 *   - **Food processing** — dairy (Bhutan Dairy, Thimphu), distilleries
 *     (Peach Brandy, Bhutan Fruit Products, Apple Wine in Paro/Haa)
 *   - **Handicrafts** — Thimphu; thangka painting, weaving, wood carving;
 *     cottage industries under GNH policy
 *
 * BT_BBOX: [minLat=26.7, minLon=88.7, maxLat=28.4, maxLon=92.1]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-bt.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BT_BBOX: readonly [number, number, number, number] = [26.7, 88.7, 28.4, 92.1]

await enrichGemIndustrial({
  countryCode: 'bt',
  countryName: "Bhutan",
  bbox: BT_BBOX,
})
