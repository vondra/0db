---
title: Panama
intro: Noise mapping data sources for Panama.
map: { center: [-80.1, 8.6], zoom: 8 }
---

## Road traffic

### Road defaults

Panama publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Panama's traffic factor **≈ 0.995** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.995 ≈ 29,850 |
| Trunk | 15,000 × 0.995 ≈ 14,925 |
| Primary | 9,000 × 0.995 ≈ 8,955 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct inter-city. Panama Canal Railway active but not noise-mapped.

Panama Canal Railway (47 km, Panama City–Colón) carries freight containers and tourist trains. No national passenger railway.

## Industrial

### GEM — 70 plants, operating, ~3,711 MW

Hydro 32 + gas 10 + solar 12 + wind 6 + HFO 5 + coal 3 + bioenergy 2. **Costa Norte LNG 381 MW** (AES Colón, Bahía Las Minas) — largest gas plant. **Fortuna hydro 300 MW** (Chiriquí — largest hydro) + **Bayano hydro 260 MW** (Chepo) + **Chan 75 hydro 222 MW** (Bocas del Toro).

### Key sites not NACE classified
- **Panama Canal**: 14,000+ vessels/year — container terminal noise at Balboa, Manzanillo
- **Colón Free Trade Zone**: second-largest in world — warehouse and logistics
- **Copper**: Cobre Panamá mine (First Quantum, Donoso) — largest copper mine in Central America
- **Banana**: Chiriquí (Chiquita/COOBANA)
- **Financial services**: Panama City banking district
