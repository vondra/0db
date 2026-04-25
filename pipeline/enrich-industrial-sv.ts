/**
 * Enrich SV industrial with GEM Global Integrated Power (El Salvador filter).
 *
 * CEL (Comisión Ejecutiva Hidroeléctrica del Río Lempa) and SIGET publish
 * no open machine-readable plant data. GEM is the only machine-readable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='El Salvador'):
 *     60 operating plants, ~2,563 MW total
 *
 *   Notable operating plants:
 *     **Cerrón Grande hydro 170 MW**     (hydro — Río Lempa, Chalatenango; largest hydro)
 *     **15 de Septiembre hydro 156 MW**  (hydro — Río Lempa, Cuscatlán/San Vicente)
 *     **5 de Noviembre hydro 81 MW**     (hydro — Río Lempa, Cabañas)
 *     **Ahuachapán geothermal 95 MW**    (geothermal — Ahuachapán; operating since 1975)
 *     **Berlín geothermal 109 MW**       (geothermal — Usulután; LAGEO/ENEL JV)
 *     **Acajutla thermal 239 MW**        (gas/HFO — Acajutla port, Sonsonate)
 *     **Duke Energy Nejapa thermal**     (gas/diesel — Nejapa, San Salvador metro)
 *     **Ingenio El Ángel bagasse**       (bagasse CHP — Ahuachapán; sugar harvest season)
 *     **Ingenio Chaparrastique bagasse** (bagasse CHP — San Miguel)
 *     **Monte Rosa bagasse ~60 MW**      (bagasse CHP — Izalco, Sonsonate)
 *     **Providencia solar ~30 MW**       (solar — Ahuachapán)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar** — Pacific coastal plain (Sonsonate, La Libertad, Ahuachapán);
 *     SV has ~8 major ingenios; DIZUCAR cooperative; bagasse cogeneration
 *   - **Coffee** — Apaneca-Ilamatepec (volcanic highlands), Santa Ana, Chalatenango;
 *     world-class SHB Arabica; protected denomination "Café de El Salvador"
 *   - **Textiles/Maquila** — San Marcos, Soyapango, Santa Tecla free zones;
 *     US apparel brands; ~88,000 maquila workers
 *   - **Food processing** — Soyapango industrial zone (largest in Central America
 *     by density); beverages (SAB Miller/Industrias La Constancia), baked goods
 *   - **Cement** — CESSA (Cementos de El Salvador) plant in Metapán, Santa Ana;
 *     only domestic producer
 *   - **Chemical/Plastics** — Soyapango and Santa Ana industrial parks
 *   - **Fishing** — La Unión (Gulf of Fonseca) and Acajutla; tuna and shrimp export
 *   - **Geothermal** — SV is world #9 geothermal electricity producer; LaGeo
 *     operates Ahuachapán and Berlín fields; ~25% of national electricity
 *
 * SV_BBOX: [minLat=13.1, minLon=-90.2, maxLat=14.5, maxLon=-87.7]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-sv.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const SV_BBOX: readonly [number, number, number, number] = [13.1, -90.2, 14.5, -87.7]

await enrichGemIndustrial({
  countryCode: 'sv',
  countryName: "El Salvador",
  bbox: SV_BBOX,
})
