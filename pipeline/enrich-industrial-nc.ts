/**
 * Enrich NC industrial with GEM Global Integrated Power (New Caledonia filter).
 *
 * All NC government portals (Gouvernement de la Nouvelle-Calédonie, DIMENC) publish
 * corporate HTML only. GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='New Caledonia'):
 *     39 operating plants, ~970 MW total
 *
 *   Top operating plants (nickel smelter power dominates):
 *     **Doniambo 340 MW**         (fuel oil — SLN/Eramet, Nouméa; 2×170 MW, since 1910)
 *     **Koniambo 270 MW**         (fuel oil — Glencore/SMSP, North Province; 2×135 MW, 2013)
 *     **Goro 100 MW**             (fuel oil — Prony Resources (ex-Vale), South Province; 2×50 MW)
 *     **Yaté hydro 68 MW**        (hydro — Yaté River, Grand Lac)
 *     **Jacques Lekawe 55 MW**    (diesel — Nouméa, ENERCAL)
 *     **Wind farms ~39 MW**       (wind — Col de Prony, Kafeate, Negandi)
 *     **Solar ~90 MW**            (~20 projects across main island and Loyalty Islands)
 *
 * Non-power industrial (OSM only):
 *   - **Nickel**: NC holds ~25% of world's known nickel reserves; world's #4 producer
 *   - **SLN/Eramet** (Doniambo pyrometallurgical smelter, Nouméa) — oldest continuously
 *     operating nickel smelter in the world (since 1910)
 *   - **Koniambo Nickel** (Glencore/SMSP — North Province, pyrometallurgical, 2013)
 *     one of the world's largest greenfield nickel projects (~$6B investment)
 *   - **Prony Resources** (formerly Vale NC/Goro — hydrometallurgical, South Province)
 *     $9B investment; unique high-pressure acid leach (HPAL) technology; troubled
 *     history including spills, COVID shutdowns, and 2021 ownership change
 *   - All three smelters have dedicated captive power plants — nickel smelting is
 *     extremely energy-intensive (~8–12 MWh per tonne of refined nickel)
 *   - **Chrome/cobalt/manganese** — by-products of nickel ore processing
 *   - **World's largest lagoon** (UNESCO World Heritage, 2nd largest coral reef system
 *     after the Great Barrier Reef) — major tourism and fisheries resource
 *   - **2024 political crisis** — riots over electoral reform (dégel du corps électoral),
 *     Kanak independence movement (FLNKS); significant damage to industrial facilities
 *
 * Bbox note:
 *   NC territory is an island chain with no land neighbours.
 *   NC_BBOX: minLat=-23.0, minLon=163.5, maxLat=-19.5, maxLon=168.5
 *   No antimeridian handling needed; no neighbour excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-nc.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'
import { NON_CGAZ_OWNERSHIP_BBOXES } from './lib/country-polygon.js'

// SSOT: the same bbox `makeAnyCountryGate` treats as an ownership area — if
// the two ever diverged, R14/heal-industrial-orphans would sweep legitimate
// NC stamps (Usine Koniambo was a round-3 false positive; #32).
const NC_BBOX = NON_CGAZ_OWNERSHIP_BBOXES.find((t) => t.iso2 === 'NC')!.bbox

await enrichGemIndustrial({
  countryCode: 'nc',
  countryName: "New Caledonia",
  bbox: NC_BBOX,
  // CGAZ has no NCL feature, so makeCountryGate('nc') throws. The bbox IS a
  // safe ownership gate (isolated archipelago) and is REGISTERED in
  // NON_CGAZ_OWNERSHIP_BBOXES so the orphan machinery honours it too.
  countryGate: (lat, lon) => inBbox(lat, lon, NC_BBOX),
})
