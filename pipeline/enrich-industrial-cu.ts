/**
 * Enrich CU industrial with GEM Global Integrated Power (Cuba filter).
 *
 * Cuba's power sector is almost entirely state-owned (Unión Eléctrica de Cuba).
 * Soviet-era thermoelectric plants dominate — aging oil-fired steam turbines.
 * GEM is the only machine-readable open source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Cuba'):
 *     ~38 operating plants, ~2,891 MW total
 *
 *   Top operating plants:
 *     **Mariel** (oil — 500 MW, Artemisa province; 22.98°N, 82.74°W)
 *     **Felton** (oil — 500 MW, Holguín province; 20.71°N, 75.31°W)
 *     **Antonio Guiteras** (oil — 500 MW, Matanzas; 23.09°N, 81.57°W)
 *     **Máximo Gómez** (oil — 235 MW, Mariel area; 22.97°N, 82.78°W)
 *     **Ernesto Guevara** (oil — 160 MW, Santa Clara; 22.44°N, 79.96°W)
 *     **Carlos Manuel de Céspedes** (oil — 300 MW, Cienfuegos; 22.13°N, 80.42°W)
 *     Scattered small solar (<10 MW each) and wind (Gibara, ~50 MW).
 *
 * Non-power industrial (OSM only):
 *   - **Sugar**: historically world's largest exporter; ~10 active mills remain
 *   - **Nickel**: Moa (Sherritt International joint venture) — top Cuban export
 *   - **Tobacco**: Cohiba, Montecristo cigars; Las Villas and Vuelta Abajo leaf
 *   - **Rum**: Havana Club (Pernod Ricard / Cuba Ron S.A.), Santiago de Cuba rum
 *   - **Cement**: Cienfuegos, Mariel cement plants
 *   - **Pharmaceuticals**: Cuba's biotech sector (Centro de Ingeniería Genética)
 *
 * CU is an island — no neighbor-border excludes needed.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-cu.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const CU_BBOX: readonly [number, number, number, number] = [19.8, -85.0, 23.3, -74.1]

await enrichGemIndustrial({
  countryCode: 'cu',
  countryName: "Cuba",
  bbox: CU_BBOX,
})
