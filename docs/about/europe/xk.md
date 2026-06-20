---
title: Kosovo
intro: Noise mapping data sources for Kosovo.
map: { center: [21.0, 42.6], zoom: 9 }
---

## Road traffic

### Road defaults

Kosovo publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Kosovo's traffic factor **≈ 1.004** (no per-country factor; uses the European continental default). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.004 ≈ 30,120 |
| Trunk | 15,000 × 1.004 ≈ 15,060 |
| Primary | 9,000 × 1.004 ≈ 9,036 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Trainkos ~333 km standard gauge. Very limited service — Fushë Kosovë is the main junction.

| Context | pax/day | frt/day |
|---|---:|---:|
| **Pristina↔Hani i Elezit** (N. Macedonia) | 2 | 3 |
| **Pristina↔Pejë** (west) | 0 | 1 |
| Other | 0 | 1 |

## Industrial

### GEM — 35 plants, 11 operating, ~1.44 GW

Coal 5 + solar 4 + wind 2. **Kosovo A+B coal complex 1,290 MW** (3+2 units, Obiliq lignite — **~97% of Kosovo's electricity**, **ONE OF EUROPE'S MOST POLLUTING power complexes**). Bajgora Wind 103 + Kitka 32. **World's 5th largest lignite reserves** (~14.7 Bt mostly unextracted).

### Key sites not NACE classified
- Trepča mining complex (lead/zinc/silver — Mitrovica, divided Serb/Albanian)
- Ferronikeli (Drenas — closed/restarting)
- Sharrcem cement (Hani i Elezit — Holcim)
