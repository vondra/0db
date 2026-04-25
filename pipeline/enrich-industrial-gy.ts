/**
 * Enrich GY industrial with GEM Global Integrated Power (Guyana filter).
 *
 * Guyana Energy Agency (GEA) and GPL (Guyana Power and Light) publish no
 * open machine-readable plant data. GEM is the only usable source.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Guyana'):
 *     2 operating plants, ~2 MW total (tiny solar only)
 *
 *   Notable operating plants:
 *     **Berbice Solar 1 MW**         (solar — East Berbice)
 *     **Anna Regina Solar 1 MW**     (solar — Essequibo Coast)
 *
 * Non-power industrial (OSM only):
 *   - **ExxonMobil Stabroek oil** — one of the world's largest recent oil
 *     discoveries (2015+); Liza Phase 1 (2019) and Phase 2 (2022) FPSOs
 *     offshore; Yellowtail FPSO under construction; projected 1.2 M bbl/day
 *     peak by 2027; transforming Guyana from one of South America's poorest
 *     countries to among the fastest-growing economies globally.
 *     Stabroek is entirely offshore — not in GEM, not in OSM industrial.
 *   - **Bauxite / alumina** — RUSAL Aroaima (East Berbice); Linden is the
 *     historic centre (LINMINE, now BOSAI Minerals Group); bauxite export
 *     via New Amsterdam port
 *   - **Gold mining** — medium-scale Marudi Mountain (Rupununi); artisanal
 *     and small-scale throughout interior (mercury concerns)
 *   - **Sugar** — GuySuCo (Guyana Sugar Corporation); Albion, Blairmont,
 *     Uitvlugt estates on coastal strip; industry much reduced from peak
 *   - **Rice** — Essequibo Coast (Regions 2 & 3), Black Bush Polder
 *     (Region 6); Guyana is a significant CARICOM rice exporter
 *   - **Timber** — Barama Company (Chinese JV), interior concessions
 *   - **Rum / distilling** — Demerara Distillers (El Dorado rum);
 *     one of the world's most awarded rum producers
 *
 * GY_BBOX: [minLat=1.2, minLon=-61.4, maxLat=8.6, maxLon=-56.5]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-gy.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const GY_BBOX: readonly [number, number, number, number] = [1.2, -61.4, 8.6, -56.5]

await enrichGemIndustrial({
  countryCode: 'gy',
  countryName: "Guyana",
  bbox: GY_BBOX,
})
