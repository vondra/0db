/**
 * Enrich BY industrial with GEM Global Integrated Power (Belarus filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Belarus'):
 *     105 total / 93 operating / ~11.9 GW
 *     Operating fuel: gas/oil 67, solar 24, nuclear 2
 *
 *   Top operating plants:
 *     **Astravets NPP 2,388 MW** (2× VVER-1200, Grodno oblast —
 *                                  Russia-built 2020/2023, HIGHLY CONTROVERSIAL —
 *                                  only 50 km from Vilnius; Lithuania, Poland and
 *                                  the EU raised severe safety concerns; Lithuania
 *                                  has refused to import its power)
 *     **Lukoml GRES ~2,800 MW** (7 units, Novolukoml, Vitebsk oblast —
 *                                  Belarus's largest thermal plant, Soviet-era
 *                                  modernized gas/oil fired)
 *     **Minsk CHP-5 720 MW** + **CHP-4 250 MW** (Minsk combined heat + power)
 *     **Bereza GRES 427 MW** (Brest oblast, gas)
 *
 * Non-power industrial (OSM only):
 *   - **Mozyr refinery** (OAO Mozyrsky NPZ, Gomel oblast — 240k bpd,
 *     fed by Druzhba pipeline Russian crude)
 *   - **Naftan refinery** (Novopolotsk, Vitebsk — 220k bpd, Druzhba crude)
 *   - **Belaruskali** (Soligorsk, Minsk oblast — world's 2nd largest potash
 *     producer after Saskatchewan/Nutrien; 5 operating mines)
 *   - **BelAZ** (Zhodino, Minsk oblast — world's largest dump trucks,
 *     450-ton capacity; major export product)
 *   - **MAZ trucks** (Minsk — heavy trucks and buses)
 *   - **BMZ steel** (Zhlobin, Gomel oblast — electric arc furnace steel)
 *   - **Grodno Azot** (Grodno — nitrogen fertilizer, ammonia)
 *   - **Belarusneft** (Rechitsa area — domestic oil production)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-by.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const BY_BBOX: readonly [number, number, number, number] = [51.2, 23.1, 56.2, 32.8]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [51.2, 32.5, 56.2, 32.8],
  [51.2, 23.1, 51.5, 32.8],
  [51.2, 23.1, 56.2, 23.5],
  [54.5, 23.1, 56.2, 26.0],
  [55.8, 23.1, 56.2, 32.8],
]

await enrichGemIndustrial({
  countryCode: 'by',
  countryName: "Belarus",
  bbox: BY_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, BY_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
