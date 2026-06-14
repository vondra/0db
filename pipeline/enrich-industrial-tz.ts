/**
 * Enrich TZ industrial with GEM Global Integrated Power (Tanzania filter).
 *
 * All Tanzanian gov portals publish WordPress/HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Tanzania'):
 *     87 total, 14 operating
 *     Fuel: hydropower 6, oil/gas 4, solar 4
 *
 *   Top operating plants:
 *     **Julius Nyerere Hydroelectric 2,115 MW** — opened 2024, on Rufiji
 *     River at Stiegler's Gorge, Nyerere National Park. One of Africa's
 *     largest new mega-dams. Controversial for impact on Selous Game
 *     Reserve (UNESCO World Heritage). Built 2019-2024 by Arab Contractors
 *     and Elsewedy Electric (Egyptian consortium).
 *     Kinyerezi II 240 MW (Dar es Salaam, gas, 2016)
 *     **Kidatu 200 MW** (hydropower, Great Ruaha River)
 *     **Kihansi 180 MW** (Kihansi Gorge, Iringa)
 *     Tegeta 100 MW (diesel, Dar es Salaam)
 *     Kishapu Solar 100 MW
 *     **Mtera 80 MW** (hydro, Great Ruaha River, upstream of Kidatu)
 *     **Rusumo 80 MW** (hydro, binational with Rwanda/Burundi on Akagera R.)
 *     **Pangani Falls 68 MW** (hydro)
 *     **Dodoma 55 MW** (gas, capital)
 *
 * Non-power industrial (OSM only):
 *   - **Gold mines**: Geita (AngloGold Ashanti), Bulyanhulu (Barrick),
 *     Buzwagi (Barrick), North Mara (Barrick), Nyanzaga (OreCorp)
 *   - **Diamonds**: Williamson/Mwadui (world's oldest continuously
 *     operating diamond mine since 1940)
 *   - **Tanzanite** (unique to Tanzania, Mererani)
 *   - **Songo Songo gas field** + Mtwara-Dar pipeline
 *   - Cement: Tanga Cement, Dangote Cement Tanzania, Twiga Cement, Mbeya
 *   - TIPER Tanzania-Italian Petroleum Refinery (Dar, closed 1999)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-tz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into Kenya/Uganda/Rwanda/DRC/Zambia/Malawi/Mozambique).
const TZ_BBOX: readonly [number, number, number, number] = [-11.8, 29.3, -0.9, 40.5]

await enrichGemIndustrial({
  countryCode: 'tz',
  countryName: "Tanzania",
  bbox: TZ_BBOX,
  isInside: makeCountryGate('TZ'),
})
