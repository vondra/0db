/**
 * Enrich NG industrial with GEM Global Integrated Power (Nigeria filter).
 *
 * All Nigerian gov portals are useless for GIS: FERMA, NRC, NNPC, TCN are
 * WordPress/HTML-only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Nigeria'):
 *     289 total, **95 operating**
 *     Operating fuel breakdown:
 *       oil/gas: 75 (Egbin 6×220, Olorunsogo II 2×377, Afam VI 650,
 *                    Sapele, Geregu, Omotosho, Calabar NIPP, Alaoji,
 *                    Omoku, Okpai, Lekki Refinery 570)
 *       coal: 7
 *       solar: 7
 *       hydropower: 5 (**Kainji 760** — Nigeria's largest hydro,
 *                      **Zungeru 700**, **Shiroro 600**, **Jebba 578**,
 *                      Kiri)
 *       wind: 1
 *
 *   Top operating plants:
 *     Kainji 760 MW (hydro — Nigeria's largest)
 *     Zungeru 700 MW (hydro)
 *     Afam VI 650 MW (oil/gas CCGT)
 *     Shiroro 600 MW (hydro)
 *     Jebba 578 MW (hydro)
 *     Lekki Refinery 570 MW (oil/gas — Dangote complex self-consumption)
 *     Oando Kwale 480 MW
 *     Egbin 1,320 MW total (6×220 MW gas)
 *
 * Non-power industrial (OSM only, not in GEM):
 *   - **Dangote Refinery Lekki** (650k bpd) — **Africa's largest refinery**,
 *     opened 2023
 *   - **NNPC refineries**: Port Harcourt (210k bpd, restart 2024),
 *     Warri (125k bpd mostly non-operational), Kaduna (110k bpd)
 *   - **NLNG Bonny Island** (6 LNG trains + Train 7 planned)
 *   - **Dangote Cement** (multiple plants: Obajana, Ibese, Gboko)
 *   - **BUA Cement**, **Lafarge Cement** (Ewekoro, Sagamu, Calabar)
 *   - **Ajaokuta Steel** (largely inoperative)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ng.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const NG_BBOX: readonly [number, number, number, number] = [4.0, 2.7, 13.9, 14.7]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [6.0, 2.7, 12.5, 3.5],
  [13.0, 2.7, 13.9, 14.0],
  [11.5, 13.5, 13.9, 14.7],
  [4.0, 13.0, 11.0, 14.7],
]

await enrichGemIndustrial({
  countryCode: 'ng',
  countryName: "Nigeria",
  bbox: NG_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, NG_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
