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

### EU city traffic (continental)

Vienna AADT from the EU harmonized 36-city dataset, applied via `/enrich-continent europe`. This is the **only road traffic currently applied** for Austria — Vienna street-segment AADT, not national coverage. ASFINAG and BMK counts above are cached but not yet matched to OSM geometry. Outside Vienna, roads use OSM class + CNOSSOS defaults.

### BMK Dauerzählstellen

Federal ministry publishes automatic traffic counting results for Bundesstraßen. Available at bmimi.gv.at as PDF reports — machine-readable format needed.

## Railway

### ÖBB GTFS (continental)

Austrian Federal Railways timetable from ÖBB Open Data, applied as one of the continental GTFS feeds via `/enrich-continent europe`.

- **Stops**: 1,662
- **Applied**: trains_passenger in railways.arrow
- **Source**: static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_OP_2025_obb.zip

## Industrial

- **E-PRTR** — Austrian regulated facilities (cement, metals, chemical, waste, food, paper) with NACE codes, applied via `/enrich-continent europe`
- **GPPD** — power plants (NACE 35) via `/enrich-global`

## Validation

Austria implements END via Bundes-Umgebungslärmschutzgesetz (Bundes-LärmG). Strategic noise maps produced by BMIMI and state governments.
