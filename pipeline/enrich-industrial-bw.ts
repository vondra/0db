/**
 * Enrich BW industrial with GEM Global Integrated Power (Botswana filter).
 *
 * Botswana gov portals (DRTS/MoTC, BPC, Ministry of Minerals and Energy,
 * DEA) publish corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Botswana'):
 *     59 total, 13 operating, ~820 MW
 *     Operating fuel: coal 8, solar 4, oil/gas 1
 *
 *   Top operating plants:
 *     **Morupule B 600 MW** (4×150 MW coal, opened 2012 — Botswana's
 *                             largest plant, plagued by technical problems
 *                             since commissioning. Chinese-built by China
 *                             National Electric Equipment Corporation)
 *     **Morupule A 132 MW** (4×33 MW coal, 1986, upgraded 2008)
 *     **Francistown APR 70 MW** (diesel emergency rental, Aggreko)
 *     **Kweneng/Central/NW/Gaborone Solar** (4 small solar plants, 1-11 MW)
 *
 * **Botswana imports ~40% of electricity** from South Africa (Eskom) and
 * Mozambique. **Morupule B chronic technical problems** have made the
 * country even more import-dependent.
 *
 * Non-power industrial (OSM only):
 *   - **Jwaneng Diamond Mine** (Jwaneng, S Botswana) — **world's richest
 *     diamond mine by value**, De Beers/Debswana JV (50% De Beers + 50%
 *     Government of Botswana). The single economic asset that transformed
 *     Botswana from one of Africa's poorest at independence (1966) to
 *     one of its wealthiest.
 *   - **Orapa Diamond Mine** (Orapa, central) — **world's largest diamond
 *     mine by area** (world's 2nd largest open pit)
 *   - **Letlhakane Diamond Mine** (near Orapa) — Debswana
 *   - **Karowe Diamond Mine** (Letlhakane) — Lucara Diamond (world's 2nd
 *     largest gem diamond Lesedi La Rona 1,109ct found here 2015)
 *   - **Morupule Coal Mine** — Debswana/Minergy, feeds Morupule A+B plants
 *   - **BCL Selebi-Phikwe** — nickel/copper smelter+mine complex,
 *     **closed 2016** after commodity collapse. Selebi-Phikwe town was
 *     purpose-built for this mine (1973-2016, ~45 year lifespan).
 *   - **Gaborone industrial** — Kgale Glass, BMC (Botswana Meat Commission)
 *   - **Cement**: PPC Botswana (Gaborone)
 *   - **Soda ash**: Botswana Ash (Sua Pan, Makgadikgadi — world's largest
 *     soda ash deposit by area, mining since 1991)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-bw.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const BW_BBOX: readonly [number, number, number, number] = [-26.9, 19.9, -17.8, 29.4]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-26.9, 19.9, -17.8, 21.0],
  [-18.5, 21.0, -17.8, 25.3],
  [-22.0, 27.5, -17.8, 29.4],
  [-26.9, 24.0, -25.2, 29.4],
  [-26.9, 19.9, -24.5, 24.0],
]

await enrichGemIndustrial({
  countryCode: 'bw',
  countryName: "Botswana",
  bbox: BW_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, BW_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
