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

### EU city traffic (from /enrich-global)

Zurich + Geneva AADT from EU harmonized dataset.

## Railway

### SBB/CFF GTFS (from /enrich-global)

Swiss national transit timetable from opentransportdata.swiss.

- **Stops**: 1,800+
- **Coverage**: All SBB/CFF/FFS rail services + BLS, SOB, regional operators
- **Applied**: trains_passenger in railways.arrow

## Validation

Switzerland has its own noise regulation (Lärmschutz-Verordnung LSV) with stricter limits than EU END. BAFU (Federal Office for the Environment) maintains the sonBASE national noise database covering road, rail, and aircraft noise.
