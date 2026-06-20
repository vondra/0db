---
title: Moldova
intro: Noise mapping data sources for Moldova.
map: { center: [28.8, 47.0], zoom: 8 }
---

## Road traffic

### Road defaults

Moldova publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Moldova's traffic factor **≈ 1.201** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.201 ≈ 36,030 |
| Trunk | 15,000 × 1.201 ≈ 18,015 |
| Primary | 9,000 × 1.201 ≈ 10,809 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### CFM ~1,150 km broad gauge 1,520mm — Soviet-era. NO metro, NO tram. Chișinău↔Tiraspol runs through Transnistria.

| Context | pax/day | frt/day |
|---|---:|---:|
| **Main line** (Chișinău hub) | 4 | 5 |
| Other | 1 | 2 |

## Industrial

### GEM — 28 plants, 18 operating, ~1.24 GW

Oil/gas 7 + solar 10 + hydro 1. **Kuchurgan/MGRES 910 MW** (IN **TRANSNISTRIA** — ~73% of Moldova's installed capacity is Russian-controlled!). **Chișinău CHP 258 MW**. **Dubăsari hydro 48 MW** (also Transnistria). 10 tiny solar (2-5 MW).

### Key sites not NACE classified
- **Moldova Steel Works** (Rîbnița, Transnistria — Russian-controlled)
- **Transnistria controls ~73% of Moldova's installed generation** — extreme geopolitical energy vulnerability
- **No significant heavy industry** in Moldova proper — economy is agriculture + wine + remittances
- **Wine** — one of Europe's largest by vineyard area per capita (Cricova, Mileștii Mici — world's largest wine cellars)
- **~30% of GDP from diaspora remittances**
