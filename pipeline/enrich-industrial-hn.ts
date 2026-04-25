/**
 * Enrich HN industrial with GEM Global Integrated Power (Honduras filter).
 *
 * All Honduras government portals (SERNA, ENEE) publish no open machine-readable
 * power plant data. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Honduras'):
 *     44 operating plants, ~2,721 MW total
 *
 *   Notable operating plants:
 *     **El Cajón hydro 300 MW**           (hydro — Comayagua River, main reservoir)
 *     **Nacaome hydro ~35 MW**            (hydro — Nacaome River, southern Honduras)
 *     **Cañaveral-Río Lindo hydro ~80 MW** (hydro — Río Lindo cascade, Santa Bárbara)
 *     **Lufussa III thermal 450 MW**      (HFO — Choloma, Pacific coast, largest thermal)
 *     **ELCOSA thermal 80 MW**            (HFO — Puerto Cortés, Caribbean)
 *     **Ingenio Chumbagua bagasse**       (bagasse CHP — El Progreso, Yoro valley)
 *     **Azucarera del Norte bagasse**     (bagasse CHP — Villanueva, Cortés)
 *     **Palmerola solar ~50 MW**          (solar — Comayagua, near airport)
 *     **Azul Solar ~30 MW**               (solar — Choluteca, Pacific lowlands)
 *     **Viento del Norte wind ~50 MW**    (wind — Olancho highlands)
 *
 * Non-power industrial (OSM only):
 *   - **Banana** — Cortés dept (Puerto Cortés, Villanueva, La Lima); Chiquita and Dole
 *     historically dominant; major export via Puerto Cortés (Caribbean)
 *   - **Sugar** — El Progreso (Yoro), Villanueva (Cortés); largest mills are
 *     Chumbagua and AZUNOSA; Pacific plain (Choluteca) also growing
 *   - **Coffee** — Copán (world-famous Copán Ruinas origin), Ocotepeque, La Paz,
 *     Intibucá; ~5 M bags/year export; specialty/SHG beans
 *   - **Palm oil** — Atlántida and Colón departments (Caribbean lowlands);
 *     Honduras is Central America's largest palm oil producer; HONDUPALMA
 *   - **Maquila/Textiles** — Zona Industrial Cortés (Choloma, La Lima, Villanueva);
 *     ~200 factories, mainly US apparel brands; ~180,000 workers; export processing
 *   - **Shrimp/Aquaculture** — Gulf of Fonseca (Pacific): Choluteca, Valle;
 *     Seajoy and Grupo Granjas Marinas are major producers; export to EU/US
 *   - **Cement** — Holcim Honduras (Villanueva) and Cementos del Norte (Choloma)
 *   - **Mining** — Rosario Resources gold/silver (El Corpus, Choluteca);
 *     artisanal alluvial gold in Olancho; zinc/lead (El Mochito, La Unión)
 *
 * HN_BBOX: [minLat=12.9, minLon=-89.4, maxLat=17.5, maxLon=-83.1]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-hn.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const HN_BBOX: readonly [number, number, number, number] = [12.9, -89.4, 17.5, -83.1]

await enrichGemIndustrial({
  countryCode: 'hn',
  countryName: "Honduras",
  bbox: HN_BBOX,
})
