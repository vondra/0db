/**
 * Enrich UY industrial with GEM Global Integrated Power (Uruguay filter).
 *
 * Source: GEM Global Integrated Power v1 (Country_area='Uruguay'):
 *   78 total, 73 operating
 *   Operating fuel breakdown:
 *     wind        35 (Uruguay has world's highest wind penetration per capita)
 *     solar       19
 *     oil/gas     10
 *     bioenergy    6 (all 3 pulp mills present)
 *     hydropower   3 (Salto Grande shared with Argentina)
 *
 *   Top operating:
 *     Punta del Tigre B 540 MW oil/gas CCGT (2019)
 *     Constitución/Palmar 333 MW hydro (1982, Río Negro)
 *     UPM Paso de los Toros 2×155 MW bioenergy (2023, UPM2 pulp mill — fed
 *       by the new Ferrocarril Central railway 273 km to Montevideo port)
 *     Rincón del Bonete 152 MW hydro (1945, Gabriel Terra, Río Negro)
 *     Pampa Nordex 142 MW wind (2016)
 *     Rincón de Baygorria 108 MW hydro (1960, Río Negro)
 *     UTE Central Termica La Tablada 2×106 MW oil/gas (1992)
 *     Montes del Plata 2×90 MW bioenergy (2014, Conchillas on Río de la Plata,
 *       joint venture Stora Enso + Arauco)
 *     UPM Fray Bentos 80 MW bioenergy (2007, UPM1 pulp mill on Río Uruguay)
 *
 * Note: Salto Grande (1,890 MW) is shared 50/50 with Argentina. It's in GEM
 * but may be filtered out here depending on which Country_area GEM assigns it.
 *
 * All operating plants map to NACE 35 (Electricity generation). Pulp mills
 * should also be classified as NACE 17 (Paper/pulp manufacturing) but GEM
 * only captures the power generation side.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-uy.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const UY_BBOX: readonly [number, number, number, number] = [-35.0, -58.5, -30.0, -53.0]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-35.0, -60.0, -30.0, -58.0],
  [-30.0, -58.5, -27.0, -53.0],
]

await enrichGemIndustrial({
  countryCode: 'uy',
  countryName: "Uruguay",
  bbox: UY_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, UY_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
