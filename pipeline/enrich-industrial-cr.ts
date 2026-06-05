/**
 * Enrich CR industrial with GEM Global Integrated Power (Costa Rica filter).
 *
 * ICE (Instituto Costarricense de Electricidad) publishes some plant data but
 * not as open machine-readable geospatial. GEM is the most complete source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Costa Rica'):
 *     45 operating plants, ~2,514 MW total
 *
 *   Notable operating plants:
 *     **Reventazón hydro 305 MW**       (hydro — Río Reventazón, Limón; largest hydro)
 *     **Arenal hydro 157 MW**           (hydro — Lake Arenal, Guanacaste; iconic reservoir)
 *     **Angostura hydro 177 MW**        (hydro — Río Reventazón, Turrialba)
 *     **Cachí hydro 100 MW**            (hydro — Río Reventazón, Cartago)
 *     **Miravalles geothermal 166 MW**  (geothermal — Guanacaste; ICE; operating since 1994)
 *     **Rincón de la Vieja geothermal 42 MW** (geothermal — Guanacaste; ICE)
 *     **Los Santos wind 50 MW**         (wind — San José highlands; Vientos de la Muerte pass)
 *     **Tejona wind 20 MW**             (wind — Guanacaste; ICE; first CR wind farm)
 *     **PEG Valle Central wind 50 MW**  (wind — Cartago highlands; highest CR wind)
 *     **Colpachi solar ~25 MW**         (solar — Guanacaste, Pacific lowlands)
 *     **Costa Norte gas 381 MW**        (gas — Caribbean, Moín; reserve capacity only)
 *
 * Non-power industrial (OSM only):
 *   - **Pineapple** — CR is the world's #1 pineapple exporter (~50% global market);
 *     Puntarenas, Alajuela (Peñas Blancas), San Carlos; Dole and Del Monte operate
 *   - **Banana** — Limón province (Caribbean); Chiquita, Dole; major port at Moín
 *   - **Coffee** — Central Valley (Tarrazú, Tres Ríos, Naranjo); "Café de Costa Rica"
 *     has geographic indication; specialty Arabica; ~100k tons/year
 *   - **Medical devices** — Coyol Free Zone (Alajuela, near SJO airport); Boston Scientific,
 *     Abbott, Medtronic, Baxter; ~60% of exports by value
 *   - **Semiconductors/Tech** — Zona Franca La Lima (Cartago); Intel historical;
 *     now diversified advanced manufacturing and services
 *   - **Cement** — CONCRETERA NACIONAL and HOLCIM CR (Cartago, Grecia)
 *   - **Tourism** — Pura Vida; eco-tourism infrastructure (lodges, zip lines)
 *     scattered across cloud forest, beach, and volcano areas
 *   - **Sugar** — Guanacaste (CATSA/Taboga); production for local use + ethanol
 *   - **Cattle/Dairy** — Guanacaste cattle ranching; Los Santos dairy (Cartago, San José)
 *
 * CR_BBOX: [minLat=8.0, minLon=-86.0, maxLat=11.2, maxLon=-82.5]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-cr.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const CR_BBOX: readonly [number, number, number, number] = [8.0, -86.0, 11.2, -82.5]

await enrichGemIndustrial({
  countryCode: 'cr',
  countryName: "Costa Rica",
  bbox: CR_BBOX,
})
