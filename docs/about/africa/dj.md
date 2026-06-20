---
title: Djibouti
intro: Noise mapping data sources for Djibouti.
map: { center: [42.5, 11.5], zoom: 7 }
---

## Road traffic

### Road defaults

Djibouti publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Djibouti's traffic factor **≈ 0.707** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.707 ≈ 21,210 |
| Trunk | 15,000 × 0.707 ≈ 10,605 |
| Primary | 9,000 × 0.707 ≈ 6,363 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Addis-Djibouti Railway handled by ET enrichment.

The **Addis-Djibouti Railway (EDR)** — 752 km electrified standard gauge (25 kV AC), opened 2018 — is modelled under Ethiopia (ET). The Djibouti segment (~100 km, Nagad → Doraleh) is not double-counted here.

## Industrial

### GEM — 2 plants, operating, 167 MW

**Boulaos** (HFO, Djibouti City — the main thermal plant, ~108 MW per GEM) + **Marabout** (HFO, Djibouti City). Both EDD-operated; Djibouti also imports across the Ethiopia interconnector. Economy is entirely port services + military base rents; no significant manufacturing.

### Key infrastructure not NACE classified
- **Doraleh Container Terminal (DCT)** — among Africa's busiest; DP World (2006–2018), then state-managed
- **Doraleh Multi-Purpose Port (DMPP)** — Chinese-built (2017); CIDCO joint venture
- **US Camp Lemonnier** (~4,000 troops, largest US base in Africa) — adjacent to Djibouti-Ambouli Airport
- **French Base Aéronavale** (oldest foreign base; ~1,500 troops)
- **Chinese PLA Support Base** (2017 — China's first overseas military base)
- **Japanese JMSDF Base** (anti-piracy operations)
- **Lac Assal Salt** — −155 m (lowest point in Africa); saltiest non-volcanic lake
