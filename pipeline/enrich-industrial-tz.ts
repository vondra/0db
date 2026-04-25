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
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const TZ_BBOX: readonly [number, number, number, number] = [-11.8, 29.3, -0.9, 40.5]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1.6, 33.9, -0.9, 41.9],
  [-1.5, 29.5, -0.9, 35.0],
  [-2.9, 28.8, -1.0, 30.9],
  [-4.5, 29.0, -2.3, 30.9],
  [-11.8, 29.0, -2.0, 29.4],
  [-11.8, 29.0, -8.2, 33.0],
  [-11.8, 32.7, -9.4, 34.6],
  [-11.8, 34.6, -10.2, 40.5],
]

await enrichGemIndustrial({
  countryCode: 'tz',
  countryName: "Tanzania",
  bbox: TZ_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, TZ_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
