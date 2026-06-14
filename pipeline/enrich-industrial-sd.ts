/**
 * Enrich SD industrial with GEM Global Integrated Power (Sudan filter).
 *
 * Sudan's Ministry of Energy publishes no open GIS or power plant data.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Sudan'):
 *     26 operating plants, ~4,150 MW total
 *
 *   Notable operating plants:
 *     **Merowe Dam 1,250 MW**          (hydro — Nile, 4th cataract, largest in Africa at commissioning 2009)
 *     **Roseires Dam ~280 MW**         (hydro — Blue Nile, Damazin; oldest major hydro)
 *     **Sennar Dam ~23 MW**            (hydro — Blue Nile; 1925 colonial-era dam)
 *     **Jebel Aulia Dam ~30 MW**       (hydro — White Nile, south of Khartoum)
 *     **Khartoum North Power ~1,100 MW** (thermal — multiple HFO/gas units)
 *     **Kassala Wind Farm ~60 MW**     (wind — east Sudan, near Eritrea border)
 *     **Gaili Power Station ~450 MW**  (HFO — north Khartoum, Chinese-built)
 *
 * Non-power industrial (OSM only):
 *   - **Oil refining** — Sudan Khartoum Refinery (SKRCO), ~100k bbl/day;
 *     Khartoum North; crude from Unity fields (South Sudan transit)
 *   - **Cement** — Atbara Cement Factory; BPEC (multiple plants)
 *   - **Sugar** — Kenana Sugar Company (Blue Nile; largest integrated sugar scheme in Africa);
 *     Sudanese Sugar Company (various Blue/White Nile schemes)
 *   - **Cotton/textiles** — Gezira Scheme irrigation (Blue Nile/White Nile triangle;
 *     world's largest irrigated agricultural project ~2M ha); cotton ginning
 *   - **Gold mining** — Sudan 2nd largest gold producer in Africa (after Ghana);
 *     artisanal (Jabal Amer, Darfur), industrial (Ariab Mining, Red Sea area)
 *   - **Military-industrial** — Military Industry Corporation (MIC); arms production
 *     (small arms, ammunition); significant under al-Bashir era
 *   - Civil war since April 2023 (RSF Rapid Support Forces vs SAF).
 *
 * SD_BBOX: [minLat=8.7, minLon=21.8, maxLat=22.2, maxLon=38.6]
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-industrial-sd.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'
import { makeCountryGate } from './lib/country-polygon.js'

// bbox is the cheap hex-shortlist; makeCountryGate is the real per-site filter
// (point-in-polygon against the CGAZ ADM0 boundary, so a plant just over the
// South Sudan/Egypt/Chad/Ethiopia/Eritrea border can't land in the Sudan arrow).
const SD_BBOX: readonly [number, number, number, number] = [8.7, 21.8, 22.2, 38.6]

await enrichGemIndustrial({
  countryCode: 'sd',
  countryName: "Sudan",
  bbox: SD_BBOX,
  isInside: makeCountryGate('SD'),
})
