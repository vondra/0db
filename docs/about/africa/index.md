---
title: Africa
intro: Noise mapping overview for Africa — global baseline only, no continental datasets available.
map: { center: [20, 5], zoom: 3 }
---

## Data situation

Africa has no continent-wide open transport or environmental data initiatives. Transit data is exceptionally sparse — most African transit systems are informal (minibuses, matatus, tro-tros) and not digitized. The noise map relies entirely on the global baseline.

## Continental enrichment

No usable datasets found. Research conducted 2026-04-10:

| Source | Status |
|--------|--------|
| South Africa Gautrain GTFS | Connection timeout |
| South Africa MyCiTi (OpenMobilityData) | Dead (XML error) |
| Kenya Digital Matatus (GitHub) | 404 |
| Cairo Metro (GitHub) | 404 |
| Lagos BRT (GitHub) | 404 |
| DigitalTransport4Africa | Project exists but no direct downloads |

## What the map uses (global baseline)

- **DEM**: Copernicus GLO-30 (30m) — terrain diffraction
- **Buildings**: GHSL 100m (Overture has near-zero height coverage in Africa)
- **Forest**: ESA WorldCover 10m — good coverage of tropical forests, savannas
- **Ground**: WorldCover-derived G-factor
- **Industrial**: GPPD power plants — NG 55, ZA 51, EG 44, ET 26, KE 23 plants
- **Traffic**: OSM road class defaults only
- **Railway**: OSM rail type defaults only

## Per-country enrichment priority

1. **South Africa** — most developed rail (PRASA Metrorail, Gautrain)
2. **Egypt** — Cairo Metro (3 lines, 77 stations)
3. **Kenya** — Digital Matatus mapped Nairobi matatu routes
4. **Morocco** — ONCF rail, Al Boraq HSR

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation.
