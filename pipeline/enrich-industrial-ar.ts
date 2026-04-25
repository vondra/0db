/**
 * Enrich AR industrial with GEM Global Integrated Power (Argentina filter).
 *
 * Source: GEM Global Integrated Power v1
 *   services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/
 *   Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Argentina'
 *
 * Records: 393 plants total, 263 operating
 *   - oil/gas: 136 (Centrales Costanera, Loma de la Lata, Brigadier López,
 *     Pilar, Genelba, Manuel Belgrano, Vuelta de Obligado, AES Paraná)
 *   - wind: 105 (Patagonia: Comodoro Rivadavia, Madryn, Loma Blanca,
 *     Aluar, Arauco, Manantiales Behr; coastal Buenos Aires; La Pampa)
 *   - solar: 96 (Cauchari Jujuy 300 MW, La Puna, San Juan)
 *   - hydropower: 41 (Yacyretá 3.1 GW, Salto Grande 1.89 GW, Piedra del
 *     Águila 1.42 GW, Chocón 1.2 GW, Alicurá 1.04 GW, Futaleufú,
 *     Río Hondo, Cabra Corral, Los Reyunos)
 *   - bioenergy: 7 (sugarcane bagasse Tucumán, biogas)
 *   - nuclear: 5 (Atucha I 362 MW, Atucha II 745 MW, Embalse 648 MW;
 *     Atucha III pre-construction; Carem-25 small modular reactor)
 *   - coal: 3 (Río Turbio mine-mouth in Santa Cruz, smaller units)
 *
 * Argentina has no SIGACONTROL/CAMMESA equivalent ArcGIS layer for
 * facilities (only spot prices and balances). GEM is the only consistent
 * GPS+capacity+fuel source. Non-power industrial NACE classification
 * relies on global E-PRTR-equivalent (not available for AR).
 *
 * All operating plants map to NACE 35 (Electricity generation).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ar.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const AR_BBOX: readonly [number, number, number, number] = [-55.5, -73.6, -21.7, -53.6]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-56.0, -76.0, -17.5, -69.0],
  [-22.9, -69.7, -9.5, -57.5],
  [-27.6, -62.7, -19.0, -54.2],
  [-33.8, -57.7, 5.3, -34.0],
  [-35.0, -58.45, -30.0, -53.0],
]

await enrichGemIndustrial({
  countryCode: 'ar',
  countryName: "Argentina",
  bbox: AR_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, AR_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
