---
title: Haiti
intro: Noise mapping data sources for Haiti.
map: { center: [-72.4, 19.1], zoom: 8 }
---

## Road traffic

### Road defaults

Haiti publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Haiti's traffic factor **≈ 1.298** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.298 ≈ 38,940 |
| Trunk | 15,000 × 1.298 ≈ 19,470 |
| Primary | 9,000 × 1.298 ≈ 11,682 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

No modern railway. Historical sugar plantation lines long gone.

## Industrial

### No GEM matches — 0 plants

Haiti has no utility-scale generating plants in GEM. E-DH (Électricité d'Haïti) state utility capacity ~300 MW nominal; severely constrained by fuel, maintenance, and infrastructure.

### Key sites not NACE classified
- **Tap-tap buses**: brightly painted shared taxis/minibuses — main urban and inter-city transport
- **Mango**: Haitian Mango (Madame Francis variety) — major export
- **Textiles/assembly**: SONAPI industrial park (Port-au-Prince), Caracol industrial park
- **Charcoal**: primary cooking fuel; acute deforestation (<2% forest cover)
- **Aid/NGO infrastructure**: significant vehicle fleet in Port-au-Prince
