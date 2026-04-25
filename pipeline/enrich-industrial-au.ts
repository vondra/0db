/**
 * Enrich AU industrial with GEM Global Integrated Power (Australia filter).
 *
 * All Australian state agencies publish AEMO data in proprietary formats.
 * GEM is the best machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Australia'):
 *     822 operating plants
 *
 *   Notable operating plants:
 *     **Loy Yang A coal 2,200 MW**         (coal — Latrobe Valley, Victoria; largest thermal)
 *     **Eraring coal 2,880 MW**            (coal — Lake Macquarie, NSW; largest single plant)
 *     **Mt Piper coal 1,400 MW**           (coal — Lithgow, NSW)
 *     **Callide coal 1,630 MW**            (coal — Biloela, Queensland)
 *     **Snowy 2.0 hydro 2,000 MW**         (hydro — Snowy Mountains, NSW/VIC)
 *     **Gordon hydro 432 MW**              (hydro — Tasmania; Gordon River)
 *     **Origin Darling Downs gas 630 MW**  (gas — Dalby, Queensland)
 *     **Torrens Island gas 1,280 MW**      (gas — Port Adelaide, South Australia)
 *     **Bungala Solar One/Two 220 MW**     (solar — Port Augusta, SA)
 *     **Neoen Hornsdale wind 315 MW**      (wind — Yorke Peninsula, SA; with big battery)
 *     **AGL Macarthur wind 420 MW**        (wind — Victoria)
 *     **Stockyard Hill wind 530 MW**       (wind — Victoria; largest wind farm)
 *
 * Non-power industrial (OSM only):
 *   - **Mining** — iron ore (Pilbara, WA: Rio Tinto, BHP); coal (Hunter Valley, NSW;
 *     Bowen Basin, QLD); bauxite/alumina (WA, QLD); LNG (NW Shelf, Darwin)
 *   - **Steel** — BlueScope Steelworks (Port Kembla, NSW; largest integrated steelworks)
 *   - **Aluminium smelting** — Portland (VIC), Tomago (NSW), Boyne Island (QLD)
 *   - **LNG** — Karratha/Dampier (WA): Woodside NW Shelf; Darwin LNG;
 *     Gladstone (QLD): three LNG export terminals
 *   - **Meat processing** — JBS Australia, Teys (beef processing QLD, NSW, SA)
 *   - **Sugar milling** — Burdekin and Mackay regions (QLD); MSF Sugar, Wilmar
 *   - **Wool/cotton** — Darling Downs (QLD), Riverina (NSW)
 *   - **Grain handling** — CBH (WA), GrainCorp (eastern states) terminal elevators
 *   - **Chemicals** — Incitec Pivot (Brisbane, Gibson Island ammonia)
 *
 * AU_BBOX: [minLat=-44.0, minLon=112.0, maxLat=-10.0, maxLon=154.0]
 * Island continent — no land border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-au.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const AU_BBOX: readonly [number, number, number, number] = [-44.0, 112.0, -10.0, 154.0]

await enrichGemIndustrial({
  countryCode: 'au',
  countryName: "Australia",
  bbox: AU_BBOX,
})
