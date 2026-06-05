/**
 * Enrich CM industrial with GEM Global Integrated Power (Cameroon filter).
 *
 * Cameroonian gov portals (ENEO, SONATREL, MINEE, Ministère des Travaux
 * Publics, MINREX) publish corporate HTML only. GEM is the only
 * machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cameroon'):
 *     31 total, 13 operating, ~1.9 GW
 *     Operating fuel breakdown: hydropower 5, solar 4, oil/gas 3, wind 1
 *
 *   **Cameroon has a hydro-dominated grid** centred on the Sanaga River
 *   cascade, which provides most of the national generation.
 *
 *   Top operating plants:
 *     **Nachtigal 420 MW** (Sanaga River, **opened 2024** — Cameroon's newest
 *                           major hydro, built by EDF consortium, largest
 *                           single plant now overtakes Song Loulou)
 *     **Song Loulou 396 MW** (Sanaga River, 1988)
 *     **Edéa 276 MW** (Sanaga River, **1953 — Cameroon's oldest major hydro**,
 *                       historically dedicated to feeding Alucam aluminium smelter)
 *     **Kribi 216 MW** (CCGT gas, opened 2013 — Cameroon's main gas plant,
 *                        fed by Sanaga basin / Logbaba field gas)
 *     **Memve'ele 211 MW** (Ntem River, south, opened 2018)
 *     **Dibamba 88 MW** (oil/gas, Douala area)
 *     **Lagdo 72 MW** (Benue River, north — only major northern hydro,
 *                       1982, 50% shared with Chad/Nigeria water rights)
 *     **Ahala 60 MW** (oil/gas, Yaoundé)
 *     **Cameroon Wind 100 MW** (central Cameroon — recent)
 *     **Garoua/Guider/Maroua Solar** (small north solar farms)
 *
 * **Under construction (not counted as operating)**:
 *     **Lom Pangar hydro extension** (Sanaga River regulator dam, small)
 *     **Natchigal Aval + Njock** extensions
 *
 * Non-power industrial (OSM only):
 *   - **SONARA refinery** — Limbé (Anglophone SW), 45k bpd, **partially
 *     destroyed by fire May 2019**, non-operational since. Rehabilitation
 *     under discussion, uncertain timeline.
 *   - **Alucam (Aluminium du Cameroun)** — Edéa, ~95 ktpa aluminium smelter,
 *     historically Rio Tinto/Alcan, now majority state-owned. Uses power
 *     from Edéa hydro (dedicated generation for aluminium smelting).
 *   - **Kribi deepwater port** (opened 2018) — first Central African
 *     deepwater port, handles container + bulk
 *   - **Douala port** — Central Africa's main port for Cameroon, Chad, CAR,
 *     Gabon, Eq. Guinea, N Congo. Historically the key regional gateway.
 *   - **Hilli Episeyo Kribi FLNG** — **Africa's first operational FLNG**
 *     (2018, Golar LNG → New Fortress Energy), before Mozambique Coral
 *     South FLNG (2022)
 *   - **Logbaba onshore gas field** (Douala — Victoria Oil & Gas / Rodeo
 *     Development) — domestic gas for power and industry
 *   - **Offshore oil**: Ebome, Moudi (Addax Petroleum, CNPC → Sinopec)
 *   - **Cocoa processing**: SIC Cacaos, **Cameroon is world's #5 cocoa
 *     producer** (~280 ktpa)
 *   - **Palm oil**: SOCAPALM, CDC (Cameroon Development Corporation)
 *   - **Cement**: Cimencam (Holcim), Dangote Cement Cameroon, Cimaf
 *   - **Timber**: major exporter of tropical hardwood (mahogany, sapele,
 *     iroko) via Douala and Kribi ports
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-cm.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const CM_BBOX: readonly [number, number, number, number] = [1.6, 8.4, 13.1, 16.2]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4.0, 8.4, 11.0, 9.0],
  [11.0, 13.0, 13.1, 14.5],
  [12.0, 14.5, 13.1, 16.2],
  [2.5, 15.0, 8.0, 16.2],
  [1.6, 15.0, 2.5, 16.2],
  [1.6, 9.5, 2.3, 14.5],
  [1.6, 9.5, 2.3, 11.5],
]

await enrichGemIndustrial({
  countryCode: 'cm',
  countryName: "Cameroon",
  bbox: CM_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, CM_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
