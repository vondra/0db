/**
 * Enrich IQ industrial with GEM Global Integrated Power (Iraq filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Iraq'):
 *     388 total / 246 operating / ~50.5 GW — MASSIVE.
 *     Operating fuel: oil/gas 231 (overwhelmingly gas-fired — Iraq flares
 *     ~18 Bcm/year, world's 2nd worst after Russia), solar 8, hydro 7.
 *
 *   Top operating plants:
 *     **Besmaya 4,500 MW** (6×750 MW, GE gas turbines — Iraq's largest
 *                           single complex, south-east Baghdad)
 *     **Mosul Dam 1,052 MW** (Tigris — ONE OF WORLD'S MOST DANGEROUS DAMS,
 *                             risk of catastrophic failure, gypsum/anhydrite
 *                             dissolution in foundations — USACE emergency
 *                             grouting program ongoing)
 *     **Haditha 660 MW** (Euphrates — Iraq's 2nd largest hydro dam)
 *     **Erbil/Sulaymaniyah ~3,000 MW** (KRG Kurdistan autonomous region
 *                                        gas-fired fleet, reliable grid vs
 *                                        Iraqi national grid)
 *
 * Non-power industrial (OSM only):
 *   - **Rumaila oil field** (Basra — world's 6th largest, BP/PetroChina/SOMO
 *     joint operation, ~1.4 M bbl/day)
 *   - **West Qurna 1+2** (ExxonMobil/LUKOIL super-giant, Basra governorate)
 *   - **Zubair** (ENI-operated, Basra)
 *   - **Majnoon** (Shell exited 2018, now IOC-managed, giant field)
 *   - **Basra Gas Company** (Shell-led JV, captures flared associated gas
 *     from southern oil fields, world's largest single gas capture project)
 *   - **Baiji refinery** (315k bbl/day — Iraq's largest, destroyed by ISIS
 *     2014, partially restored; Saladin governorate)
 *   - **Doura refinery** (Baghdad, ~120k bbl/day)
 *   - **Basra refinery** (~140k bbl/day, southern export hub)
 *   - **KRG refineries**: Bazian, Tawke (Duhok), plus small-scale topping
 *   - **Iraqi cement**: Karbala, Samawah, Muthanna (Badush)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-iq.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const IQ_BBOX: readonly [number, number, number, number] = [29.0, 38.7, 37.4, 48.6]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [37.2, 38.7, 37.4, 45.0],
  [32.0, 46.5, 37.4, 48.6],
  [29.0, 48.0, 32.0, 48.6],
  [29.0, 46.5, 29.5, 48.6],
  [29.0, 38.7, 29.4, 48.6],
  [33.0, 38.7, 37.4, 40.5],
  [29.0, 38.7, 33.0, 39.5],
]

await enrichGemIndustrial({
  countryCode: 'iq',
  countryName: "Iraq",
  bbox: IQ_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, IQ_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
