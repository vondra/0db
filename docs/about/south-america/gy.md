---
title: Guyana
intro: Noise mapping data sources for Guyana.
map: { center: [-58.9, 4.9], zoom: 8 }
---

## Road traffic

### Road defaults

Guyana publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Guyana's traffic factor **≈ 1.261** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.261 ≈ 37,830 |
| Trunk | 15,000 × 1.261 ≈ 18,915 |
| Primary | 9,000 × 1.261 ≈ 11,349 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

Demerara-Essequibo Railway closed 1972. East Coast Demerara line closed 1974.

## Industrial

### GEM — 2 plants, operating, ~2 MW

Small diesel only. **GEM captures minimal land-based generation** — GPL (Guyana Power and Light) diesel + gas turbines (~130 MW capacity) not in GEM. ExxonMobil Stabroek offshore production entirely offshore — not a land noise source.

### Key sites not NACE classified
- **ExxonMobil Stabroek offshore**: Liza Phase 1+2, Payara, Yellowtail — ~650,000 bpd by 2024; world's fastest-growing oil province since 2015 discovery; entirely offshore
- **Bauxite**: Linden (Bosai Minerals) — Demerara Bauxite legacy, still active
- **Sugar**: GuySuCo — Berbice, Demerara; origin of "Demerara sugar"
- **Gold/diamond**: Omai, Kaieteur regions; artisanal and licensed mining
- **Cricket**: Bourda Oval Georgetown + Providence Stadium (West Indies team)
- **Kaieteur Falls**: world's most powerful waterfall (Potaro River) — Guyana Shield interior
