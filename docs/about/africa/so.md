---
title: Somalia
intro: Noise mapping data sources for Somalia.
map: { center: [46, 6], zoom: 5 }
---

## Road traffic

### Road defaults

Somalia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Somalia's traffic factor **≈ 0.700** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.700 ≈ 21,000 |
| Trunk | 15,000 × 0.700 ≈ 10,500 |
| Primary | 9,000 × 0.700 ≈ 6,300 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Somalia has NEVER had an operational railway.

Italian and British colonial Somalia built no rail infrastructure. A Berbera–Hargeisa connection was proposed but never constructed. Not modelled.

## Industrial

### GEM — 7 plants, operating, 94 MW

Almost entirely diesel generators. No national grid — each city has isolated generation. Somaliland (Hargeisa) and Puntland (Bosaso/Garowe) have separate utility operations from FGS.

### Key infrastructure not NACE classified
- **Berbera Port** (Somaliland) — DP World 30-year concession (2017); UAE military base; strategic Bab-el-Mandeb position
- **Mogadishu Port** — rehabilitated 2013+; main FGS import hub
- **Bosaso Port** (Puntland) — major live-animal export port (camels + small ruminants); Somalia is among the world's largest livestock exporters to the Arabian Peninsula
- **Kismayo Port** — southern agricultural/charcoal export; Al-Shabaab revenue dispute
- **Egal International Airport** (Hargeisa, HCMH) + **Aden Adde Airport** (Mogadishu, HCMM) — covered by global aircraft layer
- **HOT OSM** — Humanitarian OpenStreetMap Team mapping; variable road accuracy
