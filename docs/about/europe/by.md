---
title: Belarus
intro: Noise mapping data sources for Belarus.
map: { center: [27.9, 53.7], zoom: 6 }
---

## Road traffic

### Road defaults

Belarus publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Belarus's traffic factor **≈ 0.886** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.886 ≈ 26,580 |
| Trunk | 15,000 × 0.886 ≈ 13,290 |
| Primary | 9,000 × 0.886 ≈ 7,974 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Belarusian Railway ~5,500 km broad gauge 1,520mm — **major Russia↔Europe transit corridor**.

**Minsk Metro** (1984) — 2 lines, ~40 km, 33 stations, ~800k daily.

| Context | pax/day | frt/day |
|---|---:|---:|
| **Minsk Metro (1984)** | 200 | 0 |
| **Main trunk** (Minsk hub, M1/E30 rail parallel) | 15 | 18 |
| Other | 5 | 8 |

## Industrial

### GEM — 105 plants, 93 operating, ~11.9 GW

Gas-dominant (67 oil/gas + 24 solar + 2 nuclear). **Astravets NPP 2,388 MW** (2× VVER-1200 — **Russia-built 2020-2023**, only **50 km from Vilnius**, Lithuania opposition + EU safety concerns). **Lukoml GRES ~2,800 MW** (Novolukoml — Belarus's largest thermal). Minsk CHP-5 720 + CHP-4 250. Bereza 427. 24 solar.

### Key sites not NACE classified
- **Belaruskali potash** (Soligorsk — **world's 2nd largest potash producer** after Nutrien/Saskatchewan)
- **BelAZ** (Zhodino — **world's largest dump trucks**, 450-ton capacity)
- **Mozyr refinery** (240k bpd) + **Naftan refinery** (Novopolotsk, 220k bpd) — Druzhba pipeline Russian crude
- **BMZ steel** (Zhlobin — Byelorussian Steel Works)
- **Grodno Azot** (nitrogen fertilizer — one of Europe's largest)
- **MAZ trucks** (Minsk Automobile Plant)
- **Gomel — near Chernobyl exclusion zone** (1986 nuclear disaster)
