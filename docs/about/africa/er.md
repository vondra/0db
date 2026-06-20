---
title: Eritrea
intro: Noise mapping data sources for Eritrea.
map: { center: [38.5, 15.5], zoom: 6 }
---

## Road traffic

### Road defaults

Eritrea publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Eritrea's traffic factor **≈ 0.864** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.864 ≈ 25,920 |
| Trunk | 15,000 × 0.864 ≈ 12,960 |
| Primary | 9,000 × 0.864 ≈ 7,776 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### No operational railway — heritage tourist line only.

The **Asmara–Massawa Railway** (117.5 km, metre-gauge, 1911, Italian) is one of the world's most dramatic narrow-gauge achievements: 2,325 m descent in 118 km, 30 tunnels, 65 bridges. Not operational for regular service. Heritage tourist excursions (~6 times/year) are not modelled.

## Industrial

### GEM — 5 plants, operating, 99 MW

All thermal (HFO/diesel). No hydropower — no significant permanent rivers. ~46% electrification; load-shedding common.

### Key sites not NACE classified
- **Bisha Mine** (Zijin, formerly Nevsun — gold/silver/copper) — opened 2011; one of Africa's largest new base-metal mines
- **Colluli Potash** (Danakali) — Danakil Depression; among world's largest shallow potash deposits
- **Zara Silver** (Asmara Mining) — gold-silver, Asmara area
- **Massawa Salt Works** — Red Sea evaporation ponds
- **Asmara Brewery** — Italian-era Melotti brewery, still operating
