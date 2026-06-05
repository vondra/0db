/**
 * Enrich LI industrial with GEM Global Integrated Power (Liechtenstein filter).
 *
 * GEM reports 0 operating power plants for Liechtenstein.
 * Script is a no-op for GEM matching but scans OSM industrial for completeness.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Liechtenstein'):
 *     0 operating plants
 *     (Liechtenstein imports all electricity from Switzerland and Austria)
 *
 * Non-power industrial (OSM only):
 *   - **Banking/finance** — major wealth management hub; ~70k companies registered
 *     for ~39k residents; LGT Group (princely family), LLB, VP Bank
 *   - **Manufacturing** — Hilti (power tools, HQ in Schaan), ThyssenKrupp Presta
 *     (automotive steering, Eschen), Ivoclar Vivadent (dental, Schaan)
 *   - **Precision instruments** — high-value manufacturing, watches, dental equipment
 *   - **Construction** — urban development in Rhine Valley floor (Vaduz, Schaan, Balzers)
 *   - Note: LI bbox overlaps Switzerland and Austria; skip-existing handles overlap.
 *
 * LI_BBOX: [minLat=47.05, minLon=9.47, maxLat=47.27, maxLon=9.64]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-li.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const LI_BBOX: readonly [number, number, number, number] = [47.05, 9.47, 47.27, 9.64]

await enrichGemIndustrial({
  countryCode: 'li',
  countryName: "Liechtenstein",
  bbox: LI_BBOX,
})
