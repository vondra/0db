/**
 * Enrich QA industrial with GEM Global Integrated Power (Qatar filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Qatar'):
 *     39 total / 33 operating / ~13.4 GW
 *     Operating fuel: oil/gas 28 (100% gas-fired — Qatar sits on North Field,
 *                                  world's largest non-associated gas field shared
 *                                  with Iran's South Pars), solar 4
 *                     (Al Kharsaah 800 MW — Qatar's first utility solar,
 *                      TotalEnergies/Marubeni for FIFA 2022), bioenergy 1
 *
 *   Top operating plants:
 *     **Ras Laffan A+B+C ~3,830 MW** (tied to North Field LNG operations)
 *     **Umm Al Houl 2,520 MW** (newest mega desal+power)
 *     **Mesaieed 2,007 MW** (Mesaieed industrial city)
 *     **Qatalum CCGT 1,350 MW** (tied to Qatalum aluminium smelter)
 *     **Al Kharsaah 800 MW** (solar PV, Qatar's first utility solar)
 *
 * Non-power industrial (OSM only):
 *   - **QatarEnergy** (world's largest LNG exporter — North Field expansion)
 *   - **Qatargas/RasGas LNG trains** (Ras Laffan Industrial City)
 *   - **QAPCO/QChem/Q-Chem** (Mesaieed petrochemical complex)
 *   - **Qatalum aluminium** (585 ktpa — one of world's largest single-site smelters)
 *   - **Pearl GTL** (Shell — world's largest gas-to-liquids plant, 140k bpd)
 *   - **Laffan Refinery** (Ras Laffan)
 *   - **Oryx GTL** (Sasol/QatarEnergy gas-to-liquids plant)
 *
 * World's highest GDP per capita (PPP). Ras Laffan Industrial City is one of
 * the world's largest industrial complexes (~250 km² purpose-built city 80 km
 * north of Doha, home to LNG trains, petrochemical, GTL, power plants).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-qa.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const QA_BBOX: readonly [number, number, number, number] = [24.45, 50.7, 26.2, 51.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [24.45, 50.7, 24.55, 51.7],
]

await enrichGemIndustrial({
  countryCode: 'qa',
  countryName: "Qatar",
  bbox: QA_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, QA_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
