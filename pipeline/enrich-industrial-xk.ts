/**
 * Enrich XK industrial with GEM Global Integrated Power (Kosovo filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Kosovo'):
 *     35 total / 11 operating / ~1.44 GW
 *
 *   Coal (Kosovo A+B complex — Obiliq lignite near Pristina):
 *     **Kosovo A** 610 MW (3 units) + **Kosovo B** 680 MW (2 units) =
 *     **1,290 MW combined** — ONE OF EUROPE'S MOST POLLUTING power complexes,
 *     ~97% of Kosovo's electricity, one of the worst air quality sites in Europe.
 *     Kosovo has world's 5th largest lignite reserves (~14.7 Bt), most unextracted.
 *
 *   Wind:
 *     **Bajgora** 103 MW + **Kitka** 32 MW
 *
 *   Solar: 4 plants
 *
 * Non-power industrial (OSM only):
 *   - **Trepča mining complex** (lead/zinc/silver — Mitrovica): historic
 *     Yugoslav-era, state-owned post-independence, divided between
 *     Serb+Albanian-controlled parts
 *   - **Ferronikeli ferronickel** (Glogovac/Drenas): closed 2015, partly
 *     restarting
 *   - **Sharrcem cement** (Hani i Elezit): Holcim subsidiary
 *
 * NOTE: GEM lists as 'Kosovo' (not Republic of Kosovo or XK).
 *       Disputed territory — partially recognized.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-xk.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const XK_BBOX: readonly [number, number, number, number] = [41.85, 20.0, 43.3, 21.8]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [43.25, 20.0, 43.3, 21.8],
  [42.3, 20.0, 43.25, 20.15],
  [41.85, 20.0, 42.3, 20.3],
  [41.85, 20.0, 42.0, 21.8],
]

await enrichGemIndustrial({
  countryCode: 'xk',
  countryName: "Kosovo",
  bbox: XK_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, XK_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
