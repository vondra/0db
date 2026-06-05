/**
 * Enrich CG industrial with GEM Global Integrated Power (Republic of Congo filter).
 *
 * All Republic of Congo government portals (SNE, Ministère de l'Énergie) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Republic of the Congo'):
 *     7 operating plants, ~730 MW total
 *     Operating fuel: gas, hydro, solar
 *
 *   Top operating plants:
 *     **CEC Pointe-Noire gas complex** — 3 units, ~484 MW total
 *       (170 MW + 157 MW + 157 MW gas turbines, Pointe-Noire coast)
 *     **CNGCC Pointe-Noire 50 MW** (gas combined-cycle — Pointe-Noire IPP)
 *     **Imboulou 120 MW** (hydro — Lefini River, ~200 km north of Brazzaville)
 *     **Moukoukoulou 74 MW** (hydro — Bouenza River, oldest large plant)
 *     **Kabo Solar 2 MW** (solar — Kabo, Cuvette-Ouest, north CG)
 *
 * Non-power industrial (OSM only):
 *   - **Oil**: Republic of Congo is a significant oil producer — TotalEnergies,
 *       ENI Congo; offshore fields near Pointe-Noire dominate GDP/exports
 *   - **Logging/timber**: tropical forest (northern CG is dense equatorial
 *       rainforest; Sangha Trinational is a UNESCO World Heritage site)
 *   - **Sugar**: SARIS (Nkayi) — Congo's only sugar refinery
 *   - **Potash**: MagMinerals (Sintoukola project) — abandoned after 2016
 *       flooding, never produced
 *   - **Cement**: Forspak (Loutété)
 *   - **Governance**: Sassou-Nguesso — longest-ruling African leader (president
 *       since 1979/1997); resource revenues concentrated, little diversification
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-cg.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const CG_BBOX: readonly [number, number, number, number] = [-5.1, 11.2, 3.8, 18.7]

await enrichGemIndustrial({
  countryCode: 'cg',
  countryName: "Republic of the Congo",
  bbox: CG_BBOX,
})
