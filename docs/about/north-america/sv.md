---
title: El Salvador
intro: Noise mapping data sources for El Salvador.
map: { center: [-88.9, 13.8], zoom: 8 }
---

## Road traffic

### Road defaults

El Salvador publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by El Salvador's traffic factor **≈ 1.275** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.275 ≈ 38,250 |
| Trunk | 15,000 × 1.275 ≈ 19,125 |
| Primary | 9,000 × 1.275 ≈ 11,475 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Defunct. All railway traffic set to zero.

FENADESAL ceased operations 2002. Track mostly removed or overgrown.

## Industrial

### GEM — 60 plants, operating, ~2,563 MW

Geothermal 2 + hydro 8 + solar 22 + bioenergy/bagasse 10 + HFO 7 + wind 5 + coal 2 + gas 4. **Cerrón Grande hydro ~170 MW** (Lempa River, Chalatenango) — largest hydro; **15 de Septiembre hydro 156 MW** (Lempa River). **Berlín geothermal 109 MW** + **Ahuachapán geothermal 95 MW** — LaGeo, geothermal world rank #9.

### Key sites not NACE classified
- **Geothermal**: Ahuachapán, Berlín fields — regional geothermal leader
- **Sugar**: Santa Ana, Sonsonate — bagasse cogeneration (Ingenio La Cabaña, Ingenio Chaparrastique)
- **Coffee**: Santa Ana, Chalatenango, Usulután
- **Textiles/maquila**: San Marcos, San Bartolo free-trade zones
- **Bitcoin**: legal tender since 2021 (Chivo wallet) — crypto mining data centres
