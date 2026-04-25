/**
 * Enrich CI industrial with GEM Global Integrated Power (Côte d'Ivoire filter).
 *
 * All Ivorian gov portals (AGEROUTE-CI, CI-Energies, Ministère des Mines et
 * de l'Énergie) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Côte d'Ivoire'):
 *     42 total, 13 operating
 *     Operating fuel breakdown: oil/gas 6, hydropower 5, solar 2
 *
 *   Top operating plants:
 *     **Azito 460+253 = 713 MW** (CCGT, Azito district Abidjan — Globeleq/IFC,
 *                                  Côte d'Ivoire's largest thermal)
 *     **CIPREL 255+111 MW** (Compagnie Ivoirienne de Production d'Électricité,
 *                             Vridi district Abidjan — ENI/EDF/IFC)
 *     **Soubré 275 MW** (hydropower — Sassandra River, opened 2017, China-built
 *                         Sinohydro, Côte d'Ivoire's newest major hydro)
 *     **Taabo 210 MW** (hydropower — Bandama River, 1979)
 *     **Kossou 174 MW** (hydropower — Bandama River, Lake Kossou 1972, largest
 *                         reservoir in Côte d'Ivoire)
 *     **Buyo 165 MW** (hydropower — Sassandra River, 1980)
 *     **Gribo-Popoli 112 MW** (hydropower — Sassandra River, opened 2021)
 *     **Agrekko Vridi 200 MW** (emergency gas rental — Vridi Abidjan, 2× 100 MW)
 *     **Boundiali Solar 38 MW** (Côte d'Ivoire's first utility solar, 2023)
 *
 * Non-power industrial (OSM only):
 *   - **SIR** (Société Ivoirienne de Raffinage) refinery — Vridi/Abidjan,
 *     ~80k bpd, Côte d'Ivoire's only oil refinery (supplies fuel for 7 West
 *     African countries)
 *   - **LafargeHolcim** + **SCA (Société des Ciments d'Abidjan)** — cement
 *   - **Cocoa processing**: Yopougon (Abidjan industrial), San Pédro
 *     (Côte d'Ivoire is the world's #1 cocoa producer, ~40% of global supply)
 *   - **Palm oil**: Palmci, Sifca — Southern rainforest belt
 *   - **Rubber processing**: SAPH, SOGB — Southern rainforest belt
 *   - **Port of Abidjan** (Africa's 2nd-largest francophone port) + **Port of
 *     San Pédro** (world's largest cocoa export port)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ci.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const CI_BBOX: readonly [number, number, number, number] = [4.3, -8.6, 10.8, -2.5]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4.3, -8.6, 8.6, -7.55],
  [8.6, -8.6, 10.8, -7.6],
  [10.3, -8.6, 10.8, -4.5],
  [9.5, -5.5, 10.8, -2.5],
  [4.3, -3.1, 10.8, -2.5],
]

await enrichGemIndustrial({
  countryCode: 'ci',
  countryName: "Côte d",
  bbox: CI_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, CI_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
