---
title: Libya
intro: Noise mapping data sources for Libya.
map: { center: [17, 27], zoom: 5 }
---

## Road traffic

### Road defaults

Libya publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Libya's traffic factor **≈ 1.160** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.160 ≈ 34,800 |
| Trunk | 15,000 × 1.160 ≈ 17,400 |
| Primary | 9,000 × 1.160 ≈ 10,440 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### All projects suspended — no operational railway.

Gaddafi-era railway plans (China Railway Construction Corp contracts, 2008) included coastal Tripoli–Misrata–Sirte–Benghazi + south Misrata–Sabha–Niger routes. **All suspended after 2011** and never resumed. Libya remains one of Africa's largest countries by area with zero operational rail. Not modelled.

## Industrial

### GEM — 72 plants, operating, 14,417 MW

Libya has **Africa's largest proven oil reserves** (~48 billion barrels). The industrial fleet is dominated by gas turbines and combined-cycle plants fuelled by associated gas and LNG.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **West Tripoli (Janzour)** | ~380 | gas | GT units operating (GT1/GT2 + mobile); a 4×350 MW steam block is still under construction |
| **Khoms Power Station** | 1,000 | gas | Mediterranean coast, east of Tripoli |
| **Zawiya Power Station** | 1,000 | gas/HFO | Western; adjacent to oil refinery |
| **Misrata Power Station** | 1,000 | gas | Western port city |
| **Benghazi North** | 900 | gas | Eastern grid (GECOL) |
| **Tobruk Power Station** | 400 | HFO/gas | Far eastern grid |
| **Sabha Power Station** | 200 | HFO | Southern Fezzan grid |

All operating plants map to **NACE 35**.

### Key infrastructure not NACE classified
- **National Oil Corporation (NOC)** — controls all upstream oil; Sarir, Sirte, Murzuq, Elephant fields
- **Zawiya Oil Refinery** (~120,000 bbl/day — largest in Libya)
- **Ras Lanuf Refinery + Petrochemical Complex** (eastern Libya; frequently contested/damaged)
- **Mellitah LNG + Greenstream Pipeline** (520 km undersea to Sicily; 8 Bcm/yr capacity)
- **Waha Oil Company** (ConocoPhillips + Marathon + Hess + NOC) — Sirte Basin
- **Akakus Oil Operations** (Repsol + OMV + NOC) — Murzuq Basin
- **Great Man-Made River (GMMR)** — 4,000 km buried pipe; Nubian Sandstone fossil water to coast; 6.5M m³/day
- **Mitiga International Airport** (MJI, Tripoli) + **Benina International** (BEN, Benghazi) — covered by global aircraft layer

### Libya does NOT have
- **No railway** — all Gaddafi-era CRCC contracts cancelled post-2011
- **No GTFS** — no public transit system
- **No AADT** — both governments publish no traffic data
