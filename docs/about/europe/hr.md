---
title: Croatia
intro: Noise mapping data sources for Croatia.
map: { center: [16.0, 45.2], zoom: 7 }
---

## Railway

### HŽ GTFS

National railway timetable from [Hrvatske željeznice Putnički prijevoz](https://www.hzpp.hr/).

- **Source**: `hzpp.hr/GTFS_files.zip`
- **Coverage**: 140 rail routes, 461 stops, 451 with train counts
- **Result**: 8,831 railway segments enriched across 39 hexes
- **Busiest**: Zagreb Glavni kolodvor 266 trains/day, Dugo Selo 133, Maksimir 119
- **License**: Open (data.gov.hr)

## Road traffic

Hrvatske ceste publishes only aggregate reports. OSM road class defaults applied.

## Industrial

- **E-PRTR** (European Pollutant Release and Transfer Register) — NACE 2-digit sector codes (steel, cement, chemical, waste, food, etc.) for Croatian industrial sites, matched to OSM within 2 km via the continental industrial pass (`enrich-global-industrial.ts`).
- **GPPD** (WRI Global Power Plant Database) — power plants with NACE 35 (energy) via `/enrich-global`.

## Validation

Croatia implements END via the Law on Protection against Noise (NN 30/09, 55/13). Strategic noise maps produced by HAOP (Environment and Energy Efficiency Fund).
