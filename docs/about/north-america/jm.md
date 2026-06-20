---
title: Jamaica
intro: Noise mapping data sources for Jamaica.
map: { center: [-77.3, 18.1], zoom: 9 }
---

## Road traffic

### Road defaults

Jamaica publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Jamaica's traffic factor **≈ 0.795** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.795 ≈ 23,850 |
| Trunk | 15,000 × 0.795 ≈ 11,925 |
| Primary | 9,000 × 0.795 ≈ 7,155 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

Jamaica Railway Corporation ceased passenger operations 1992, freight 2011. Track largely removed.

## Industrial

### GEM — 13 plants, operating, ~885 MW

Oil/HFO 5 + wind 3 + solar 2 + gas 2 + biomass 1. **Old Harbour complex ~320 MW** (Old Harbour 200 MW oil + Old Harbour B 120 MW oil/gas) — Jamaica's largest, on Old Harbour Bay. **Bogue ~120 MW** oil/gas (Montego Bay, St. James). **Wigton wind 62 MW** — largest wind farm in English Caribbean.

### Key sites not NACE classified
- **Bauxite/alumina**: Alcan (JAMALCO), Windalco (UC Rusal Kirkvine), Nain — dominant industry
- **Rum**: Appleton Estate (Nassau Valley), Worthy Park
- **Tourism**: Montego Bay, Ocho Rios, Negril — second-largest economy driver
- **Coffee**: Blue Mountains — world-premium Jamaican Blue Mountain
- **Reggae/music industry**: Kingston (Trenchtown, Studio One legacy)
