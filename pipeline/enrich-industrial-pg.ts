/**
 * Enrich PG industrial with GEM Global Integrated Power (Papua New Guinea filter).
 *
 * All PNG government portals publish corporate HTML only. GEM is the only
 * machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Papua New Guinea'):
 *     6 operating plants, ~277 MW total
 *
 *   Top operating plants:
 *     **Ramu 1 hydro 77 MW**      (hydro — Ramu River, Madang Province)
 *     **Kanudi 58 MW**            (gas/LNG — Port Moresby)
 *     **Ok Menga hydro 57 MW**    (hydro — Western Province)
 *     **Edevu hydro 54 MW**       (hydro — Central Province)
 *     **Lihir geothermal 30 MW**  (geothermal — Lihir Island, New Ireland)
 *     **Daru solar 1 MW**         (solar — Daru, Western Province)
 *
 * Non-power industrial (OSM only):
 *   - **PNG LNG** (ExxonMobil, 2014) — one of world's newest major LNG projects,
 *     ~8.3 Mtpa capacity, Hides gas field (Southern Highlands) → Caution Bay LNG terminal
 *   - **Papua LNG** (TotalEnergies) — under development, Elk-Antelope gas fields
 *   - **Ok Tedi copper/gold** (Western Province) — one of world's most controversial
 *     mines; tailings discharged into Fly River caused major ecological disaster
 *   - **Porgera gold** (Enga Province) — Barrick/Zijin JV, one of world's top-10
 *     gold mines by production
 *   - **Lihir gold** (New Ireland) — Newcrest/Newmont; one of world's largest gold
 *     mines, built inside active volcanic caldera on Lihir Island
 *   - **Ramu NiCo** (MCC China) — nickel/cobalt laterite mine + refinery,
 *     Kurumbukari (Madang Province)
 *   - **Palm oil**: West New Britain, New Ireland (Hargy Oil Palms, New Britain
 *     Palm Oil / Kulim group)
 *   - **Coffee**: Highlands provinces — PNG is world's ~#17 coffee producer;
 *     high-quality Arabica (Sigri, Kimel, Blue Mountain style)
 *   - **Tuna**: major Pacific tuna fishing nation; canneries in Madang & Wewak
 *   - ~840 living languages — most linguistically diverse country on Earth
 *
 * Bbox note:
 *   PNG territory lies entirely within 140–160°E — no antimeridian handling needed.
 *   A small longitudinal exclusion (lon < 141.0) filters out the Indonesian side
 *   of the New Guinea island (West Papua / Papua provinces, border ~141°E meridian).
 *   PG_BBOX: minLat=-11.7, minLon=140.8, maxLat=-1.0, maxLon=160.0
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-pg.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const PG_BBOX: readonly [number, number, number, number] = [-11.7, 140.8, -1.0, 160.0]

await enrichGemIndustrial({
  countryCode: 'pg',
  countryName: "Papua New Guinea",
  bbox: PG_BBOX,
})
