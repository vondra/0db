---
title: Republic of Congo
intro: Noise mapping data sources for the Republic of the Congo (Congo-Brazzaville).
map: { center: [15, -1], zoom: 6 }
---

## Road traffic

### Road defaults

Republic of Congo publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Republic of Congo's traffic factor **≈ 0.717** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.717 ≈ 21,510 |
| Trunk | 15,000 × 0.717 ≈ 10,755 |
| Primary | 9,000 × 0.717 ≈ 6,453 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### CFCO Brazzaville↔Pointe-Noire — ~510 km, cape gauge (1,067 mm). Built 1921-1934 (French forced labor — 17,000-23,000 deaths).

Connects Congo River navigation to Atlantic port. **Bilinga↔Mbinda branch** (~285 km, near the Gabon border) was built to feed COMILOG manganese to the Trans-Gabon Railway; that traffic ceased after the 1991 Mvoungouti disaster (Gabon now exports via its own line), leaving the branch to general/local freight.

| Context | pax/day | frt/day |
|---|---:|---:|
| **CFCO Main** (Brazzaville↔Pointe-Noire) | 2 | 3 |
| **Bilinga↔Mbinda** (manganese) | 0 | 2 |

## Industrial

### GEM — 7 plants, operating, ~730 MW

Gas 4 + hydro 2 + solar 1. **CEC Pointe-Noire** (3 gas units 170+157+157 MW + **CNGCC 50 MW** = ~534 MW, powered by associated gas from offshore oil). **Imboulou 120 MW** hydro (Léfini River). **Moukoukoulou 74 MW** hydro. **Kabo solar 2 MW** (northern CG).

### Key sites not NACE classified
- **Oil**: TotalEnergies, ENI Congo — offshore Pointe-Noire, significant African oil producer
- **Logging/timber**: northern equatorial forest (Sangha Trinational UNESCO)
- **Sugar**: SARIS (Nkayi — Congo's only sugar refinery)
- **Cement**: Forspak (Dolisie/Niari); SONOCC (Loutété)
- **Potash**: MagMinerals (Mengo project — abandoned after the company's 2015 financial collapse)
