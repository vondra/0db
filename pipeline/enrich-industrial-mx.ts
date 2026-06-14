/**
 * Enrich MX industrial with GEM Global Integrated Power (Mexico filter).
 *
 * CFE (Comisión Federal de Electricidad) and CENACE publish operational data
 * in proprietary formats without machine-readable coordinates.
 * GEM is the best machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Mexico'):
 *     448 operating plants
 *
 *   Notable operating plants:
 *     **Laguna Verde nuclear 2×800 MW**      (nuclear — Veracruz; Mexico's only nuclear plant)
 *     **El Cajón hydro 750 MW**              (hydro — Nayarit, Santiago River)
 *     **La Yesca hydro 750 MW**              (hydro — Nayarit/Jalisco; CFE)
 *     **Chicoasén hydro 2,400 MW**           (hydro — Chiapas, Grijalva River; largest hydro)
 *     **Manzanillo CC gas 2,100 MW**         (gas — Colima coast; largest CCGT)
 *     **Altamira CC gas 1,036 MW**           (gas — Tamaulipas)
 *     **Iberdrola Hermosillo gas 277 MW**    (gas — Sonora)
 *     **Villanueva solar 754 MW**            (solar — Coahuila; one of largest in LatAm)
 *     **Don José solar 238 MW**              (solar — Guanajuato)
 *     **Eólica del Sur wind 396 MW**         (wind — Oaxaca Isthmus; largest wind farm)
 *     **La Venta wind complex ~300 MW**      (wind — Oaxaca Isthmus)
 *     **Energía Sierra Juárez wind 155 MW**  (wind — Baja California)
 *
 * Non-power industrial (OSM only):
 *   - **Oil/gas** — PEMEX: Campeche offshore (Cantarell, KMZ); Veracruz refineries
 *     (Minatitlán, Tuxpan); Salamanca (Guanajuato); Dos Bocas new refinery (Tabasco)
 *   - **Mining** — silver (Durango, Zacatecas: Fresnillo plc, largest silver producer);
 *     copper (Sonora: Buenavista del Cobre/Cananea, ASARCO); gold (Guerrero, Sonora);
 *     iron (Michoacán, Colima): Las Truchas smelter (Sicartsa)
 *   - **Automotive** — major assembly: Puebla (VW), Silao (GM), Toluca (Chrysler),
 *     Monterrey (KIA), San Luis Potosí (BMW, GM); huge auto parts belt
 *   - **Cement** — CEMEX (world's 3rd largest; HQ Monterrey); Cruz Azul, Cementos Moctezuma
 *   - **Steel** — Ternium (Monterrey, Puebla): Monterrey is Mexico's industrial capital
 *   - **Food processing** — MASECA corn flour (Gruma); Grupo Bimbo (Mexico City)
 *   - **Chemicals** — Bayer, BASF, Mexichem (Coatzacoalcos, Veracruz petrochemical cluster)
 *   - **Textiles/Maquila** — Monterrey, Juárez, Tijuana, Laredo border strip
 *
 * MX_BBOX: [minLat=14.5, minLon=-118.5, maxLat=32.7, maxLon=-86.7]
 * Excludes: lat>32.8 (US), lat<14.5 (Guatemala), lon<-118.5 (Pacific), lon>-86.5 (Caribbean)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-mx.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

const MX_BBOX: readonly [number, number, number, number] = [14.5, -118.5, 32.7, -86.7]

await enrichGemIndustrial({
  countryCode: 'mx',
  countryName: "Mexico",
  bbox: MX_BBOX,
  // bbox alone includes southern US + Guatemala/Belize; gate to MX polygon (gg 2026-06-14).
  isInside: makeCountryGate('MX'),
})
