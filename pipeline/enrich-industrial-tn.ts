/**
 * Enrich TN industrial with GEM Global Integrated Power (Tunisia filter).
 *
 * Tunisian gov portals (STEG, Ministère de l'Environnement, Ministère de
 * l'Industrie) publish HTML/corporate sites only. INS (Institut National de
 * la Statistique) has socio-economic data but not facility-level. GEM is the
 * only machine-readable source for power infrastructure.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Tunisia'):
 *     80 total, 39 operating
 *     Operating fuel: oil/gas 27, wind 6, solar 6
 *     — Largest operating fleet of any African country enriched so far
 *
 *   Top operating plants:
 *     **Rades II+C 930 MW** (Tunis port — Tunisia's largest thermal cluster)
 *     **Rades A+B 700 MW** (older units at same complex)
 *     **Sousse A+B+C+D 1,525 MW** (Sousse coastal thermal — 4 phases)
 *     **Ghannouch 400 MW** (Gabès industrial zone CCGT)
 *     **Mornaguia 624 MW** (combined heat+power, near Tunis)
 *     **Bir Mcherga 256 MW** (Zaghouan, peak-load turbines)
 *     **Bouchemma 250 MW** (Gabès region)
 *     **Thyna 246 MW** (Sfax industrial zone)
 *     **Sidi Daoud Wind** (Cap Bon peninsula — Tunisia's first wind farm)
 *     **Bizerte wind** (Metline)
 *     **Borj Bourguiba Solar**, **Tozeur Solar**
 *
 * **Tunisia's generation is ~94% natural gas**, mostly from STEG-owned plants.
 * Imports ~50% of gas from Algeria via Transmed pipeline + 15% royalty on
 * Algeria↔Italy gas transit.
 *
 * Non-power industrial (OSM only):
 *   - **STIR** (Société Tunisienne des Industries de Raffinage) — Bizerte,
 *     ~34k bpd, Tunisia's only oil refinery
 *   - **Gafsa phosphate corridor** — CPG (Compagnie des Phosphates de Gafsa),
 *     world's #5 phosphate producer at Metlaoui/Redeyef/Mdhilla
 *   - **GCT Gabès** (Groupe Chimique Tunisien) — phosphoric acid / DAP
 *     fertilizer complex, one of Africa's largest chemical sites (major
 *     environmental contamination concerns)
 *   - **Cement**: Ciments de Bizerte, Carthage Cement (Djebel Ressas),
 *     Ciments d'Oum El Kélil (Tajerouine), CIOK, Les Ciments de Gabès
 *   - **Steel**: El Fouladh (Menzel Bourguiba)
 *   - **Offshore oil**: Ashtart, El Bibane, Didon, Cercina, Miskar gas
 *     (BG/Shell, TOTAL)
 *   - **Tataouine gas fields** (Adam, Oued Zar, El Borma)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-tn.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const TN_BBOX: readonly [number, number, number, number] = [30.2, 7.5, 37.6, 11.6]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [30.2, 7.5, 37.6, 8.15],
  [30.2, 9.5, 32.0, 11.6],
]

await enrichGemIndustrial({
  countryCode: 'tn',
  countryName: "Tunisia",
  bbox: TN_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, TN_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
