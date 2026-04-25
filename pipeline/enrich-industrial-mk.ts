/**
 * Enrich MK industrial with GEM Global Integrated Power (North Macedonia filter).
 *
 * Source:
 *   - **GEM Global Integrated Power** (Country_area='North Macedonia'):
 *     80 total / 48 operating / ~1.96 GW
 *     Coal 4 (REK Bitola 699 MW 3×233 lignite — ~70% of national generation,
 *             one of Balkans' most polluting; Oslomej 125),
 *     hydro 4 (Vardar basin: Vrutok 166 + Tikveš 114 + Špilje 84 + Kozjak 82),
 *     oil/gas 2 (Skopje CHP 220, Negotino 198),
 *     solar 36 (rapid growth), wind 2.
 *
 * NOTE: GEM uses 'North Macedonia' (Prespa Agreement 2018 name change from FYROM).
 *
 * Non-power industrial (OSM only):
 *   - **OKTA refinery** (Skopje, Hellenic Petroleum — only refinery, 40k bpd)
 *   - **Bucim copper-gold** (Radoviš — Solway)
 *   - **FENI ferronickel** (Kavadarci — major energy consumer)
 *   - **Usje cement** (Holcim, Skopje)
 *   - **Makstil steel** (Skopje — small)
 *   - **Wine**: Tikveš — one of Europe's largest wineries
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mk.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MK_BBOX: readonly [number, number, number, number] = [40.85, 20.4, 42.4, 23.05]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [42.35, 20.4, 42.4, 21.8],
  [42.0, 20.4, 42.4, 21.0],
  [40.85, 20.4, 42.4, 20.55],
  [40.85, 20.4, 41.0, 23.05],
  [40.85, 22.9, 42.4, 23.05],
]

await enrichGemIndustrial({
  countryCode: 'mk',
  countryName: "North Macedonia",
  bbox: MK_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MK_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
