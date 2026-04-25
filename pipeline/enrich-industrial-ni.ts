/**
 * Enrich NI industrial with GEM Global Integrated Power (Nicaragua filter).
 *
 * MEM (Ministerio de Energía y Minas) and ENEL publish no open machine-readable
 * plant data. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Nicaragua'):
 *     31 operating plants, ~1,033 MW total
 *
 *   Notable operating plants:
 *     **San Jacinto-Tizate geothermal 72 MW** (geothermal — Telica, León; POLARIS JV)
 *     **Momotombo geothermal 87 MW**          (geothermal — Momotombo volcano, Managua lake)
 *     **Centroamérica hydro 50 MW**           (hydro — Río Viejo, Jinotega)
 *     **Carlos Fonseca hydro 50 MW**          (hydro — Río Viejo, Jinotega cascade)
 *     **Larreynaga hydro 17 MW**              (hydro — Río Grande de Matagalpa)
 *     **Amayo wind I+II 63 MW**               (wind — Rivas, Pacific ridge; Nicaragua's main wind)
 *     **Blue Power wind 40 MW**               (wind — Rivas isthmus, Lake Nicaragua shore)
 *     **Acahualinca thermal 60 MW**           (HFO — Managua, Tipitapa)
 *     **Monte Rosa bagasse ~40 MW**           (bagasse CHP — Chichigalpa, Chinandega)
 *     **San Antonio bagasse ~66 MW**          (bagasse CHP — Chichigalpa, Chinandega; largest)
 *     **Albanisa solar ~15 MW**               (solar — Rivas)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar** — Chinandega (Chichigalpa: Ingenio San Antonio, Monte Rosa);
 *     Nicaragua is #3 Central Am sugar exporter; bagasse cogeneration
 *   - **Coffee** — Matagalpa (Jinotega, Matagalpa); Nicaraguan Maragogype variety;
 *     fair-trade and organic oriented; Segovia highlands
 *   - **Beef/Cattle** — Chontales, Boaco, RAAN; Nicaragua is Central Am's
 *     largest beef exporter; extensive ranching on Pacific/Caribbean plains
 *   - **Rum** — Flor de Caña distillery (Chichigalpa, Chinandega); world-famous
 *     aged rum; COMPAÑÍA LICORERA DE NICARAGUA
 *   - **Textiles/Maquila** — Las Mercedes Free Trade Zone (Managua airport area);
 *     ~70 factories, mainly US/Korean brands; ~100,000 workers
 *   - **Gold mining** — La Libertad (Chontales), Bonanza (RAAN);
 *     B2Gold (Canada) is main operator; HEMCO Nicaragua in Bonanza
 *   - **Fishing** — Puerto Cabezas (RAAN), Bluefields (RAAS); shrimp and lobster
 *     export from Caribbean coast; Chinandega shrimp farms (Pacific)
 *   - **Palm oil** — growing in RAAN and RAAS (Caribbean lowlands);
 *     replacing subsistence agriculture
 *
 * NI_BBOX: [minLat=10.7, minLon=-87.7, maxLat=15.0, maxLon=-82.6]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ni.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const NI_BBOX: readonly [number, number, number, number] = [10.7, -87.7, 15.0, -82.6]

await enrichGemIndustrial({
  countryCode: 'ni',
  countryName: "Nicaragua",
  bbox: NI_BBOX,
})
