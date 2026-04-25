/**
 * Enrich SR industrial with GEM Global Integrated Power (Suriname filter).
 *
 * EBS (Energie Bedrijven Suriname) and the Ministry of Natural Resources
 * publish no open machine-readable plant data. GEM is the only usable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Suriname'):
 *     4 operating plants, ~250 MW total
 *
 *   Notable operating plants:
 *     **Afobaka hydroelectric 189 MW** (hydro — Brokopondo Reservoir / Suriname River;
 *                                       built 1964 by ALCOA for Suralco aluminium smelter;
 *                                       the reservoir flooded ~1% of Surinamese territory,
 *                                       displacing ~6000 Saramaka Maroons)
 *     **Saramacca thermal 36 MW**      (HFO — near Paramaribo)
 *     **Staatsolie refinery CHP**      (oil — Paranam; Suriname state oil company)
 *     **Lelydorp solar**               (solar — near Johan Adolf Pengel International Airport)
 *
 * Non-power industrial (OSM only):
 *   - **Bauxite / alumina** — historically dominant; Suralco (ALCOA subsidiary)
 *     operated Paranam alumina refinery; most bauxite mining now suspended
 *     following ALCOA withdrawal 2015; legacy tailings ponds at Paranam
 *   - **Gold mining** — Suriname is a major gold producer; Newmont Merian mine
 *     (Marowijne district, 450+ koz/year); IAMGOLD Rosebel mine (Brokopondo);
 *     artisanal/small-scale mining (kapiteins, Brazilian garimpeiros) widespread
 *     in interior — serious environmental concern (mercury)
 *   - **Petroleum** — Staatsolie (state company) onshore fields (Saramacca);
 *     TotalEnergies offshore Block 58 exploration (major 2020 discovery)
 *   - **Timber** — tropical hardwood (low volume, sustainable certifications)
 *   - **Agriculture** — rice (Nickerie district, largest in country); bananas
 *     (Wageningen, Suriname Landbouw Maatschappij); palm oil
 *   - **Rum / spirits** — Mariënburg rum (historical); Black Cat rum
 *
 * SR_BBOX: [minLat=1.8, minLon=-58.1, maxLat=6.0, maxLon=-53.9]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-sr.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SR_BBOX: readonly [number, number, number, number] = [1.8, -58.1, 6.0, -53.9]

await enrichGemIndustrial({
  countryCode: 'sr',
  countryName: "Suriname",
  bbox: SR_BBOX,
})
