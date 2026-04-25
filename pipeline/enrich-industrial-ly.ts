/**
 * Enrich LY industrial with GEM Global Integrated Power (Libya filter).
 *
 * Libya's National Oil Corporation (NOC) and GECOL publish no open GIS data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Libya'):
 *     72 operating plants, ~14,417 MW total — massive oil/gas generation fleet,
 *     Africa's 4th largest installed capacity.
 *
 *   Notable operating plants:
 *     **West Tripoli CCGT ~2,100 MW**   (gas — largest single plant, Janzour)
 *     **Khoms CCGT ~1,200 MW**          (gas — Mediterranean coast, east of Tripoli)
 *     **Zawiya Power Station ~960 MW**  (gas/oil — Zawiya refinery complex)
 *     **Benghazi North ~800 MW**        (gas — North Benghazi, GECOL)
 *     **Tobruk Power ~480 MW**          (gas/diesel — eastern Libya)
 *     **Derna ~120 MW**                 (gas/diesel — eastern city, badly damaged 2023 floods)
 *     **Sebha ~180 MW**                 (gas — Fezzan, isolated grid)
 *     **Kufra diesel ~30 MW**           (diesel — deep south, off-grid)
 *
 * Non-power industrial (OSM only):
 *   - **Oil production** — Africa's LARGEST proven oil reserves (~48 Gbbl);
 *     Sirte Basin (main fields: El Sharara 300k bbl/day, El Feel/Elephant,
 *     Sarir, Nasser, Waha, Amal); NOC state-owned with IOC partnerships
 *     (ENI, BP, TotalEnergies, ConocoPhillips — many suspended post-2011)
 *   - **LNG export** — Marsa el Brega (Esso/ENI JV; oldest LNG plant 1971,
 *     now erratic); Mellitah Gas Complex (ENI/NOC, piped to Sicily via
 *     Greenstream Pipeline ~520 km)
 *   - **Oil refineries** — Zawiya (120k bbl/day), Ras Lanuf (220k bbl/day),
 *     Tobruk (30k bbl/day), Sarir/Ajdabiya; most running at reduced capacity
 *   - **Petrochemical** — Marsa el Brega fertiliser plant (urea/ammonia; NOC)
 *   - **Cement** — Libya Cement Company (Souk al Khamis, Khoms);
 *     Ahlia Cement (Benghazi); capacity ~12 Mt/year pre-conflict
 *   - **Steel** — Libya Iron and Steel Company (LISCO, Misrata);
 *     ~2 Mt capacity, one of Africa's largest steel plants; severely damaged
 *     in 2011 conflict, partially rebuilt
 *   - **Salt** — Gulf of Sirte coastal evaporation works
 *
 * Civil war since 2011 (Gaddafi fall); split Government of National Unity
 * (Tripoli, UN-recognised) vs Libya National Army (Benghazi, Haftar).
 *
 * LY_BBOX: [minLat=19.5, minLon=9.3, maxLat=33.2, maxLon=25.2]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ly.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const LY_BBOX: readonly [number, number, number, number] = [19.5, 9.3, 33.2, 25.2]

await enrichGemIndustrial({
  countryCode: 'ly',
  countryName: "Libya",
  bbox: LY_BBOX,
})
