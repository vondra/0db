---
title: Luxembourg
intro: Noise mapping data sources for Luxembourg.
map: { center: [6.1, 49.8], zoom: 10 }
---

## Railway & transit

### National unified GTFS

Luxembourg publishes a single GTFS feed covering all public transport, originating from [data.public.lu](https://data.public.lu/en/datasets/horaires-et-arrets-des-transport-publics-gtfs/) and pulled via its Mobility Database mirror (`mdb-1108`). Applied as one of the continental GTFS feeds via `/enrich-continent europe`.

- **Operators**: CFL (Chemins de Fer Luxembourgeois) rail + Luxtram + RGTR + Ville de Luxembourg buses
- **Coverage**: 5 rail routes, 1 tram, 565 bus routes, 2,792 stops
- **Result**: 3,207 railway/tram segments enriched across 7 hexes
- **License**: Open (data.public.lu)

Luxembourg is the first country in the world with **completely free public transport** (since March 2020).

## Road traffic

### EU city traffic (continental)

Luxembourg city AADT from the EU harmonized 36-city dataset, applied via `/enrich-continent europe`. 9,794 road segments with real traffic counts. This is city-level coverage for the capital, not national. Elsewhere, roads use OSM class + CNOSSOS defaults.

## Industrial

- **E-PRTR** — Luxembourg regulated facilities (metals, chemical, waste, food, etc.) with NACE codes, applied via `/enrich-continent europe`
- **GPPD** — power plants (NACE 35) via `/enrich-global`

## Validation

Luxembourg implements END via law of 2 August 2006 on environmental noise. Strategic noise maps produced by the Ministry of Mobility and Public Works.
