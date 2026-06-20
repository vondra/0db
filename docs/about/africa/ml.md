---
title: Mali
intro: Noise mapping data sources for Mali.
map: { center: [-2, 17], zoom: 5 }
---

## Road traffic

### Road defaults

Mali publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Mali's traffic factor **≈ 0.700** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.700 ≈ 21,000 |
| Trunk | 15,000 × 0.700 ≈ 10,500 |
| Primary | 9,000 × 0.700 ≈ 6,300 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Dakar-Niger Railway — ~640 km in Mali, meter gauge (1,000 mm). LARGELY DEFUNCT since 2018.

Only **Bamako↔Koulikoro** (60 km) has sporadic freight. Transrail concession collapsed. Senegal section rehabilitated but Mali section deteriorated. No metro, no tram.

| Context | pax/day | frt/day |
|---|---:|---:|
| **Bamako↔Koulikoro** (only active) | 0 | 2 |
| **Bamako↔Kayes** (mostly defunct) | 0 | 1 |
| **Kayes↔Kidira** (defunct) | 0 | 0 |

## Industrial

### GEM — 14 plants, operating, ~847 MW

Hydro 4 + oil/gas (HFO/diesel) 3 + solar 7. **Manantali 200 MW** (Senegal River, OMVS shared with Senegal+Mauritania). **Gouina 140 MW** (newest hydro). **Sirakoro 100 MW + Kayes 90 MW** (HFO/diesel). **Fekola Mine 64 MW** (B2Gold captive) + **Fekola Solar 30 MW** + **Loulo-Gounkoto Solar 40+20 MW** (Barrick — gold mine captive renewables). **Selingue 48 MW** hydro. **Felou 62 MW** hydro.

### Key sites not NACE classified
- **Gold mining** — Mali is **Africa's #3 gold producer**: Sadiola (Barrick/AngloGold), **Loulo-Gounkoto** (Barrick, one of Africa's largest gold complexes), **Fekola** (B2Gold), Morila, Kalana, Syama (Resolute)
- **CMDT cotton** — Mali is one of **Africa's top cotton producers** (#1-2, trading the lead with Benin year to year — Compagnie Malienne pour le Développement du Textile)
- **Cement**: CIMAF Dio, Diamond Cement Astro (Bamako)
- **Northern Mali crisis** — Tuareg/jihadist insurgency since 2012, French Barkhane withdrew 2022, Wagner Group/Africa Corps since 2021
- **Military junta since 2020/2021** — two coups, sanctions by ECOWAS (since lifted)
