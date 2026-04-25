/**
 * Enrich BN industrial with GEM Global Integrated Power (Brunei filter).
 *
 * Brunei's Energy Department (JPKE) publishes limited corporate data only.
 * GEM is the only machine-readable source for power plants.
 *
 * Source:
 *   - **GEM Global Integrated Power v1** (Country_area='Brunei'):
 *     8 operating plants, ~436 MW total
 *
 *   Notable operating plants:
 *     **Berakas Power Station A 215 MW** (gas — BSB district, main grid supply)
 *     **Berakas Power Station B 150 MW** (gas — BSB district)
 *     **Lumut Power Plant 225 MW**       (gas — Seria/Lumut area, Shell-operated)
 *     **Gadong Power Station 47 MW**     (gas — BSB urban, older plant)
 *     **Bukit Panggal diesel 15 MW**     (diesel — Temburong enclave)
 *
 * Non-power industrial (OSM only):
 *   - **Oil & gas upstream** — Brunei Shell Petroleum (BSP) joint venture;
 *     onshore fields (Seria, Belait) and offshore (Champion, Fairley, Gannet);
 *     Brunei exports ~100k bbl/day oil + LNG; Shell has operated since 1929
 *   - **LNG** — Brunei LNG plant at Lumut; 5 trains, ~7.2 Mt/year capacity;
 *     one of world's first LNG plants (1972); exports to Japan/South Korea
 *   - **Methanol** — Brunei Methanol Company (BMC) at Sungai Liang Industrial
 *     Park (SPARK); 850k t/year; JV with Mitsubishi/ITOCHU; feedstock from gas
 *   - **Fertilizer** — Brunei Fertilizer Industries (BFI) at SPARK;
 *     urea/ammonia from stranded gas; JV with Petronas
 *   - **Refinery** — Brunei PCSB Refinery at Seria; domestic fuel supply only
 *   - **Shipbuilding** — Muara shipyard; small vessels, offshore support
 *   - **Halal food** — growing diversification push; limited scale
 *
 * BN_BBOX: [minLat=4.0, minLon=114.0, maxLat=5.1, maxLon=115.4]
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-industrial-bn.ts
 */

import { enrichGemIndustrial } from './lib/enrich-industrial-gem.js'

const BN_BBOX: readonly [number, number, number, number] = [4.0, 114.0, 5.1, 115.4]

await enrichGemIndustrial({
  countryCode: 'bn',
  countryName: "Brunei",
  bbox: BN_BBOX,
})
