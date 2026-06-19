---
title: Bulgaria
intro: Noise mapping data sources for Bulgaria.
map: { center: [25.5, 42.7], zoom: 7 }
---

## Railway

### Sofia Traffic GTFS

Urban transit in the capital (metro, tram, trolleybus) from [Sofia Traffic](https://www.sofiatraffic.bg/).

- **Source**: `gtfs.sofiatraffic.bg/api/v1/static`
- **Coverage**: 4 metro lines, 23 tram routes, 335 stops
- **Result**: 6,505 tram/metro segments enriched in Sofia (2 hexes)
- **Busiest**: Пл. Македония 645 trains/day, МС К. Величков 456
- **License**: Open

### National rail (BDZ)

Bulgarian State Railways does not publish GTFS. Main corridors (Sofia-Plovdiv-Burgas, Sofia-Varna, Sofia-Ruse) not enriched.

## Road traffic

API (Agency for Road Infrastructure) does not publish per-segment AADT. OSM defaults applied.

## Industrial

- **E-PRTR** (European Pollutant Release and Transfer Register) — NACE 2-digit sector codes for Bulgarian industrial facilities (Kremikovtsi-area metallurgy, Devnya cement, Burgas refinery, copper smelting) via `/enrich-continent europe`
- **GPPD power plants** (NACE 35) via `/enrich-global`

## Validation

Bulgaria implements END via the Law on Protection from Environmental Noise (Закон за защита от шума в околната среда).
