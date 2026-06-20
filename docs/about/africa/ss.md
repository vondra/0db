---
title: South Sudan
intro: Noise mapping data sources for South Sudan.
map: { center: [31, 7], zoom: 5 }
---

## Road traffic

### Road defaults

South Sudan publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by South Sudan's traffic factor **≈ 0.717** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.717 ≈ 21,510 |
| Trunk | 15,000 × 0.717 ≈ 10,755 |
| Primary | 9,000 × 0.717 ≈ 6,453 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### No operational railways.

Sudan Railways narrow-gauge network did not extend functional lines into what became South Sudan. A Juba rail link was proposed but never built. Not modelled.

## Industrial

### GEM — 5 plants, operating, 137 MW

Almost entirely diesel generators. No national grid — Juba Power Station + isolated town generators. ~8% electrification, among world's lowest.

### Key sites not NACE classified
- **Dar Petroleum (DPOC)** — CNPC + Petronas + Sinopec + Sudapet (Petrodar) consortium; **Melut Basin** (Blocks 3&7 — Palogue + Adar Yale fields, Upper Nile), South Sudan's main producing area; oil is ~90%+ of government revenue
- **Greater Nile Petroleum (GNPOC)** — **Unity field** (Blocks 1/2/4, Muglad Basin); the adjacent Heglig field lies in the disputed Sudan-administered border zone
- **Juba Power Station** — diesel; crude exported north via the Petrodar/GNPOC pipeline to Port Sudan (flows suspended in disputes 2012 and 2022)
- **Juba International Airport (JUB/HSSJ)** — covered by global aircraft layer
- **Sudd Wetland** — world's largest tropical wetland (~57,000 km²); White Nile; major ecological feature
- **HOT OSM** — Humanitarian OpenStreetMap Team mapping; road network incomplete and variable quality
