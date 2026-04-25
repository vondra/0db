/**
 * Enrich ML industrial with GEM Global Integrated Power (Mali filter).
 *
 * All Mali government portals (EDM, Ministère de l'Énergie, AMADER) publish
 * corporate HTML only. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mali'):
 *     14 operating plants, ~847 MW total
 *     Operating fuel: hydro 4, oil/gas (HFO/diesel) 3, solar 7
 *
 *   Top operating plants:
 *     **Manantali 200 MW** (hydropower — Manantali Dam, Bafing River; shared
 *                           with Senegal/Mauritania via OMVS, largest ML hydro)
 *     **Gouina 140 MW** (hydropower — Senegal River, new IPP)
 *     **Sirakoro 100 MW** (HFO thermal — near Bamako, EDM main thermal plant)
 *     **Kayes 90 MW** (diesel — Kayes city, western Mali)
 *     **Fekola Mine 64 MW** (HFO/diesel captive — B2Gold Fekola gold mine)
 *     **Felou 62 MW** (hydropower — Senegal River, OMVS run-of-river)
 *     **Akuo Kita Solar 50 MW** (solar — Kita, IPP)
 *     **Selingue 48 MW** (hydropower — Sankarani River)
 *     **Loulo-Gounkoto Solar 40+20 MW** (solar — Barrick gold complex, captive)
 *     **Fekola Solar 30 MW** (solar — B2Gold Fekola, captive hybrid)
 *     **3 tiny solar ~1 MW each** (rural/peri-urban IPPs)
 *
 * Non-power industrial (OSM only):
 *   - **Gold mining** — Mali is Africa's #3 gold producer:
 *       Loulo-Gounkoto (Barrick — one of Africa's largest gold complexes),
 *       Fekola (B2Gold, Kayes region), Sadiola (Barrick/AngloGold), Morila,
 *       Kalana, Syama (Resolute Mining)
 *   - **CMDT cotton** — Compagnie Malienne pour le Développement du Textile;
 *     Mali is Africa's #2 cotton producer; gins at Koutiala, Sikasso, Fana
 *   - **Cement**: CIMAF Dio (Bamako), Diamond Cement Astro (Bamako)
 *   - **Bamako port** (Niger River — limited river freight)
 *   - **No significant manufacturing** — economy is agriculture (cotton, gold,
 *     livestock); most consumer goods imported
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ml.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const ML_BBOX: readonly [number, number, number, number] = [10.0, -12.3, 25.0, 4.3]

await enrichGemIndustrial({
  countryCode: 'ml',
  countryName: "Mali",
  bbox: ML_BBOX,
})
