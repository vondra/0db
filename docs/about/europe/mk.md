---
title: North Macedonia
intro: Noise mapping data sources for North Macedonia.
map: { center: [21.7, 41.5], zoom: 8 }
---

## Road traffic

### Road defaults

North Macedonia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by North Macedonia's traffic factor **≈ 0.902** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.902 ≈ 27,060 |
| Trunk | 15,000 × 0.902 ≈ 13,530 |
| Primary | 9,000 × 0.902 ≈ 8,118 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### MŽ Transport ~700 km standard gauge. **Corridor X** (Thessaloniki↔Skopje↔Belgrade).

| Context | pax/day | frt/day |
|---|---:|---:|
| **Corridor X south** (Skopje↔Gevgelija→Greece) | 5 | 6 |
| **Corridor X north** (Skopje↔Serbia) | 5 | 6 |
| **West branch** (Skopje↔Kičevo) | 2 | 2 |
| Other | 2 | 2 |

## Industrial

### GEM — 80 plants, 48 operating, ~1.96 GW

Coal 4 + hydro 4 + solar 36 + oil/gas 2 + wind 2. **REK Bitola 699 MW** (3×233 lignite — ~70% of national generation). **Vardar basin hydro**: Vrutok 166 + Tikveš 114 + Špilje 84 + Kozjak 82. Skopje CHP 220 + Negotino 198 gas. 36 solar (rapid growth).

### Key sites not NACE classified
- OKTA refinery (Skopje, Hellenic Petroleum — 40k bpd), FENI ferronickel (Kavadarci), Bucim copper-gold (Radoviš), Usje cement (Holcim)
