/**
 * Enrich SO industrial with GEM Global Integrated Power (Somalia filter).
 *
 * Somalia's government (and Somaliland/Puntland administrations) publish no open
 * GIS or power plant data. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Somalia'):
 *     7 operating plants, ~94 MW total
 *
 *   Notable operating plants:
 *     **Benadir Power Station ~80 MW** (diesel — Mogadishu, main thermal plant)
 *     **Mogadishu solar ~6 MW**        (solar — various rooftop/mini-grid projects)
 *     **Hargeisa diesel ~8 MW**        (diesel — Somaliland capital backup)
 *
 * Non-power industrial (OSM only):
 *   - **Port of Mogadishu** — main seaport; severely damaged in civil war,
 *     rehabilitation ongoing (Turkish-backed); fisheries export
 *   - **Port of Berbera** (Somaliland) — DP World 30-year concession (2016);
 *     major Horn of Africa port expansion; UAE military base nearby
 *   - **Port of Bosaso** (Puntland) — northeastern port, livestock export
 *   - **Fishing** — Indian Ocean and Gulf of Aden; significant piracy history
 *     (Puntland coast); artisanal and semi-industrial fleet
 *   - **Livestock** — Somalia is world's largest camel exporter; significant
 *     cattle, sheep, goat trade to Arabian Peninsula (live export via Berbera)
 *   - **Telecommunications** — Hormuud Telecom, Somtel; surprisingly advanced
 *     mobile money (Zaad, EVC Plus) in failed-state context
 *   - No significant manufacturing; informal economy dominant
 *
 * No railway. Al-Shabaab controls large rural areas (south/central).
 * Somaliland de facto independent since 1991 (capital Hargeisa).
 * Puntland autonomous since 1998 (capital Garowe).
 *
 * SO_BBOX: [minLat=-1.7, minLon=40.9, maxLat=12.0, maxLon=51.5]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-so.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SO_BBOX: readonly [number, number, number, number] = [-1.7, 40.9, 12.0, 51.5]

await enrichGemIndustrial({
  countryCode: 'so',
  countryName: "Somalia",
  bbox: SO_BBOX,
})
