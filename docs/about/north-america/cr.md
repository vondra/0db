---
title: Costa Rica
intro: Noise mapping data sources for Costa Rica.
map: { center: [-84.2, 9.9], zoom: 8 }
---

## Road traffic

### Road defaults

Costa Rica publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Costa Rica's traffic factor **≈ 1.299** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.299 ≈ 38,970 |
| Trunk | 15,000 × 1.299 ≈ 19,485 |
| Primary | 9,000 × 1.299 ≈ 11,691 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct inter-city. All inter-city traffic set to zero.

Incofer operates limited suburban rail in San José metro (Pacific and Atlantic lines), but ridership is very low and not noise-significant at national scale.

## Industrial

### GEM — 45 plants, operating, ~2,514 MW

Hydro 22 + wind 7 + geothermal 3 + solar 8 + bioenergy 3 + HFO 2. **99% renewable electricity** — routinely 300+ days per year. **Reventazón hydro 305 MW** (Reventazón River) — largest. **Angostura hydro 177 MW** + **Arenal hydro 157 MW**. **Miravalles geothermal 166 MW** (Guanacaste; ICE, operating since 1994).

### Key sites not NACE classified
- **Geothermal**: Miravalles, Las Pailas II — Guanacaste volcanic belt
- **Pineapple**: Valle del General, Huetar Norte — world's largest exporter
- **Banana**: Limón Atlantic coast — Dole, Del Monte
- **Coffee**: Tarrazú, Tres Ríos, Naranjo
- **Medical devices + tech**: free-trade zones (Alajuela, Coyol), Intel legacy
- **Ecotourism**: Arenal, Monteverde, Tortuguero — minimal direct noise
