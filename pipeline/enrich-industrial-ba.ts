/**
 * Enrich BA industrial with GEM Global Integrated Power (Bosnia and Herzegovina filter).
 *
 * Source:
 *   - **GEM Global Integrated Power** (Country_area='Bosnia and Herzegovina'):
 *     157 total / 45 operating / ~4.54 GW
 *
 *   Power by fuel:
 *     Coal 10: Tuzla 640 MW, Kakanj 340 MW, Gacko 300 MW, Stanari 300 MW,
 *              Ugljevik 300 MW (+ smaller units)
 *     Hydro 13: Čapljina pumped-storage 440 MW (Neretva),
 *               Višegrad 315 MW (Drina),
 *               Neretva cascade — Salakovac 210 MW, Jablanica 180 MW,
 *               Grabovica 114 MW, Rama 160 MW
 *     Solar 18, Wind 4
 *
 *   Two-entity structure:
 *     FBiH (Federation) → EP BiH: Tuzla, Kakanj, Jablanica, Neretva cascade
 *     RS (Republika Srpska) → EP RS: Ugljevik, Gacko, Višegrad
 *
 * Non-power industrial (OSM only):
 *   - **ArcelorMittal Zenica** — integrated steel, largest industrial employer
 *     in FBiH; Bosna River valley
 *   - **Energoinvest** (Sarajevo) — engineering/electrical
 *   - **RMU Banovići** — coal mine, Tuzla basin
 *   - **Banja Luka cement** (HeidelbergCement / Romanija)
 *   - **Alumina Zvornik** (alumina refinery, RS)
 *   - Wood processing — massive BiH forest sector, sawmills across the country
 *   - Salt mining / chemical industry (Tuzla salt basin)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-ba.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { inBbox } from './lib/spatial.js'

const BA_BBOX: readonly [number, number, number, number] = [42.55, 15.7, 45.3, 19.65]

const EXCLUDE_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [45.1, 15.7, 45.3, 17.5],
  [42.55, 15.7, 45.3, 16.3],
  [43.5, 19.5, 45.3, 19.65],
  [42.55, 18.3, 42.8, 19.65],
]

await enrichGemIndustrial({
  countryCode: 'ba',
  countryName: "Bosnia and Herzegovina",
  bbox: BA_BBOX,
  isInside: (lat, lon) => inBbox(lat, lon, BA_BBOX) && !EXCLUDE_ZONES.some(z => inBbox(lat, lon, z)),
})
