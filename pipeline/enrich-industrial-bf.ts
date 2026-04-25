/**
 * Enrich BF industrial with GEM Global Integrated Power (Burkina Faso filter).
 *
 * All Burkina Faso government portals (SONABEL, Ministère de l'Énergie) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Burkina Faso'):
 *     11 operating plants, ~380 MW total
 *     Operating fuel: solar 8, oil/gas (HFO/diesel) 3
 *
 *   Top operating plants:
 *     **Essakane Gold Mine 57 MW** (HFO — captive power, IAMGOLD gold mine)
 *     **Kossodo 54.9 MW** (diesel — Ouagadougou, SONABEL main thermal plant)
 *     **Komsilga 54 MW** (HFO/diesel — Ouagadougou suburb, SONABEL thermal)
 *     **Kodeni Solar 38 MW** (solar — Bobo-Dioulasso IPP)
 *     **Zagtouli Solar 37+13 MW** (solar — Ouagadougou, SONABEL utility-scale)
 *     **Nagréongo Solar 30 MW** (solar — north of Ouagadougou)
 *     **Pâ Solar 30 MW** (solar — south-west Burkina Faso IPP)
 *     **Zina Solar 26.6 MW** (solar — Manga, south-central)
 *     **Zano Solar 24 MW** (solar — IPP)
 *     **Essakane Solar 14.9 MW** (solar — Essakane, IAMGOLD mine captive hybrid)
 *
 * Non-power industrial (OSM only):
 *   - **Gold mining** — Burkina Faso is Africa's #4-5 gold producer:
 *       Essakane (IAMGOLD — largest), Houndé (Endeavour Mining),
 *       Inata, Kiéré, Bissa (Nordgold), Wahgnion (Lilium Mining)
 *   - **SOFITEX cotton** — one of West Africa's largest cotton producers;
 *     gins at Bobo-Dioulasso, Houndé, Diébougou
 *   - **Tambao manganese** — large deposit, undeveloped due to lack of rail
 *   - **Cement**: CIMFASO (Ouagadougou), Diamond Cement, CIM Metal Group
 *   - **Very low industrialization** — economy is agriculture + gold + remittances;
 *     most consumer goods imported
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bf.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BF_BBOX: readonly [number, number, number, number] = [9.4, -5.6, 15.1, 2.5]

await enrichGemIndustrial({
  countryCode: 'bf',
  countryName: "Burkina Faso",
  bbox: BF_BBOX,
})
