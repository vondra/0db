/**
 * Enrich PA industrial with GEM Global Integrated Power (Panama filter).
 *
 * ASEP (Autoridad Nacional de los Servicios Públicos) and ETESA publish some
 * plant data but not as open machine-readable geospatial. GEM is the most
 * complete machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Panama'):
 *     70 operating plants, ~3,711 MW total
 *
 *   Notable operating plants:
 *     **Fortuna hydro 300 MW**           (hydro — Chiriquí, Barú watershed; IBD-backed 1984)
 *     **Bayano hydro 260 MW**            (hydro — Río Bayano, Chepo; reservoir near Panama City)
 *     **Chan 75 hydro 222 MW**           (hydro — Bocas del Toro, PROISA; ITAIPU-era tech)
 *     **Barro Blanco hydro 28 MW**       (hydro — Río Tabasará, Chiriquí; controversial)
 *     **AES Chiriquí hydro 80 MW**       (hydro — Río Chiriquí, David area; AES Corp)
 *     **Costa Norte LNG 381 MW**         (gas — Bahía Las Minas, Colón; AES; main peaker)
 *     **Bahía Las Minas thermal 300 MW** (HFO — Colón; reserve + Canal ship power)
 *     **Las Minas solar ~100 MW**        (solar — Veraguas lowlands)
 *     **Monte Lirio hydro 59 MW**        (hydro — Bocas del Toro, San Lorenzo)
 *     **Bajo de Mina wind ~80 MW**       (wind — Veraguas coast, Guanico ridge)
 *
 * Non-power industrial (OSM only):
 *   - **Panama Canal** — world's most important shipping waterway; Panama Canal
 *     Authority (ACP); 14,000+ transits/year; third lane expansion completed 2016;
 *     Panamax/New Panamax locks; Gatún Lake is the reservoir
 *   - **Logistics/Ports** — Colón Free Zone (CFZ, world's #2 free trade zone after
 *     Hong Kong); Manzanillo, Cristóbal, Balboa, Pacific ports; DP World Balboa
 *   - **Banking** — Panama City financial center; >80 banks; Panamá papers center
 *   - **Copper mining** — Cobre Panamá (First Quantum, Minera Panamá); Donoso,
 *     Colón; ~320,000 tons Cu/year; largest new mine in Western Hemisphere (2023);
 *     ***Note: suspended Dec 2023 by Supreme Court following protests***
 *   - **Banana** — Bocas del Toro (CHIQUITA/Fyffes Armuelles legacy, mostly
 *     abandoned); Chiriquí (Barú, Gualaca); limited production now
 *   - **Sugar** — La Villa (Herrera province, INGENIO LA VICTORIA); some ethanol
 *   - **Shrimp** — Gulf of Chiriquí and Gulf of Panama; export to US/EU
 *   - **Coffee** — Boquete (Chiriquí Highlands, Volcán Barú); Geisha variety
 *     origin; world's most expensive coffee auction prices; specialty market
 *
 * PA_BBOX: [minLat=7.2, minLon=-83.1, maxLat=9.7, maxLon=-77.1]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-pa.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const PA_BBOX: readonly [number, number, number, number] = [7.2, -83.1, 9.7, -77.1]

await enrichGemIndustrial({
  countryCode: 'pa',
  countryName: "Panama",
  bbox: PA_BBOX,
})
