/**
 * Enrich KM industrial with GEM Global Integrated Power (Comoros filter).
 *
 * Comoros' MA-MWE (public utility) publishes no open plant data. GEM is the
 * only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Comoros'):
 *     1 operating plant, ~3 MW total
 *
 *   Notable operating plants:
 *     **Vwadézi Power Station 3 MW** (diesel — Moroni, Grande Comore;
 *       MA-MWE operated; main grid supply; very unreliable power supply,
 *       frequent outages are a major economic constraint)
 *
 *   Additional distributed generation:
 *     Small diesel generators on Anjouan and Mohéli; EU-funded solar
 *     installations (approx 3 MW total by 2025 under various aid projects).
 *     Karthala volcano geothermal potential studied but undeveloped.
 *
 * Non-power industrial (OSM only):
 *   - **Ylang-ylang distillation** — Comoros is the world's #1 producer
 *     (~80% of global supply); essential oil used in Chanel No. 5 and other
 *     luxury perfumes; distilleries on Grande Comore and Anjouan; small
 *     family-scale and cooperative operations; ~50 tonnes/year oil
 *   - **Vanilla** — Comoros is among world's top vanilla producers;
 *     Anjouan island specializes; Bourbon vanilla variety
 *   - **Cloves** — significant export; Anjouan and Mohéli; Indonesia
 *     competition has reduced volume
 *   - **Fishing** — tuna, grouper, lobster; artisanal; Moroni fish market;
 *     no industrial scale processing
 *   - **Beverages** — Colas Comores (soft drinks), limited local brewing
 *   - **Construction materials** — volcanic rock quarrying (Grande Comore);
 *     coral sand (regulated) for construction
 *   - **Food processing** — manioc flour mills, coconut processing; subsistence
 *
 * KM_BBOX: [minLat=-12.5, minLon=43.2, maxLat=-11.3, maxLon=44.5]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-km.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const KM_BBOX: readonly [number, number, number, number] = [-12.5, 43.2, -11.3, 44.5]

await enrichGemIndustrial({
  countryCode: 'km',
  countryName: "Comoros",
  bbox: KM_BBOX,
})
