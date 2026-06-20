---
title: Bosnia and Herzegovina
intro: Noise mapping data sources for Bosnia and Herzegovina.
map: { center: [17.8, 44.0], zoom: 8 }
---

## Road traffic

### Road defaults

Bosnia and Herzegovina publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Bosnia and Herzegovina's traffic factor **≈ 0.904** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.904 ≈ 27,120 |
| Trunk | 15,000 × 0.904 ≈ 13,560 |
| Primary | 9,000 × 0.904 ≈ 8,136 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### ŽFBiH + ŽRS ~1,000 km standard gauge. **Sarajevo tram** (1885 origin — one of Europe's oldest, rebuilt after siege).

| Context | pax/day | frt/day |
|---|---:|---:|
| **Sarajevo tram** | 100 | 0 |
| **Sarajevo↔Zenica↔Doboj** | 4 | 5 |
| **Sarajevo↔Mostar** | 2 | 3 |
| Other | 1 | 2 |

## Industrial

### GEM — 157 plants, 45 operating, ~4.54 GW

Coal 10 + hydro 13 + solar 18 + wind 4. **Tuzla 640 + Kakanj 340 + Gacko/Stanari/Ugljevik 300 each** (coal). **Neretva cascade**: Čapljina 440 + Salakovac 210 + Jablanica 180 + Grabovica 114. **Two-entity**: FBiH EP BiH + RS EP RS.

### Key sites not NACE classified
- ArcelorMittal Zenica (steel), RMU Banovići (coal mine), HeidelbergCement Banja Luka, Alumina Zvornik
