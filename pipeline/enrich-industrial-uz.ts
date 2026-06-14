/**
 * Enrich UZ industrial with GEM Global Integrated Power (Uzbekistan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Uzbekistan'):
 *     179 total / 93 operating / ~21.1 GW
 *     Operating fuel: gas 56 (oil/gas dominant), solar 13, hydro 10,
 *                     coal 12 (Angren lignite basin), wind 2
 *
 *   Top operating plants:
 *     **Talimarjan 1,700 MW** (gas complex, Kashkadarya)
 *     **ACWA Power Sirdarya 1,500 MW** (Saudi CCGT, Sirdarya — newest mega-plant,
 *                                       commissioned 2023)
 *     **Navoi 928 MW** (gas, central Navoi region)
 *     **Turakurgan 900 MW** (gas, Namangan)
 *     **Charvak 666 MW** (largest hydro, Chirchiq River, Tashkent region)
 *     **Bash + Dzhankeldy wind 1,000 MW** (new wind farms)
 *     **Karaulbazar + Nishan solar 1,000 MW** (new solar parks, Bukhara/Kashkadarya)
 *     **Angren 484 MW** (lignite coal, Tashkent region — only coal plant)
 *
 * Non-power industrial (OSM only):
 *   - **Muruntau gold mine** (Navoi region — world's largest open-pit gold mine,
 *     Navoi Mining & Metallurgical Combinat / state, ~2 Moz/year, one of the
 *     deepest open pits on earth)
 *   - **Almalyk Mining & Metallurgical Combinat (AGMK)** (Tashkent region —
 *     Central Asia's largest copper-gold-molybdenum complex)
 *   - **Bukhara oil refinery (BNPZ)** + **Ferghana oil refinery** (two main
 *     refineries, Soviet-era, processing Uzbek crude + imports)
 *   - **Shurtan Gas Chemical Complex** (Kashkadarya — gas-to-polyethylene,
 *     major export earner)
 *   - **Kungrad soda ash plant** (Karakalpakstan, near Aral Sea)
 *   - **Bekabad steel** (Tashkent region, electric arc, Soviet-era)
 *   - **Chirchiq chemical** (nitrogen fertilizer, near Tashkent)
 *   - **Navoiy Chemical Plant** (hydrometallurgy, uranium leaching history)
 *   - **Cotton processing**: post-2017 reforms ended forced labor; sector
 *     restructuring continues (UZ is world's 6th largest cotton exporter)
 *   - **UzAuto Motors (Asaka)** — GM Uzbekistan joint-venture; produces
 *     ~300,000 Chevrolet cars/year (Cobalt, Malibu, Spark, Damas minivan);
 *     near-total domestic market dominance due to extreme import tariffs
 *   - **Doubly landlocked**: Uzbekistan + Liechtenstein — only 2 in the world
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-uz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into Kazakhstan/Turkmenistan/Tajikistan/Kyrgyzstan).
const UZ_BBOX: readonly [number, number, number, number] = [37.2, 55.9, 45.6, 73.2]

await enrichGemIndustrial({
  countryCode: 'uz',
  countryName: "Uzbekistan",
  bbox: UZ_BBOX,
  isInside: makeCountryGate('UZ'),
})
