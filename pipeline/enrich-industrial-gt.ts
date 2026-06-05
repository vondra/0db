/**
 * Enrich GT industrial with GEM Global Integrated Power (Guatemala filter).
 *
 * All Guatemala government portals (CNEE, MEM) publish corporate HTML only.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Guatemala'):
 *     53 operating plants, ~2,783 MW total
 *
 *   Notable operating plants:
 *     **Chixoy hydro 300 MW**          (hydro — Chixoy River, Alta Verapaz; largest hydro)
 *     **Palo Viejo hydro 84 MW**       (hydro — Quiché, ENEL)
 *     **Renace I–IV hydro ~460 MW**    (hydro — Cahabón River cascade, Alta Verapaz)
 *     **Jaguar Energy thermal 300 MW** (HFO — Pacific coast, IFC-backed)
 *     **TECO Energy thermal 79 MW**    (HFO — Puerto Barrios, Caribbean)
 *     **Ingenio Pantaleón 120 MW**     (bagasse CHP — Escuintla, largest sugar mill)
 *     **Ingenio Santa Ana 42 MW**      (bagasse CHP — La Gomera, Escuintla)
 *     **Monte Llano wind 52 MW**       (wind — Pacific coastal plain, Huehuetenango)
 *     **Viento Blanco wind 50 MW**     (wind — Quetzaltenango highlands)
 *     **Helios Solar 50 MW**           (solar — Zacapa, largest solar plant)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar** — Guatemala is Central America's largest sugar producer;
 *     major ingenios: Pantaleón (Escuintla), La Unión (Santa Lucía Cotz.),
 *     Madre Tierra, Santa Ana, Concepción — Pacific coastal plain (Costa Sur)
 *   - **Coffee** — Antigua (volcanic highlands), Huehuetenango (high altitude),
 *     Cobán/Alta Verapaz (cloud forest), Atitlán; Guatemala is a specialty
 *     Arabica origin, ~4 M bags/year export
 *   - **Cardamom** — Guatemala is the WORLD'S LARGEST EXPORTER (~70% global share);
 *     concentrated in Alta Verapaz, Quiché, Huehuetenango; most exported to
 *     Saudi Arabia, UAE, India for chai/gahwa
 *   - **Banana** — Izabal (Caribbean) and Escuintla (Pacific) plantations;
 *     Chiquita/Fyffes and Dole operate here; BANDEGUA cooperative
 *   - **Cement** — Cementos Progreso (dominant, Guatemalan-owned);
 *     plants in San Miguel Conacaste (Chimaltenango) and El Progreso
 *   - **Textiles/Maquila** — apparel export processing zones, mostly Guatemala
 *     City periphery (Villa Nueva, Mixco, Amatitlán); ~500 maquiladoras
 *   - **Palm oil** — growing in Izabal, Petén (replacing forest and cattle);
 *     NAMASTÉ (Colombian JV), Olmeca
 *   - **Rubber** — Escuintla, Retalhuleu (Pacific lowlands)
 *   - **Mining** — nickel: Compañía Guatemalteca de Níquel (Izabal, HudBay);
 *     antimony, lead, zinc in Huehuetenango; gold (small artisanal)
 *
 * GT_BBOX: [minLat=13.7, minLon=-92.3, maxLat=17.8, maxLon=-88.2]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-gt.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const GT_BBOX: readonly [number, number, number, number] = [13.7, -92.3, 17.8, -88.2]

await enrichGemIndustrial({
  countryCode: 'gt',
  countryName: "Guatemala",
  bbox: GT_BBOX,
})
