/**
 * Enrich SN industrial with GEM Global Integrated Power (Senegal filter).
 *
 * All Senegalese gov portals (AGEROUTE, ANSD, Senelec, Ministère de
 * l'Energie) publish corporate HTML only. GEM is the only machine-readable
 * source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Senegal'):
 *     40 total, 25 operating
 *     Operating fuel: solar 13, oil/gas 6, wind 4, coal 2
 *
 *   Top operating plants:
 *     Karpowership Aysegul Sultan 235 MW (Turkish floating powership off Dakar)
 *     Sendou 125 MW (coal, Bargny — Senegal's only coal plant)
 *     Malicounda 120 MW (oil/gas)
 *     Tobène 115 MW (oil/gas)
 *     Bel-Air C6 90 MW (Senelec thermal, Dakar)
 *     Cap des Biches 86 MW (Senelec diesel)
 *     Kounoune 68 MW (oil/gas)
 *     **Taiba N'Diaye Wind Farm 158 MW total** (West Africa's largest wind
 *     farm, opened 2020 — split across GEM into 3 entries: 55+55+48 MW)
 *     Léona Wind 50 MW
 *     Santhiou Mékhé Solar 30 MW
 *     Malicounda Solar 22 MW
 *     Senergy Solar 30 MW
 *
 * Non-power industrial (OSM only):
 *   - **SAR** (Société Africaine de Raffinage) refinery — Mbao/Dakar,
 *     27k bpd, Senegal's only oil refinery
 *   - **ICS** (Industries Chimiques du Sénégal) — phosphate + fertilizer
 *     complex at Taïba/Darou Khoudoss (world-class phosphate reserves)
 *   - **Ciments du Sahel**, **SOCOCIM** (LafargeHolcim) — cement
 *   - **GTA** offshore gas field (Grand Tortue Ahmeyim) — shared with
 *     Mauritania, Eni/BP/Kosmos, first LNG production 2024
 *   - Peanut processing (Senegal's traditional dominant crop)
 *   - Fishing/fish processing (Dakar, Mbour, Saint-Louis)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-sn.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const SN_BBOX: readonly [number, number, number, number] = [12.3, -17.6, 16.7, -11.3]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [16.0, -17.6, 16.7, -11.3],
  [12.3, -12.0, 16.7, -11.3],
  [12.3, -17.0, 12.7, -13.7],
  [12.3, -13.7, 12.7, -11.3],
]

await enrichGemIndustrial({
  countryCode: 'sn',
  countryName: "Senegal",
  bbox: SN_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, SN_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
