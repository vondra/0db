---
title: Honduras
intro: Noise mapping data sources for Honduras.
map: { center: [-86.9, 14.8], zoom: 7 }
---

## Road traffic

### Road defaults

Honduras publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Honduras's traffic factor **≈ 1.298** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.298 ≈ 38,940 |
| Trunk | 15,000 × 1.298 ≈ 19,470 |
| Primary | 9,000 × 1.298 ≈ 11,682 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

Historical banana plantation narrow-gauge lines (United Fruit, Tela Railroad) closed early 2000s. No national railway network.

## Industrial

### GEM — 44 plants, operating, ~2,721 MW

Hydro 18 + solar 8 + wind 7 + bioenergy/bagasse 6 + HFO 3 + coal 2. **El Cajón ~300 MW** (Comayagua/Humuya River) — largest hydro; **Lufussa III ~450 MW** (HFO, Choloma) — largest thermal. **Viento del Norte ~50 MW** wind (Olancho). **Sugar bagasse cogeneration** (Azucarera del Norte/AZUNOSA, Chumbagua).

### Key sites not NACE classified
- **Banana**: Cortés, Atlántida (Dole, Chiquita exports — origin of "banana republic")
- **Maquila/textiles**: San Pedro Sula, Choloma — ~170,000 workers, garment exports
- **Coffee**: Copán, Ocotepeque, Santa Bárbara
- **African palm oil**: Sula Valley
- **Lead/zinc mining**: Rosario Resources (El Mochito mine)
