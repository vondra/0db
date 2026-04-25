/**
 * Enrich MV industrial with GEM Global Integrated Power (Maldives filter).
 *
 * Maldives' STELCO (State Electric Company) publishes no open plant data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Maldives'):
 *     1 operating plant, ~50 MW total
 *
 *   Notable operating plants:
 *     **Male Power Station 50 MW** (diesel/HFO — Thilafushi Island industrial
 *       zone near Malé; main grid supply for Greater Malé area)
 *
 *   Additional distributed generation:
 *     Many inhabited islands have small diesel generators (1–5 MW each).
 *     Solar panels increasingly deployed on rooftops + island grids under
 *     MIRA/ADB programs; approx 50 MW solar installed across atolls by 2025.
 *
 * Non-power industrial (OSM only):
 *   - **Tourism infrastructure** — resort islands (200+ resorts); generator
 *     plants, desalination, cold storage; most luxury resorts are own-island
 *   - **Fishing/processing** — Maldives Industrial Fisheries Company (MIFCO);
 *     skipjack tuna canning plants in Felivaru, Kooddoo, Gemanafushi;
 *     Maldives is world's #1 pole-and-line tuna (MSC certified)
 *   - **Desalination** — critical infrastructure; Malé RO plant; every
 *     inhabited island has some water production
 *   - **Thilafushi** — industrial island near Malé; landfill island, boat
 *     building, storage, waste management; no residential
 *   - **Boat building** — traditional dhoni construction in Malé and atolls
 *   - **Garments** — small apparel factories (Malé) for domestic/export
 *
 * MV_BBOX: [minLat=-0.7, minLon=72.6, maxLat=7.1, maxLon=73.8]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-mv.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const MV_BBOX: readonly [number, number, number, number] = [-0.7, 72.6, 7.1, 73.8]

await enrichGemIndustrial({
  countryCode: 'mv',
  countryName: "Maldives",
  bbox: MV_BBOX,
})
