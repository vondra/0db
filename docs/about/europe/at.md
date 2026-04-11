---
title: Austria
intro: Noise mapping data sources for Austria.
map: { center: [13.3, 47.5], zoom: 7 }
---

## Road traffic

### ASFINAG Verkehrsstatistik

[ASFINAG](https://www.asfinag.at/verkehr-sicherheit/verkehrszaehlung/) publishes annual motorway traffic statistics.

- **Coverage**: ~600 counting stations on Autobahnen (A) and Schnellstraßen (S)
- **Vehicle classes**: Kfz total, Kfz > 3.5t (heavy), Kfz ≤ 3.5t (light)
- **Format**: Excel (XLS) with annual + monthly breakdowns
- **Year**: 2024 (also 2012-2023 available)
- **Status**: Cached. Needs km-marker → coordinate conversion for OSM matching.

### EU city traffic (from /enrich-global)

Vienna AADT from EU harmonized dataset.

### BMK Dauerzählstellen

Federal ministry publishes automatic traffic counting results for Bundesstraßen. Available at bmimi.gv.at as PDF reports — machine-readable format needed.

## Railway

### ÖBB GTFS (from /enrich-global)

Austrian Federal Railways timetable from ÖBB Open Data.

- **Stops**: 1,662
- **Applied**: trains_passenger in railways.arrow
- **Source**: static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_OP_2025_obb.zip

## Validation

Austria implements END via Bundes-Umgebungslärmschutzgesetz (Bundes-LärmG). Strategic noise maps produced by BMIMI and state governments.
