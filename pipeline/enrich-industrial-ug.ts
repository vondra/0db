/**
 * Enrich UG industrial with GEM Global Integrated Power (Uganda filter).
 *
 * All Ugandan gov portals (UNRA, URC, UEGCL, UETCL, Ministry of Energy and
 * Mineral Development, PAU) publish corporate HTML only. GEM is the only
 * machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Uganda'):
 *     49 total, 19 operating, ~1.75 GW
 *     Operating fuel breakdown: solar 10, hydropower 5, oil/gas 3, bioenergy 1
 *
 *   **Uganda is almost entirely hydro-powered** from the White Nile cascade
 *   between Lake Victoria and Karuma. **Nile hydro = ~1,413 MW = 81% of capacity.**
 *
 *   Top operating plants:
 *     **Karuma 600 MW** (Nile River, opened 2024 — Uganda's largest, built
 *                         by Sinohydro with Chinese financing, delayed from
 *                         original 2018 plan due to technical disputes)
 *     **Bujagali 250 MW** (Nile, 2012 — Bujagali Falls below Jinja, private
 *                           IPP built by SG Bujagali Holdings)
 *     **Kiira 200 MW** (Nile at Owen Falls Dam extension, 2000 — twin to
 *                        Nalubaale sharing the same dam)
 *     **Isimba 183 MW** (Nile, 2019)
 *     **Nalubaale (formerly Owen Falls) 180 MW** (Nile at Jinja, 1954 —
 *                                                  **Uganda's oldest major hydro**,
 *                                                  at the source of the White Nile)
 *     **Tororo 89 MW** (oil/gas, east — emergency thermal, Aggreko-era plant)
 *     **Mutundwe 50 MW + Namanve 50 MW** (oil/gas, Kampala area)
 *     **Kakira Sugar 30 MW** (bioenergy — sugarcane bagasse cogeneration,
 *                              Madhvani Group's Kakira sugar estate)
 *     **Kabulasoke, Nkonge, Tororo II, Rakai, Bufulubi, Soroti, Tororo I
 *      Solar** — 10 small solar plants (4-24 MW each)
 *
 * Non-power industrial (OSM only):
 *   - **Lake Albert oil fields** — **Tilenga** (TotalEnergies operated, Area 1
 *     + Area 2) + **Kingfisher** (CNOOC operated). ~6.5 Bbbl resources.
 *     **First oil production target ~2025/2026**.
 *   - **EACOP (East African Crude Oil Pipeline)** — 1,443 km, Hoima ↔ Tanga
 *     (Tanzania), **under construction 2023-2026**. **World's longest
 *     heated crude oil pipeline**. Highly controversial due to climate +
 *     environmental + community displacement concerns.
 *   - **Uganda Refinery Hoima** — planned 60k bpd, not yet built
 *   - **Roofings Group** (Kampala, Namanve industrial park) — **East Africa's
 *     largest steel manufacturer**, integrated steel mill + galvanizing
 *   - **Cement**: **Hima Cement** (Holcim → Bamburi, near Kasese),
 *     **Tororo Cement** (Tororo), **Simba Cement** (Tororo)
 *   - **Sugar**: Kakira (Madhvani), Kinyara, SCOUL (Lugazi)
 *   - **Tea**: major plantations in Fort Portal/Kyenjojo area
 *   - **Coffee**: **Uganda is Africa's #2 coffee producer** after Ethiopia
 *     (~5 Mbags/year)
 *   - **Copper + Cobalt**: **Kilembe mine** (Kasese) — historically major,
 *     rehabilitation under discussion since 2013
 *   - **Fishing**: Lake Victoria Nile perch industry
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ug.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const UG_BBOX: readonly [number, number, number, number] = [-1.5, 29.5, 4.3, 35.05]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4.0, 29.5, 4.3, 35.05],
  [-1.5, 34.8, 4.3, 35.05],
  [-1.5, 29.5, -1.0, 35.05],
  [-1.5, 29.5, -1.0, 30.9],
  [0.0, 29.5, 3.8, 29.8],
  [-1.5, 29.5, 0.0, 29.9],
]

await enrichGemIndustrial({
  countryCode: 'ug',
  countryName: "Uganda",
  bbox: UG_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, UG_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
