---
title: United States
intro: Noise mapping data sources for the United States.
map: { center: [-98.0, 39.0], zoom: 4 }
---

## Road traffic

### FHWA HPMS 2022 (Highway Performance Monitoring System)

The [Federal Highway Administration](https://www.fhwa.dot.gov/) publishes **HPMS** — the federal database for all US National Highway System and federal-aid highways. It contains per-segment AADT, functional class, lane count, and facility type.

- **Source**: ArcGIS REST FeatureServer at [services.arcgis.com/.../HPMS_FULL_US_2022_Sysnomulti_view](https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/HPMS_FULL_US_2022_Sysnomulti_view/FeatureServer/0)
- **Records**: 235,257 polyline segments
- **Coverage**: NHS + F_SYSTEM 1-5 (Interstate through Major Collector) across all 50 states + Alaska + Hawaii + Puerto Rico
- **Pagination**: 2,000 segments per page × 119 pages = ~329 MB total
- **Result**: **6,901,846 road segments enriched** across 3,533 of 8,143 US hexes
- **Top corridors** (the busiest US freeways):
  - **I-285 Atlanta** (Tom Moreland / Spaghetti Junction) — **398,000 AADT**
  - **I-405 Los Angeles** (West LA) — **386,600 AADT**
  - **I-10 Phoenix** — **384,286 AADT**
  - **I-405 Long Beach** — **372,000 AADT**
  - **I-75 Atlanta downtown** — **367,000 AADT**
- **License**: Public domain (US federal work, 17 USC §105)

Vehicle class breakdown is derived from F_SYSTEM functional class using CNOSSOS-EU Part 2 Table 2.3 defaults:

| F_SYSTEM | Class | Heavy share |
|---|---|---|
| 1 | Interstate | 12% |
| 2 | Principal Arterial Other Freeway | 10% |
| 3 | Principal Arterial Other | 8% |
| 4 | Minor Arterial | 6% |
| 5 | Major Collector | 5% |

### Gaps

HPMS only covers NHS + F_SYSTEM 1-5. **Local streets** (Minor Collector + Local roads) use OSM `maxspeed` + class defaults — most US urban street miles are unenriched. State DOT data would be required to fill this gap.

## Railway

### Continental rail enrichment

US passenger rail is concentrated in:
- **Amtrak Northeast Corridor** (Boston ↔ Washington DC)
- **Commuter rail** systems: LIRR, NJ Transit, MBTA, Metra (Chicago), MARC, Caltrain, BART, WMATA, MUNI
- **Heavy metro**: NYC Subway, Chicago L, BART, WMATA, MARTA, MUNI

The pipeline does not currently apply a US-specific railway enrichment. Continental enrichment provides sparse coverage of major Amtrak routes and some commuter operators. To improve coverage, GTFS feeds from individual transit agencies (NYC MTA, Chicago Metra, Boston MBTA, etc.) would need to be ingested.

US rail noise primarily comes from freight operations (BNSF, Union Pacific, CSX, Norfolk Southern) which do not publish public schedules.

## Buildings

[Overture Maps](https://overturemaps.org/) building footprints (Microsoft + Google + Meta + LBNL contribution) are applied via `/enrich-global`. The Overture dataset includes US per-building polygons with LiDAR-derived heights for many cities.

The Microsoft Building Footprints dataset (1.4B buildings worldwide, 130M in US) is also accessible via this pipeline path.

## Industrial

### Wind turbines — USWTDB

The [US Wind Turbine Database](https://eerscmap.usgs.gov/uswtdb/) (USWTDB) is a joint product of USGS, LBNL, and DOE. It contains every operating wind turbine in the United States with rated power, hub height, rotor diameter, manufacturer, and model.

- **Source**: [eerscmap.usgs.gov/uswtdb](https://eerscmap.usgs.gov/uswtdb/)
- **Records**: 75,728 turbines
- **Per-turbine fields**: `t_cap` (rated power kW), `t_hh` (hub height m), `t_rd` (rotor diameter m), `t_manu` (manufacturer), `t_model`, `t_offshore`
- **Result**: **80,682 / 87,527 OSM wind turbines** in US hexes have specs (**92.2% coverage**) — the highest of any country in the pipeline
- **Combined enrichment**: ~78,751 from global pass + 1,931 newly matched in US-specific run
- **License**: Public domain

The US has 150+ GW installed wind capacity (largest after China), with major concentrations in Texas (West Texas wind belt), Iowa, Oklahoma, Kansas, California (Tehachapi, Altamont), and offshore on the East Coast.

### Power plants — GPPD

WRI Global Power Plant Database covers ~10,000 US power plants via `/enrich-global` — coal, gas, nuclear, hydro, solar, and biomass facilities.

### EPA TRI (gap)

The [EPA Toxics Release Inventory](https://www.epa.gov/toxics-release-inventory-tri-program) provides facility-level NAICS codes for ~22,000 US facilities reporting toxic chemical releases. Not yet integrated.

## Validation

The US does not implement END (the EU Environmental Noise Directive). Noise mapping at federal level is fragmented:

- **EPA Noise Pollution Clearinghouse** — historical reference
- **FHWA Traffic Noise Model (TNM)** — used for federal highway noise impact assessments
- **FAA Aviation Environmental Design Tool (AEDT)** — airport noise contours
- **DOT National Transportation Noise Map** ([noise.bts.gov](https://noise.bts.gov)) — combined road + aviation noise exposure published by Bureau of Transportation Statistics, useful as a validation reference

The DOT National Transportation Noise Map at `noise.bts.gov` is the closest analog to European END noise maps and provides a national reference for spot validation.
