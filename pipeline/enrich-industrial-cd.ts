/**
 * Enrich CD industrial with GEM Global Integrated Power (DR Congo filter).
 *
 * All DRC government portals (SNEL, Ministère de l'Énergie et des Ressources
 * Hydrauliques) publish corporate HTML only. GEM is the only machine-readable
 * source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='DR Congo'):
 *     11 operating plants, ~2,753 MW total
 *     Operating fuel: hydro 9, solar 2
 *
 *   Top operating plants:
 *     **Inga II 1,424 MW** (hydro — Congo River, Kongo Central, SNEL flagship)
 *     **Inga I 351 MW** (hydro — Congo River, Kongo Central, severely underperforming)
 *     **N'Seke 260 MW** (hydro — Inkisi River, Kongo Central)
 *     **Busanga 240 MW** (hydro — Lualaba River, Lualaba province, commissioned 2024)
 *     **Zongo II 150 MW** (hydro — Congo River tributary, Kongo Central)
 *     **N'Zilo I 108 MW** (hydro — Lualaba River, Lualaba province)
 *     **Mwadingusha 78 MW** (hydro — Lufira River, Haut-Katanga, Glencore-rehabilitated)
 *     **Zongo I 75 MW** (hydro — Inkisi River, Kongo Central)
 *     **Katende 64 MW** (hydro — Kasaï River, Kasaï-Central)
 *     **2 × small solar** (~2.6 MW total — off-grid rural IPPs)
 *
 * Non-power industrial (OSM only):
 *   - **Cobalt**: DRC produces ~70% of world's cobalt (critical EV battery supply
 *       chain). Major mines: Glencore Mutanda (suspended 2019, restarted 2022),
 *       CMOC Tenke Fungurume (Lualaba), Kamoa-Kakula (Ivanhoe/Zijin — world's
 *       fastest-growing copper mine), ERG BOSS Mining (Kolwezi area)
 *   - **Copper**: Katanga/Haut-Katanga — major global producer; Kolwezi,
 *       Likasi, Lubumbashi smelters and concentrators
 *   - **Gold**: Kibali mine (Barrick/AngloGold, one of Africa's largest,
 *       Haut-Uele province, ~800 koz/yr); eastern DRC artisanal gold
 *   - **Tin**: Bisie mine (Alphamin, world's highest-grade tin deposit,
 *       Walikale, North Kivu)
 *   - **Coltan/Tantalum**: eastern DRC (Kivu provinces — 3TG conflict minerals)
 *   - **Diamonds**: Kasaï region (MIBA — Société Minière de Bakwanga,
 *       Mbuji-Mayi); Tshikapa artisanal alluvial
 *   - **Cement**: PPC Barnet DRC (Lukala, Kongo Central),
 *       CILU (Kimpese, Kongo Central)
 *   - **SNEL** (Société Nationale d'Électricité) — state utility operating
 *       all major hydro plants; chronic underfunding, ~30% generation capacity
 *       factor vs nameplate at Inga I/II
 *   - **Grand Inga potential**: Congo River at Inga has world's largest
 *       undeveloped hydro potential (~40,000 MW). Grand Inga 3 repeatedly
 *       delayed; currently at ~1% of theoretical potential
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-cd.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const CD_BBOX: readonly [number, number, number, number] = [-13.5, 12.0, 5.5, 31.5]

await enrichGemIndustrial({
  countryCode: 'cd',
  countryName: "DR Congo",
  bbox: CD_BBOX,
})
