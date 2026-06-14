/**
 * Enrich UA industrial with GEM Global Integrated Power (Ukraine filter).
 *
 * NOTE: Ukraine has been under Russian invasion since February 2022.
 * This enrichment represents **pre-war baseline** data from GEM.
 * Actual noise conditions in occupied/frontline areas are drastically different.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Ukraine'):
 *     811 total / 615 operating / ~34.1 GW
 *     MASSIVE solar buildout: 522 solar plants.
 *     Nuclear 15 (13,000 MW — Europe's 3rd largest nuclear fleet):
 *       Zaporizhzhia 6,000 MW — RUSSIAN-OCCUPIED since March 2022,
 *         Europe's largest nuclear plant, world's most dangerous nuclear situation.
 *       Khmelnitski 2,000 MW
 *       Rivne 2,000 MW
 *       South Ukraine 3,000 MW
 *     Coal 25, gas 25, wind 18.
 *     Hydro 10 (Dnipro cascade):
 *       Dnister pumped-storage 1,296 MW
 *       Dnipro-2 888 MW
 *       Kremenchuk 700 MW
 *       Kaniv 493 MW
 *       NOTE: Kakhovka Dam DESTROYED June 2023 by Russia — catastrophic flooding.
 *     ONGOING WAR — many plants damaged, destroyed, or occupied.
 *
 *   Non-power industrial (OSM only):
 *     - ArcelorMittal Kryvyi Rih (steel)
 *     - Metinvest Mariupol — Azovstal DESTROYED in 2022 siege
 *     - Zaporizhstal (steel, frontline city)
 *     - Naftogaz / UKRNAFTA (oil/gas)
 *     - Energoatom (nuclear operator)
 *     - Kremenchuk refinery — DESTROYED by Russian strikes
 *     - Lysychansk refinery — DESTROYED
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ua.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into neighbours along the bbox edges).
const UA_BBOX: readonly [number, number, number, number] = [44.3, 22.1, 52.4, 40.3]

await enrichGemIndustrial({
  countryCode: 'ua',
  countryName: "Ukraine",
  bbox: UA_BBOX,
  isInside: makeCountryGate('UA'),
})
