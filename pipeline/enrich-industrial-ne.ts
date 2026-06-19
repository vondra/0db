/**
 * Enrich NE industrial with GEM Global Integrated Power (Niger filter).
 *
 * All Niger government portals (NIGELEC, Ministère de l'Énergie) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Niger'):
 *     8 operating plants, ~262 MW total
 *     Operating fuel: solar 5, oil/gas (diesel/HFO) 2, unknown (cement captive) 1
 *
 *   Top operating plants:
 *     **Gorou Banda 100 MW** (diesel — Niamey, NIGELEC main thermal plant)
 *     **Niamey Issoufou 89 MW** (HFO — Niamey, NIGELEC thermal)
 *     **Badaguichiri Cement 30 MW** (captive — cement plant, unknown fuel)
 *     **Gorou Banda Solar 30 MW** (solar — Niamey suburb IPP)
 *     **Malbaza Solar 6 MW** (solar — Malbaza, near SNC cement plant)
 *     **Kéita Solar 2.5 MW** (solar — Tahoua region)
 *     **Bilma Solar 2.3 MW** (solar — Bilma, deep Sahara oasis)
 *     **Dogondoutchi Solar 2 MW** (solar — Dosso region)
 *
 * Non-power industrial (OSM only):
 *   - **Uranium**: Arlit/Akokan — Niger was world's #4 uranium producer.
 *       COMINAK closed 2021. SOMAIR (Orano/France) still operating.
 *       France-Niger uranium relationship severed after 2023 coup.
 *   - **Oil**: Agadem (CNPC) — Niger's first oil export via pipeline to Benin
 *       (Agadem–Zinder–Kano pipeline, opened 2024)
 *   - **Cement**: SNC Malbaza (Société Nigérienne de Cimenterie), Badaguichiri
 *   - **SONICHAR coal** (Tchirozérine, near Agadez — captive power ~36 MW
 *       for Arlit/Agadez grid; may not appear in GEM)
 *   - **Gold**: artisanal Liptako-Gourma region (SW Niger)
 *   - **Livestock**: Niger is a major Sahelian livestock exporter
 *       (cattle, goats, camels) — largest non-oil export sector
 *   - **Among the world's lowest HDI** — one of the poorest countries on Earth
 *       by Human Development Index; very limited formal industry outside extractives
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ne.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const NE_BBOX: readonly [number, number, number, number] = [11.7, 0.1, 23.5, 16.0]

await enrichGemIndustrial({
  countryCode: 'ne',
  countryName: "Niger",
  bbox: NE_BBOX,
})
