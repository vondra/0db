---
title: New Zealand
intro: Noise mapping data sources for New Zealand.
map: { center: [172.0, -41.0], zoom: 5 }
---

## Road traffic

### NZTA Carriageway + Auckland Transport AADT

New Zealand has world-class open road data via two complementary sources:

#### NZTA Waka Kotahi (state highways)

[NZTA Open Data Portal](https://opendata-nzta.opendata.arcgis.com/) publishes the GEO_MASTER_GIS_Carriageway service with per-segment AADT, heavy vehicle share, lane count, and ONRC (One Network Road Classification) for the entire state highway network.

- **Source**: ArcGIS REST FeatureServer (`GEO_MASTER_GIS_Carriageway`)
- **Records**: ~10,800 polyline segments (state highways SH-1 through SH-94)
- **Per-segment fields**: `trafficADTEst`, `loadingPcHeavy`, `lanes`, `roadName`, `ONRC`
- **License**: NZGOAL CC-BY 4.0 (Waka Kotahi)

#### Auckland Transport AADT (Auckland local roads)

[Auckland Transport AT GIS](https://data-atgis.opendata.arcgis.com/) publishes per-count-site AADT with **full vehicle class breakdown** (cars, light commercial, buses, HCV-I, HCV-II) — exceptional data quality for an open dataset.

- **Source**: GeoJSON (7.9 MB)
- **Records**: ~13,700 traffic count points
- **Per-point fields**: `adt`, `pcheavy`, `pcbus`, `pccar`, `pclcv`, `pchcvi`, `pchcvii`, `road_name`
- **License**: CC-BY 4.0 (Auckland Transport)

### Result

- Surveyed segments (motorway/trunk/primary/secondary/tertiary, the NZTA + AT coverage classes) get per-segment AADT by nearest-count match; the rest stay at class defaults. Enrichment spans the populated NZ hexes (~158 of 185); a large minority of scanned segments match a count, the remainder fall back to defaults.
- **Top corridors** (Auckland Northern Motorway / SH-1, around Newmarket/Penrose junction):
  - 109,366 AADT, 7% heavy
  - 102,735 AADT
  - 100,279 AADT
  - All 10 highest-traffic counts in Auckland CBD area

## Railway

### Line-type defaults (GTFS not yet ingested)

New Zealand commuter rail GTFS is published — **Auckland Transport (AT)** ([gtfs.at.govt.nz](https://gtfs.at.govt.nz/gtfs.zip), Eastern/Western/Southern/Onehunga/Manukau lines) and **Metlink Wellington** ([opendata.metlink.org.nz](https://opendata.metlink.org.nz/), Kāpiti/Hutt Valley/Wairarapa/Johnsonville/Melling) — but the feed URLs have shifted and **no NZ rail feed is ingested in this pass**. NZ rail therefore uses CNOSSOS line-type defaults (no per-line frequencies yet). Wiring up the current AT + Metlink GTFS endpoints is the top NZ railway priority.

### KiwiRail long-distance

KiwiRail tourist services (**Northern Explorer**, **TranzAlpine**, **Coastal Pacific**) and freight schedules are NOT in any public GTFS feed either. These corridors run at very low frequency (~1-4 trains/day). The TranzAlpine across the Southern Alps is one of the world's most scenic rail journeys but operates only daily.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints (already in `/enrich-global`). LINZ NZ Building Outlines at [data.linz.govt.nz/layer/101290](https://data.linz.govt.nz/layer/101290-nz-building-outlines/) has 3.3M building polygons but no heights — Overture is preferred for its LiDAR-derived heights via the Microsoft Building Footprints merge.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers NZ plants. Major sources of industrial noise:

- **Hydroelectric (dominant)**: Manapouri (West Arm, 850 MW, NZ's largest), Clyde, Roxburgh, Benmore, Aviemore, Waitaki, Ohau A/B/C
- **Geothermal**: Wairakei, Ohaaki, Mokai, Nga Awa Purua, Te Mihi (Taupō Volcanic Zone)
- **Gas**: Huntly, Stratford, Otahuhu (decommissioned)
- **Wind**: Tararua, West Wind, Te Apiti, Mahinerangi, White Hill, Mt Stuart

### Wind turbines

NZ has ~1 GW installed wind capacity. **No NZ government open per-turbine dataset exists** (verified EECA, MBIE, Electricity Authority EMI, data.govt.nz, MfE, LINZ, Koordinates). OSM has 649 wind generator nodes covering Tararua, West Wind, Te Apiti, Mahinerangi, White Hill, etc. — used as primary source via `/enrich-global` global wind turbine pass.

### NACE/Pollutant inventory (gap)

NZ has **no national point-source pollutant inventory** equivalent to Australia's NPI, EU's E-PRTR, or US TRI. Confirmed across MfE data service, Stats NZ, MBIE. OSM `landuse=industrial` + `man_made=works` provides screening geometry without sector classification.

## Validation

NZ does not implement END (the EU Environmental Noise Directive). Noise regulation:

- **Resource Management Act 1991** (RMA) — federal environmental framework
- **NZS 6802:2008** Acoustics — Environmental Noise — national standard
- **Council bylaws** — Auckland Council, Wellington City Council, Christchurch City Council publish noise complaint statistics
- **Airport noise** — Auckland Airport publishes ANEC contours under their AAA noise management plan
