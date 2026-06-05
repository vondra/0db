/**
 * Enrich MG industrial with GEM Global Integrated Power (Madagascar filter).
 *
 * All Malagasy gov portals (ARM, JIRAMA, Ministère de l'Énergie, Ministry
 * of Transport) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Madagascar'):
 *     20 total, 11 operating, ~456 MW
 *     Operating fuel: solar 4, coal 3 (Ambatovy captive), oil/gas 2, hydro 2
 *
 *   **Madagascar is an island** — no neighbor-country exclude zones needed.
 *
 *   Top operating plants:
 *     **Ambohimanambola (Trigu) 105 MW + (Aksaf) 66 MW** (oil/gas, near
 *                                                          Antananarivo —
 *                                                          capital's main
 *                                                          thermal cluster)
 *     **Andekaleka 91 MW** (hydropower — Mangoro River, largest MG hydro)
 *     **Ambatovy Nickel 120 MW** (3×40 coal captive — dedicated to the
 *                                  Ambatovy nickel/cobalt laterite mine
 *                                  and processing plant, Sumitomo/KORAM.
 *                                  **One of world's largest nickel laterite
 *                                  mines**, $8B investment.)
 *     **Mandraka 24 MW** (hydropower — Mandraka Falls, Tana-Tamatave road)
 *     **Ambatolampy Solar 40 MW** (2×20 MW, largest MG solar)
 *     **Ehoala Solar 8 MW** (Fort Dauphin, near QMM ilmenite mine)
 *
 * Non-power industrial (OSM only):
 *   - **Ambatovy** (Moramanga) — **one of the world's largest nickel
 *     laterite mines** ($8B investment, Sumitomo/KORAM). Produces nickel,
 *     cobalt, ammonium sulphate. Connected to Toamasina by 220 km slurry
 *     pipeline.
 *   - **QMM / Fort Dauphin ilmenite** (Rio Tinto) — heavy mineral sands
 *     (ilmenite for titanium dioxide), Anosy region SE Madagascar
 *   - **Kraoma chromite** (Brieville/Antsirabe) — Madagascar is world's #3
 *     chromite producer
 *   - **Graphite**: Tirupati Graphite (Vatomina), NextSource (Molo) — rapidly
 *     expanding sector
 *   - **Vanilla**: SAVA region (Antalaha, Sambava) — **Madagascar produces
 *     ~80% of world's vanilla** (world's most expensive spice by weight)
 *   - **Cloves**: East coast — Madagascar is world's #2 clove producer
 *   - **Cement**: Holcim Madagascar (Ibity/Antsirabe)
 *   - **GALANA refinery** (Toamasina) — small, fuel distribution
 *   - **Fishing**: shrimp + tuna (Mahajanga, Toamasina)
 *   - **Toamasina (Tamatave) port** — Madagascar's main port
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-mg.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const MG_BBOX: readonly [number, number, number, number] = [-25.6, 43.2, -11.9, 50.5]

await enrichGemIndustrial({
  countryCode: 'mg',
  countryName: "Madagascar",
  bbox: MG_BBOX,
})
