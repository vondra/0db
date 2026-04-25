/**
 * Enrich LK industrial with GEM Global Integrated Power (Sri Lanka filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Sri Lanka'):
 *     136 total / 40 operating / ~3.72 GW
 *
 *   **Sri Lanka is an island** — no neighbor-country exclude zones needed.
 *
 *   Operating plants by fuel type:
 *     **Hydro 13** — Mahaweli cascade (largest river system):
 *       Victoria 210 MW, Kotmale 201 MW, Upper Kotmale 150 MW,
 *       Randenigala 122 MW, Samanalawewa 120 MW, Uma Oya 120 MW
 *     **Wind 13** — Mannar 100 MW (Gulf of Mannar, NW coast, strongest winds)
 *     **Oil/gas 8** — Yugadanavi 300 MW (Kerawalapitiya, LNG conversion),
 *       Kerawalapitiya 220 MW (combined cycle), Kelanitissa 328 MW (thermal)
 *     **Coal 3** — Lakvijaya/Norochcholai 900 MW = 3×300 MW (Puttalam, NW
 *       coast). **Sri Lanka's ONLY coal plant** — Chinese-built (CMEC),
 *       commissioned 2011-2014, controversial for pollution + Chinese debt.
 *     **Solar 3** — utility-scale, rapidly growing
 *
 * Non-power industrial (OSM only):
 *   - **Sapugaskanda refinery** (Kelaniya, near Colombo) — Sri Lanka's only
 *     petroleum refinery, ~50,000 bpd, operated by CPC (Ceylon Petroleum)
 *   - **Lanka Cement** (Puttalam) — main domestic cement producer
 *   - **Holcim Lanka** (Galle road) — international cement
 *   - **Tea processing** — Ceylon tea ~300,000 ton/year, **world's #4 producer**
 *     (Nuwara Eliya, Kandy, Badulla districts — Hill Country). Tea factories
 *     (tea estates + factory = combined unit) throughout Hill Country.
 *   - **Garments / apparel** — Free Trade Zones: Katunayake (near airport),
 *     Biyagama (Kelaniya), Koggala (Galle). Sri Lanka's #1 export earner.
 *   - **Colombo Port** — transshipment hub for South Asia, one of top-30
 *     busiest container ports globally. Colombo International Container
 *     Terminal (CICT, China Merchants) + Jaya Container Terminal.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-lk.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const LK_BBOX: readonly [number, number, number, number] = [5.9, 79.5, 9.9, 81.9]

await enrichGemIndustrial({
  countryCode: 'lk',
  countryName: "Sri Lanka",
  bbox: LK_BBOX,
})
