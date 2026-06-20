---
title: Trinidad and Tobago
intro: Noise mapping data sources for Trinidad and Tobago.
map: { center: [-61.3, 10.5], zoom: 9 }
---

## Road traffic

### Road defaults

Trinidad and Tobago publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Trinidad and Tobago's traffic factor **≈ 1.292** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.292 ≈ 38,760 |
| Trunk | 15,000 × 1.292 ≈ 19,380 |
| Primary | 9,000 × 1.292 ≈ 11,628 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

Government Railway closed 1968. No railway on Tobago.

## Industrial

### GEM — 17 plants, operating, ~2,057 MW

Gas/CCGT 10 + wind 2 + solar 2 + diesel 2 + HFO 1. **Almost entirely gas-fired** — Trinidad sits on natural gas reserves. **Point Lisas Power 720 MW** (gas, Point Lisas complex) — largest; **Trinity Power ~294 MW** (gas) + **Penal/Debe ~200 MW** (gas).

### Key sites not NACE classified
- **Atlantic LNG** (Point Fortin): ~15 mtpa — world's largest LNG complex by capacity
- **Point Lisas Industrial Complex**: ammonia (Yara, Nutrien), methanol (M5000), urea — petrochemical hub of Caribbean
- **Oil upstream**: Bonga field, Dragon field; Petrotrin legacy (closed 2018)
- **Carnival**: Port of Spain (pre-Lenten) — major annual traffic event
- **Asphalt**: Pitch Lake (La Brea) — world's largest natural asphalt deposit
