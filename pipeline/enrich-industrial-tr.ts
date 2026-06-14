/**
 * Enrich TR industrial with GEM Global Integrated Power (Türkiye filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Türkiye'):
 *     1451 total / 1049 operating / ~91 GW — LARGEST fleet of any enriched country.
 *     Operating fuel: wind 373 (!), solar 323, hydropower 117, oil/gas 88,
 *     coal 78, geothermal 68 (Turkey #4 globally in geothermal), bioenergy 2.
 *
 *   Top operating plants:
 *     **Atatürk 2,405 MW** (Euphrates — GAP project, Şanlıurfa)
 *     **Karakaya 1,800 MW** (Euphrates, Adıyaman)
 *     **Keban 1,330 MW** (Euphrates, Elazığ)
 *     **Ilısu 1,209 MW** (Tigris, Şırnak — 2020, controversial displacement)
 *     **Karapınar YEKA Solar 1,079 MW** (Konya — one of world's largest solar farms)
 *     Gas CCGT fleet: Bandırma, Yahşihan, Erzin, Antalya, Aliağa, Gebze, Ambarlı
 *     Coal: Afşin-Elbistan lignite complex (2,800+ MW total, Kahramanmaraş),
 *           Çatalağzı (Zonguldak), ISKEN Sugözü (Adana)
 *
 * Non-power industrial (OSM only):
 *   - **Erdemir** (Ereğli, Zonguldak — Turkey's largest steel plant, ~3 MT/yr)
 *   - **İskenderun steel** (İskenderun, Hatay — İsdemir/Erdemir group)
 *   - **TÜPRAŞ** (Turkey's only refinery group — 4 refineries: İzmit, İzmir/Aliağa,
 *     Kırıkkale, Batman — 28 MT/yr total capacity)
 *   - **Automotive belt**: Bursa (Tofaş/Fiat, Renault/Oyak), Kocaeli (Ford Otosan),
 *     Sakarya (Toyota), İstanbul (Karsan, Anadol Isuzu)
 *   - **Cement**: Oyak, Sabancı, LafargeHolcim plants nationwide
 *   - **Textiles**: İstanbul, Gaziantep, Denizli, Bursa (export-oriented)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-tr.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox stays for the hex-shortlist; the per-site test is the actual-polygon gate
// (hand-tuned EXCLUDE_ZONES bled into neighbours along the bbox edges).
const TR_BBOX: readonly [number, number, number, number] = [35.8, 25.6, 42.2, 44.8]

await enrichGemIndustrial({
  countryCode: 'tr',
  countryName: "Türkiye",
  bbox: TR_BBOX,
  isInside: makeCountryGate('TR'),
})
