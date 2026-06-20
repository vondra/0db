---
title: Brunei
intro: Noise mapping data sources for Brunei Darussalam.
map: { center: [114.7, 4.5], zoom: 9 }
---

## Road traffic

### Road defaults

Brunei publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Brunei's traffic factor **≈ 1.274** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.274 ≈ 38,220 |
| Trunk | 15,000 × 1.274 ≈ 19,110 |
| Primary | 9,000 × 1.274 ≈ 11,466 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Brunei has no passenger railway.

A small private narrow-gauge industrial line serves the Seria oilfield (Brunei Shell Petroleum) but carries no passengers and is not in OSM.

## Industrial

### GEM — 8 plants, ~436 MW

Brunei's power generation is entirely gas-fired, supplied by Brunei Shell Petroleum:

- **Berakas Power Station** — combined-cycle gas turbines; main Bandar Seri Begawan supply
- **Lumut Power Station** — major gas turbine complex serving the Seria/Kuala Belait belt

Beyond power plants, the dominant industrial noise sources are:

- **Seria Oilfield** — onshore production since 1929; compressors, pumps, gas flaring
- **Brunei LNG (Lumut)** — one of the world's first and largest LNG plants; gas turbine compressors and liquefaction trains are major broadband noise sources
- **BSP offshore platforms** (Champion, Fairley, Gannet fields) — covered under offshore; not in land model

## Notes

Brunei Darussalam is a Malay Islamic Monarchy (MBI sultanate). The Sultan's palace, Istana Nurul Iman (1,788 rooms), is the world's largest residential palace. Brunei is split into two non-contiguous territories by Malaysian Sarawak; the Temburong Bridge (2020) provides the first fixed crossing. No noise directive equivalent to EU END — regulation via the Environmental Protection and Nature Conservation Act (Cap 213).
