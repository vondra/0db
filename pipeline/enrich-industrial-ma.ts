/**
 * Enrich MA industrial with GEM Global Integrated Power (Morocco filter).
 *
 * All Moroccan gov portals are dead or TCP-blocked from international IPs:
 *   - MTPNET, Équipement, ONCF (DNS), ONHYM, ADD
 *   - ADM publishes no traffic data
 *   - data.gov.ma is Drupal/tabular, not CKAN/GIS
 *   - MASEN, ONEE, OCP, MEM — corporate HTML only
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Morocco'):
 *     138 total, 65 operating
 *     Operating fuel breakdown:
 *       solar: 19 (Noor Ouarzazate I/II/III/IV CSP + Noor Midelt + Noor
 *                  PV + Ouarzazate Solar Park — world's largest CSP complex)
 *       wind: 16 (Tarfaya 300 MW, Tangier, Aftissat, Koudia Al Baida,
 *                 Essaouira, Laayoune Midelt)
 *       oil/gas: 11 (Tahaddart 400 MW CCGT, Ain Beni Mathar 470 MW hybrid
 *                    solar-gas, Mohammedia, Kenitra)
 *       coal: 11 (Jorf Lasfar 4×350 MW — Morocco's largest, Safi 2×693 MW,
 *                 Jerada 350 MW, Mohammedia)
 *       hydro: 8 (Afourer pumped storage 466 MW, Al Wahda 240 MW, Bin El
 *                 Ouidane, Allal El Fassi, Daourat, Imfout, Kasba Zidania)
 *
 * Non-power industrial (not captured by GEM):
 *   - **OCP phosphate complex** — world's largest phosphate producer:
 *     Khouribga mine (world's largest phosphate mine), Benguerir, Youssoufia,
 *     Jorf Lasfar fertilizer complex, Safi complex. All rely on OSM.
 *   - **SAMIR refinery** (Mohammedia, closed 2015)
 *   - **Renault-Nissan Tangier** (largest auto plant in Africa, 400k cars/yr)
 *   - **Stellantis Kenitra** (600k cars/yr capacity)
 *   - **Aerospace cluster** Casablanca (Bombardier, Spirit, Safran)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-ma.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const MA_BBOX: readonly [number, number, number, number] = [20.7, -17.3, 36.0, -1.0]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [20.7, -1.5, 36.0, -1.0],
  [20.7, -17.3, 21.5, -4.8],
]

await enrichGemIndustrial({
  countryCode: 'ma',
  countryName: "Morocco",
  bbox: MA_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, MA_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
