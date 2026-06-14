/**
 * Enrich KZ industrial with GEM Global Integrated Power (Kazakhstan filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Kazakhstan'):
 *     356 total / 201 operating / ~22.6 GW
 *     Operating fuel: coal 97 (DOMINANT — Soviet legacy: Ekibastuz-1 4,000 MW
 *                              8×500 = one of world's largest coal-fired plants
 *                              + Ekibastuz-2 1,000 MW + Aksu 1,935 MW),
 *                     oil/gas 36 (Atyrau/Mangystau Caspian corridor),
 *                     solar 35, wind 27 (recent renewables growth),
 *                     hydro 6 (Irtysh cascade: Shulbi 702 + Bukhtarma 675 +
 *                              Kapshagay 364 + Oskemen 331)
 *
 * Non-power industrial (OSM only):
 *   - **Tengiz oil** (Chevron/ExxonMobil — one of world's deepest super-giant
 *     oil fields, Atyrau region)
 *   - **Kashagan oil** (Caspian offshore — one of world's largest oil
 *     discoveries since 1960s, $55B development — world's most expensive
 *     oil project)
 *   - **Karachaganak gas** (Shell/ENI, Aksai)
 *   - **CPC pipeline** (Tengiz→Novorossiysk Russia)
 *   - **ArcelorMittal Temirtau** — integrated steel, formerly Karaganda
 *     Metallurgical Combine, one of the largest in CIS
 *   - **ENRC Kazchrome** — world's largest chromium producer (Aktobe/Khromtau)
 *   - **Uranium mining** — world's #1 producer: Kazatomprom ~43% of global
 *     supply (southern Kazakhstan in-situ leach operations)
 *   - **Baikonur Cosmodrome** — leased to Russia, world's first and largest
 *     space launch facility
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-kz.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into Russia/China/Kyrgyzstan/Uzbekistan/Turkmenistan).
const KZ_BBOX: readonly [number, number, number, number] = [40.5, 46.4, 55.5, 87.4]

await enrichGemIndustrial({
  countryCode: 'kz',
  countryName: "Kazakhstan",
  bbox: KZ_BBOX,
  isInside: makeCountryGate('KZ'),
})
