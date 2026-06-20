---
title: The Bahamas
intro: Noise mapping data sources for The Bahamas.
map: { center: [-77.5, 24.6], zoom: 7 }
---

## Road traffic

### Road defaults

The Bahamas publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by The Bahamas's traffic factor **≈ 1.261** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.261 ≈ 37,830 |
| Trunk | 15,000 × 1.261 ≈ 18,915 |
| Primary | 9,000 × 1.261 ≈ 11,349 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### No railway. Never built.

Island geography and low population density made no railway economically viable. Drives on the left (British Commonwealth).

## Industrial

### GEM — 2 plants, operating, ~184 MW

Oil/HFO only. **BEC Clifton Pier ~132 MW** (New Providence, Nassau) — BEC main generation; **BEC Grand Bahama ~52 MW** (Freeport) serves Grand Bahama island.

### Key sites not NACE classified
- **Tourism/cruise**: Nassau (Atlantis, Baha Mar), Paradise Island — dominant economy
- **Freeport container port**: Grand Bahama; second-largest transshipment hub in Caribbean
- **Offshore finance**: Nassau — banking secrecy, hedge funds
- **Salt extraction**: Inagua — Morton Salt, world's largest solar salt operation
- **700 islands, 30 inhabited**: noise modelling mostly relevant to New Providence and Grand Bahama
