/**
 * Enrich KE industrial with GEM Global Integrated Power (Kenya filter).
 *
 * Kenya publishes no usable GIS. KeNHA/KURA/KeRRA have viewer dashboards
 * but no open data. Kenya Open Data (opendata.go.ke) is dormant. GEM
 * is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Kenya'):
 *     129 total, 45 operating
 *     Operating fuel breakdown:
 *       **geothermal: 16** (Olkaria I–V complex — world's largest
 *                           geothermal complex, ~780 MW total)
 *       wind: 8 (**Lake Turkana 260 MW** — Africa's largest wind farm,
 *                Kipeto 100 MW, Ngong)
 *       oil/gas: 7 (Kipevu III, Thika, Rabai, Athi Triumph — emergency backup)
 *       solar: 7 (**Garissa 50 MW**, Radiant, Alten Kesses)
 *       hydropower: 6 (**Tana River / Seven Forks cascade**: Gitaru 225,
 *                      Kiambere 168, Turkwel 103, Kamburu 94, Masinga 40,
 *                      Kindaruma 72, Sondu-Miriu 60)
 *       bioenergy: 1
 *
 *   Notable: **Olkaria Geothermal Complex** is the world's largest
 *   geothermal power facility, thanks to Kenya's location on the East
 *   African Rift Valley. Kenya is #9 globally in geothermal generation.
 *
 * Non-power industrial (OSM only):
 *   - **Mombasa Refinery** (closed 2013)
 *   - **KPC oil pipeline** (Mombasa ↔ Nairobi ↔ Eldoret ↔ Uganda border)
 *   - **Cement**: Bamburi, EAPCC, Mombasa Cement, Savannah Cement
 *   - **EABL** (East African Breweries — Tusker, Nairobi)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ke.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into neighbours along the bbox edges).
const KE_BBOX: readonly [number, number, number, number] = [-4.7, 33.9, 5.5, 41.9]

await enrichGemIndustrial({
  countryCode: 'ke',
  countryName: "Kenya",
  bbox: KE_BBOX,
  isInside: makeCountryGate('KE'),
})
