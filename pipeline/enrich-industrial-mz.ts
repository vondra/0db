/**
 * Enrich MZ industrial with GEM Global Integrated Power (Mozambique filter).
 *
 * All Mozambican gov portals (EDM, Ministério dos Recursos Minerais e
 * Energia, ENH, INP) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mozambique'):
 *     78 total, 12 operating, ~2.94 GW
 *     Operating fuel breakdown: oil/gas 5, solar 4, hydropower 3
 *
 *   Top operating plants:
 *     **Cahora Bassa 2,075 MW** (Zambezi River — one of Africa's largest
 *                                 hydropower, built 1969-1979 by Portuguese
 *                                 colonial government, **dominates MZ fleet**.
 *                                 Exports majority of power to South Africa
 *                                 via Apollo HVDC link — one of the world's
 *                                 earliest major HVDC transmission systems)
 *     **Ressano Garcia 175 MW** (Matola gas — Sasol-linked, supplies Maputo)
 *     **Karpowership "Mehmet Bey" 125 MW** (Turkish floating powership,
 *                                            anchored off Nacala, Cabo Delgado)
 *     **Maputo 121 MW** (oil/gas, Maputo thermal)
 *     **Gigawatt Park 119 MW** + **Gigawatt Mozambique 117 MW** (gas IPPs)
 *     **Mavuzi 52 MW** + **Chicamba 44 MW** (smaller Zambezi hydros)
 *     **Metoro Solar 41 MW**, **Mocuba Solar 40 MW**, **Cuamba Solar 19 MW**
 *     **Balama Graphite Mine Solar 11 MW** (Syrah Resources mine)
 *
 * **Under construction (not counted as operating)**:
 *     **Mphanda Nkuwa ~1,500 MW** (Zambezi, planned next mega-dam)
 *
 * Non-power industrial (OSM only):
 *   - **Mozal Aluminium Smelter** (Matola, Maputo) — **Africa's largest
 *     aluminium smelter**, ~580 ktpa. Started 2000 by BHP Billiton (now
 *     South32). Paradoxically uses power from South Africa grid (reverse of
 *     Cahora Bassa export flow to SA)
 *   - **Moatize Coal Basin** (Tete Province) — **world-class coking coal**,
 *     Vale operated 2011-2021, now Vulcan International (Jindal). Massive
 *     open-pit mines connect to Nacala Corridor rail for export
 *   - **Mozambique LNG / Area 1 / Golfinho-Atum** (TotalEnergies, offshore
 *     Rovuma basin, Cabo Delgado) — **~$20B project**, paused since 2021
 *     due to Cabo Delgado insurgency, resuming 2024/2025
 *   - **Coral South FLNG** (ENI, offshore Rovuma) — **first LNG operation
 *     2022** (floating liquefaction, only the 2nd FLNG in Africa after
 *     Cameroon's Kribi)
 *   - **Sasol Temane gas** (Inhambane province) — supplies gas to Sasol's
 *     Secunda (South Africa) via 900 km pipeline + Ressano Garcia/Maputo
 *     gas plants via CTRG pipeline
 *   - **Kenmare Resources Moma** (Nampula coast) — **world-class heavy
 *     mineral sands** (ilmenite/zircon/rutile for titanium)
 *   - **Beira Port** — hinterland for Zimbabwe/Zambia/Malawi
 *   - **Nacala Port** — deep-water, Malawi corridor terminus
 *   - **Cement**: Cimentos de Moçambique (Matola), Cinac (Nacala),
 *     Dugongo Cement (Dondo)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MZ_BBOX: readonly [number, number, number, number] = [-26.95, 30.2, -10.5, 40.9]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-26.95, 30.2, -25.8, 31.9],
  [-26.95, 31.0, -25.7, 32.1],
  [-22.5, 30.2, -16.4, 33.0],
  [-15.6, 30.2, -13.5, 30.5],
  [-15.8, 34.2, -11.3, 35.9],
  [-10.6, 34.5, -10.5, 40.9],
]

await enrichGemIndustrial({
  countryCode: 'mz',
  countryName: "Mozambique",
  bbox: MZ_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MZ_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
