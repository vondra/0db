/**
 * Enrich ME industrial with GEM Global Integrated Power (Montenegro filter).
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Montenegro'):
 *     40 total / 6 operating / ~995 MW. Tiny fleet.
 *     Hydro 2 (Mratinje/Piva 342 MW — dam in one of Europe's deepest canyons,
 *             220m; Perućica 307 MW — one of Europe's oldest preserved hydro),
 *     coal 1 (Pljevlja 225 MW — ONLY thermal, one of Europe's most polluting
 *             per capita),
 *     wind 2 (Krnovo 72 MW + Možura 46 MW),
 *     solar 1.
 *
 * Non-power industrial (OSM only):
 *   - **KAP Podgorica** (aluminium smelter, Kombinat Aluminijuma Podgorica) —
 *     one of Europe's largest; consumes ~40% of Montenegro's electricity!
 *     Major environmental concern, chronic financial crisis.
 *   - **Nikšić steel** (formerly Željezara Nikšić) — only steel plant,
 *     rebranded as Toščelik after Turkish acquisition.
 *   - **Port of Bar** — Montenegro's only sea port (Adriatic); endpoint of the
 *     famous Belgrade-Bar scenic railway; handles bulk cargo and passengers.
 *   - **Pljevlja coal mine** — feeds the Pljevlja TPP directly; open-cast
 *     lignite, operated by Rudnik Uglja AD.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-me.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const ME_BBOX: readonly [number, number, number, number] = [41.85, 18.4, 43.6, 20.4]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [43.45, 18.4, 43.6, 20.4],
  [42.7, 18.4, 43.6, 18.6],
  [41.85, 18.4, 42.0, 20.4],
  [42.3, 20.3, 43.6, 20.4],
]

await enrichGemIndustrial({
  countryCode: 'me',
  countryName: "Montenegro",
  bbox: ME_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, ME_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
