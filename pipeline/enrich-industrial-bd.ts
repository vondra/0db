/**
 * Enrich BD industrial with GEM Global Integrated Power (Bangladesh filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Bangladesh'):
 *     360 total / 152 operating / ~27.4 GW
 *     Operating fuel: oil/gas 120 (overwhelmingly gas-dependent), coal 12,
 *     solar 17, hydro 1
 *
 *   Top operating plants:
 *     **Payra 1,320 MW** (coal, Patuakhali — CPEC/Chinese S-Kexin, 2×660 MW)
 *     **Rampal 1,320 MW** (coal, Bagerhat — India-BD joint venture BIFPCL)
 *     **Banshkhali 1,320 MW** (coal, Chittagong coast — SS Power I)
 *     **Matarbari 1,200 MW** (coal, Cox's Bazar — JICA Japanese-funded ultra-supercritical)
 *     **Kaptai 230 MW** (hydro, Rangamati — Bangladesh's ONLY hydro plant,
 *                        on Karnaphuli River, built 1962, massive reservoir)
 *     **Bibiyana CCPP ~800 MW** (gas, Habiganj — largest gas field, Chevron)
 *     **Ghorasal CCPP ~990 MW** (gas, Narsingdi — oldest gas plant, rehabilitated)
 *     **Ashuganj CCPP ~600 MW** (gas, B.Baria — east-bank power hub)
 *
 * Non-power industrial (OSM only):
 *   - **RMG (Ready-Made Garments)**: Dhaka/Gazipur/Narayanganj —
 *     world's #2 garment exporter after China, ~$45B/year, 4,500+ factories,
 *     employs ~4M workers (mostly women). BGMEA member factories.
 *   - **Eastern Refinery** (Chittagong/Patenga) — Bangladesh's only oil
 *     refinery, ~1.5 MT/yr, Bangladesh Petroleum Corporation.
 *   - **Cement**: Shah Cement (Munsiganj), Bashundhara Cement, LafargeHolcim
 *     (Chhatak, Sylhet — uses Indian limestone via conveyor).
 *   - **Ship-breaking** (Sitakunda, Chittagong) — world's #2 after Alang India;
 *     200+ breaking yards, ~6M LDT/yr, notorious for labour/environmental issues.
 *   - **Chittagong Port** (Chattogram Port) — Bangladesh's main seaport,
 *     handles ~92% of national trade, ~3M TEU/yr.
 *   - **Mongla Port** (Khulna division) — second seaport, handles Indian
 *     transit cargo.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-bd.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const BD_BBOX: readonly [number, number, number, number] = [20.6, 88.0, 26.65, 92.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [24.0, 88.0, 26.65, 88.4],
  [25.5, 88.0, 26.65, 90.0],
  [25.0, 91.5, 26.65, 92.7],
  [20.6, 92.3, 21.5, 92.7],
]

await enrichGemIndustrial({
  countryCode: 'bd',
  countryName: "Bangladesh",
  bbox: BD_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, BD_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
