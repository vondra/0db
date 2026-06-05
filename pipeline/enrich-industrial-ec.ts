/**
 * Enrich EC industrial with GEM Global Integrated Power (Ecuador filter).
 *
 * Source: GEM Global Integrated Power v1 (Country_area='Ecuador'):
 *   165 plants total, 70 operating
 *   Fuel breakdown (operating): hydro 34, solar 18, oil/gas 14, bioenergy 2, wind 2
 *
 *   Ecuador's power fleet is dominated by hydropower (~70% of generation)
 *   with Coca Codo Sinclair 1,500 MW + Paute cascade (Paute Molino 1,075 MW
 *   + Sopladora 487 MW + Mazar 170 MW) + other CELEC EP plants.
 *
 *   Top operating:
 *     Coca Codo Sinclair 1,500 MW (Napo, CELEC EP, China-built)
 *     Paute Molino 1,075 MW (Azuay, CELEC EP)
 *     Sopladora 487 MW (Morona Santiago, CELEC EP)
 *     Minas San Francisco 276 MW (Azuay, CELEC EP)
 *     San Francisco 230 MW (Tungurahua, CELEC EP)
 *     Marcel Laniado 213 MW (Guayas, CELEC EP)
 *     Toachi-Alluriquin 204 MW (Pichincha/Santo Domingo)
 *     Delsitanisagua 180 MW (Zamora-Chinchipe)
 *     Mazar 170 MW (Azuay, CELEC EP)
 *     Agoyán 160 MW (Tungurahua)
 *
 * Mining: ARCOM/ARCOM concession mirrors are DEAD (community mirrors deleted).
 * Major mines (Mirador copper, Fruta del Norte gold) rely on OSM coordinates.
 *
 * Refineries (Petroecuador):
 *   Esmeraldas refinery ~110,000 bpd (Esmeraldas, Coastal)
 *   La Libertad refinery ~45,000 bpd (Santa Elena, Coastal)
 *   Shushufindi refinery (Sucumbíos, Amazon oilfield)
 * These are currently tagged via OSM as `landuse=industrial` without
 * explicit refinery NACE classification.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ec.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const EC_BBOX: readonly [number, number, number, number] = [-5.0, -81.1, 1.5, -75.0]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.5, -79.5, 1.5, -75.0],
  [-18.4, -81.5, -4.9, -69.0],
]

await enrichGemIndustrial({
  countryCode: 'ec',
  countryName: "Ecuador",
  bbox: EC_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, EC_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
