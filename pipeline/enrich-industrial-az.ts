/**
 * Enrich AZ industrial with GEM Global Integrated Power (Azerbaijan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Azerbaijan'):
 *     68 total / 44 operating / ~7.42 GW
 *     Operating fuel: gas/oil 23, solar 13, hydro 6, wind 1
 *
 *   Top operating plants:
 *     **Azerbaijan TPS / Mingachevir Thermal** ~1,800 MW (6×300 MW,
 *                            Kür River, Azerbaijan's largest thermal station)
 *     **Shimal 800 MW** (north of Baku, combined-cycle gas)
 *     **Janub 780 MW** (south of Baku, combined-cycle gas)
 *     **Sumgayit 525 MW** (Soviet-era industrial satellite of Baku)
 *     **Gobu 384 MW** (Garadagh district, Baku)
 *     **Sangachal 308 MW** (Caspian terminal gas turbine, BP-operated)
 *     **Mingachevir Hydro 424 MW** (Kür River dam, Azerbaijan's main hydro)
 *     **Shamkir Hydro 380 MW** (Kür River cascade, west Azerbaijan)
 *     **Baku Wind 240 MW** (Absheron Peninsula, near Baku)
 *
 * Non-power industrial (OSM only):
 *   - **SOCAR** (State Oil Company of Azerbaijan Republic) — one of the
 *     Caspian's largest oil & gas companies; Baku headquarters, global ops
 *   - **ACG (Azeri-Chirag-Gunashli)** offshore — BP-operated, "Contract
 *     of the Century" 1994, backbone of AZ oil output (~600k bpd peak)
 *   - **Shah Deniz gas field** (BP, world-class, feeds SCP/TANAP/TAP)
 *   - **BTC pipeline** (Baku-Tbilisi-Ceyhan, 1,768 km, 1 Mbpd capacity)
 *   - **SCP / TANAP / TAP gas pipelines** (Southern Gas Corridor,
 *     Caspian→Turkey→Europe, 3,500 km total)
 *   - **Baku / Heydar Aliyev refinery** (~6.5 Mt/yr ≈ 125k bpd, SOCAR)
 *   - **Sumgayit Chemical Industrial Park** (Soviet-era, formerly one of
 *     the most polluted cities on Earth; petrochemicals, chlorine, PVC)
 *   - **ArcelorMittal Baku** (Baku Steel Company) — electric arc steel
 *   - COP29 host 2024 (Baku National Stadium)
 *
 * Nakhchivan exclave note: The AZ bbox covers both mainland and
 * Nakhchivan (38.8-39.8 N, 44.7-46.0 E). EXCLUDE_ZONES remove Armenia
 * (between mainland and exclave), Georgia (W), Russia (N), and Iran (S).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-az.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const AZ_BBOX: readonly [number, number, number, number] = [38.3, 44.7, 42.0, 50.6]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [41.8, 44.7, 42.0, 48.5],
  [41.0, 44.7, 42.0, 45.5],
  [39.6, 44.7, 41.0, 46.0],
  [38.3, 44.7, 38.8, 50.6],
]

await enrichGemIndustrial({
  countryCode: 'az',
  countryName: "Azerbaijan",
  bbox: AZ_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, AZ_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
