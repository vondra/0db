---
title: Switzerland
intro: Noise mapping data sources for Switzerland.
map: { center: [8.2, 46.8], zoom: 8 }
---

## Road traffic

### SARTC (Swiss Automatic Road Traffic Counts)

[ASTRA](https://www.astra.admin.ch/) operates ~500 permanent counting stations on Nationalstrassen and Hauptstrassen.

- **Data**: Monthly + annual ADT with heavy vehicle (HV/HGV) breakdown
- **Format**: Excel (XLSX) from astra.admin.ch
- **Year**: 2025 annual bulletin
- **Status**: Cached. Needs coordinate extraction from ASTRA ArcGIS dashboard for OSM matching.
- **ArcGIS map**: [Counting station locations](https://www.arcgis.com/apps/dashboards/1673b262537546098589ad3820e5ece2)

### EU city traffic (continental)

Zurich + Geneva AADT from the EU harmonized 36-city dataset, applied via `/enrich-continent europe`. This is the **only road traffic currently applied** for Switzerland — Zurich and Geneva street-segment AADT, not national coverage. The SARTC counts above are cached but not yet matched to OSM geometry. Outside these two cities, roads use OSM class + CNOSSOS defaults.

## Railway

### SBB/CFF GTFS (continental)

Swiss national transit timetable from opentransportdata.swiss, applied as one of the continental GTFS feeds via `/enrich-continent europe`.

- **Stops**: 1,800+
- **Coverage**: All SBB/CFF/FFS rail services + BLS, SOB, regional operators
- **Applied**: trains_passenger in railways.arrow

## Industrial

- **E-PRTR** — Swiss regulated facilities (cement, metals, chemical, waste, food, paper) with NACE codes, applied via `/enrich-continent europe`
- **GPPD** — power plants (NACE 35) via `/enrich-global`

## Validation

Switzerland has its own noise regulation (Lärmschutz-Verordnung LSV) with stricter limits than EU END. BAFU (Federal Office for the Environment) maintains the sonBASE national noise database covering road, rail, and aircraft noise.
