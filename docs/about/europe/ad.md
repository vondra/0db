---
title: Andorra
intro: Noise mapping data sources for Andorra.
map: { center: [1.52, 42.54], zoom: 11 }
---

## Road traffic

### Road defaults

Andorra publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Andorra's traffic factor **≈ 1.294** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.294 ≈ 38,820 |
| Trunk | 15,000 × 1.294 ≈ 19,410 |
| Primary | 9,000 × 1.294 ≈ 11,646 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Andorra has no railway.

The nearest rail connections are SNCF L'Hospitalet-près-l'Andorre (France, 10 km) and RENFE Lleida/La Pobla de Segur (Spain). Bus connections operated by Andorra-la-Vella Autocars.

## Industrial

### GEM — 2 plants, ~46 MW

- **FEDA Hydroelectric** — Forces Elèctriques d'Andorra operates several run-of-river hydroelectric stations on the Valira del Nord and Valira d'Orient rivers (~46 MW combined)
- **FEDA backup thermal** — small diesel/gas backup; below main GEM threshold

Andorra imports ~90% of its electricity from France and Spain via interconnection; FEDA hydro covers the remainder domestically.

## Validation

Andorra implements environmental noise regulation via:

- **Llei de protecció del medi ambient atmosfèric** (2004)
- **Reglament de soroll i vibracions** — ambient noise limits aligned broadly with WHO guidelines

Andorra la Vella (1,023 m) is the highest capital in Europe. Ski resorts — principally Grandvalira (210 km pistes, the Pyrenees' largest) and Vallnord — generate significant seasonal noise from snowcats, chairlift machinery, and après-ski venues. Duty-free shopping draws ~8M day-trippers/year, concentrated on the CG-1 corridor through Andorra la Vella.
