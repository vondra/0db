---
title: Montenegro
intro: Noise mapping data sources for Montenegro.
map: { center: [19.3, 42.7], zoom: 8 }
---

## Road traffic

### Road defaults

Montenegro publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Montenegro's traffic factor **≈ 0.785** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.785 ≈ 23,550 |
| Trunk | 15,000 × 0.785 ≈ 11,775 |
| Primary | 9,000 × 0.785 ≈ 7,065 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### ŽPCG ~250 km standard gauge. Part of the famous **Belgrade-Bar scenic railway** (476 tunnels, 435 bridges, **Mala Rijeka Viaduct** — one of world's highest railway bridges).

| Context | pax/day | frt/day |
|---|---:|---:|
| **Main line** (Belgrade-Bar / Podgorica hub) | 4 | 3 |
| Other | 1 | 1 |

## Industrial

### GEM — 40 plants, 6 operating, ~995 MW

Hydro 2 + wind 2 + coal 1 + solar 1. **Mratinje/Piva 342** (Europe's deepest canyon dam) + **Perućica 307** (one of Europe's oldest) + **Pljevlja coal 225** (ONLY thermal, Europe's most polluting per capita) + Krnovo/Možura wind.

### Key sites not NACE classified
- **KAP Podgorica aluminium** — consumes **~40% of Montenegro's electricity**
- **Bar-Boljare motorway** — most expensive European road per km ($1B Chinese for 41 km)
- Pljevlja coal mine, Nikšić steel (defunct)
