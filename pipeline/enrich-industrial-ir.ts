/**
 * Enrich IR industrial with GEM Global Integrated Power (Iran filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Iran'):
 *     547 total / 408 operating / ~89.3 GW
 *     (2nd largest enriched after Turkey)
 *     Operating fuel: oil/gas 281 (OVERWHELMINGLY gas — Iran has world's 2nd
 *                                  largest gas reserves after Russia),
 *                    solar 90 (Yazd/Kerman desert belt),
 *                    hydro 24, wind 11, nuclear 1 (Bushehr VVER),
 *                    geothermal 1
 *
 *   Top operating plants:
 *     **Karun-III 2,000 MW** (Khuzestan, Karun River cascade)
 *     **Shahid Abbaspuor (Karun-1) 2,000 MW** (Khuzestan)
 *     **Masjed Soleyman (Karun-2) 2,000 MW** (Khuzestan)
 *     **Karun-IV + Upper Gotvand + Siahbishe + Dez** —
 *       Karun cascade ~8,520 MW total (Iran's dominant hydro system)
 *     **Bushehr Nuclear 1,000 MW** (Russian VVER-1000, Bushehr coast)
 *     **Mobarakeh Steel captive 914 MW** (Isfahan)
 *
 * Non-power industrial (OSM only):
 *   - **South Pars gas field** (Persian Gulf coast, Asaluyeh) — world's
 *     largest natural gas field, shared with Qatar's North Dome field.
 *     29 phases, ~1 billion m³/day, backbone of Iran's economy.
 *   - **Refineries**: Isfahan (largest, 370 kbd), Abadan (historic, 400 kbd
 *     capacity), Bandar Abbas (Star refinery ~480 kbd, Iran's largest),
 *     Tehran, Tabriz, Arak, Shiraz, Lavan (offshore island), Kermanshah
 *   - **Mobarakeh Steel Isfahan** — Middle East's largest steel mill,
 *     ~8 MT/yr hot-rolled coil
 *   - **NIOC / NIGC**: National Iranian Oil/Gas Company upstream assets
 *   - **Petrochem**: Asaluyeh Special Economic Zone (Bushehr/Asaluyeh coast),
 *     Mahshahr (Imam Khomeini Port), Iran's largest petrochem clusters
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ir.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const IR_BBOX: readonly [number, number, number, number] = [25.0, 44.0, 39.8, 63.5]

await enrichGemIndustrial({
  countryCode: 'ir',
  countryName: "Iran",
  bbox: IR_BBOX,
})
