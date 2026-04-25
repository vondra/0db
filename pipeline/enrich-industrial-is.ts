/**
 * Enrich IS industrial with GEM Global Integrated Power (Iceland filter).
 *
 * 45 total / 34 operating / ~2.71 GW — 100% RENEWABLE (geothermal 24 + hydro
 * 10, ZERO fossil, ZERO nuclear, ZERO wind, ZERO solar in operating fleet —
 * unique globally!).
 *
 * Geothermal:
 *   Hellisheiði 303 MW (7 units) — world's 2nd largest geothermal plant,
 *                                   SW Iceland, supplies Reykjavík heat+power
 *   Reykjanes 130 MW — Reykjanes Peninsula, near Keflavík airport
 *   Nesjavellir 120 MW — near Þingvallavatn, NE of Reykjavík
 *   Þeistareykir 90 MW — NE Iceland, near Mývatn
 *   Svartsengi 101 MW — Reykjanes Peninsula (Blue Lagoon heated by waste water)
 *   Krafla 60 MW — NE Iceland, inside volcanic caldera
 *
 * Hydro:
 *   Fljótsdalur/Kárahnjúkar 690 MW — built for Alcoa aluminium smelter
 *                                     (controversial, flooded Icelandic highlands
 *                                     — Jökulsá á Dal diverted, Hálslón reservoir)
 *
 * Non-power industrial (OSM only):
 *   - **Alcoa Fjarðaál** (Reyðarfjörður, East Fjords) — 346 ktpa aluminium
 *     smelter, powered by Kárahnjúkar hydro. Built 2004–2008, controversial.
 *   - **Rio Tinto ISAL** (Hafnarfjörður, Capital Region) — 200 ktpa aluminium
 *   - **Century Aluminum Norðurál** (Grundartangi, Hvalfjörður) — 315 ktpa
 *   These 3 smelters consume ~75% of Iceland's total electricity generation.
 *   Iceland has HIGHEST per-capita electricity consumption in the world
 *   (~55,000 kWh/person — mostly absorbed by aluminium smelting).
 *   NO RAILWAY: Iceland has NEVER had a railway — only European country
 *   without any. Railway enrichment SKIPPED entirely.
 *
 * Source:
 *   - **GEM Global Integrated Power** (Country_area='Iceland'):
 *     data/enrichment/2025/is/power-plants-gem.geojson
 *
 * **Iceland is an island** in the North Atlantic — no neighbor-country
 * exclude zones needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-is.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const IS_BBOX: readonly [number, number, number, number] = [63.3, -24.6, 66.6, -13.4]

await enrichGemIndustrial({
  countryCode: 'is',
  countryName: "Iceland",
  bbox: IS_BBOX,
})
