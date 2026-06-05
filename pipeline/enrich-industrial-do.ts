/**
 * Enrich DO industrial with GEM Global Integrated Power (Dominican Republic filter).
 *
 * Dominican Republic has the largest power generation fleet in the Caribbean.
 * The sector is privatized (EGE Haina, AES, CESPM, etc.) with significant
 * installed capacity. GEM provides good coverage. GEM is the primary source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Dominican Republic'):
 *     ~73 operating plants, ~6,132 MW total
 *
 *   Top operating plants:
 *     **Quisqueya I + II** (gas — 880 MW total, San Pedro de Macorís; 18.43°N, 69.29°W)
 *     **AES Andrés** (gas — 320 MW, LNG terminal, Andrés; 18.43°N, 69.62°W)
 *     **CESPM** (gas/oil — 300 MW, Punta Caucedo; 18.42°N, 69.62°W)
 *     **EGE Haina** (oil — 200 MW, San Cristóbal; 18.43°N, 70.00°W)
 *     **Los Cocos wind** (wind — 85 MW, Pedernales; 17.91°N, 71.44°W)
 *     **Monte Plata Solar** (solar — 60 MW; 18.81°N, 69.78°W)
 *     **Tavera / Bao / López-Angostura** (hydro — Cibao Valley; ~300 MW combined)
 *
 * Non-power industrial (OSM only):
 *   - **Sugar**: Central Romana (Gulf+Western legacy), Casa de Campo area; DR top agricultural product
 *   - **Cigars**: second only to Cuba globally. Santiago/Cibao Valley — La Aurora, Davidoff, Arturo Fuente
 *   - **Free trade zones (FTZ)**: ~550 companies, garments, tobacco, footwear; Santiago, La Romana, San Pedro
 *   - **Tourism**: Punta Cana (fastest growing in world), Santo Domingo colonial zone (UNESCO)
 *   - **Gold/silver**: Barrick Pueblo Viejo mine (San Juan province) — Caribbean's largest gold mine
 *   - **Ferronickel**: Falcondo mine (Bonao) — major export
 *
 * Bbox note:
 *   Shares Hispaniola with Haiti. Exclude lon < -72.0 && lat > 18.0 (Haiti territory).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-do.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const DO_BBOX: readonly [number, number, number, number] = [17.5, -72.0, 20.0, -68.3]

await enrichGemIndustrial({
  countryCode: 'do',
  countryName: "Dominican Republic",
  bbox: DO_BBOX,
  isInside: (lat, lon) => {
    if (lat < DO_BBOX[0] || lat > DO_BBOX[2]) return false
    if (lon < DO_BBOX[1] || lon > DO_BBOX[3]) return false
    if (lat < DO_BBOX[0] || lat > DO_BBOX[2]) return false
    if (lon < DO_BBOX[1] || lon > DO_BBOX[3]) return false
    if (lon < -72.0 && lat > 18.0) return false
    return true
  },
})
