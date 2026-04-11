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

- **Source**: ArcGIS REST FeatureServer
- **Records**: 10,157 polyline segments (state highways SH-1 through SH-94)
- **Per-segment fields**: `trafficADTEst`, `loadingPcHeavy`, `lanes`, `roadName`, `ONRC`
- **License**: NZGOAL CC-BY 4.0 (Waka Kotahi)

#### Auckland Transport AADT (Auckland local roads)

[Auckland Transport AT GIS](https://data-atgis.opendata.arcgis.com/) publishes per-count-site AADT with **full vehicle class breakdown** (cars, light commercial, buses, HCV-I, HCV-II) — exceptional data quality for an open dataset.

- **Source**: GeoJSON (7.9 MB)
- **Records**: 13,624 traffic count points
- **Per-point fields**: `adt`, `pcheavy`, `pcbus`, `pccar`, `pclcv`, `pchcvi`, `pchcvii`, `road_name`
- **License**: CC-BY 4.0 (Auckland Transport)

### Result

- **403,826 road segments enriched** across 158 of 185 NZ hexes (24.86%)
- **Top corridors** (Auckland Northern Motorway / SH-1, around Newmarket/Penrose junction):
  - 109,366 AADT, 7% heavy
  - 102,735 AADT
  - 100,279 AADT
  - All 10 highest-traffic counts in Auckland CBD area

## Railway

### Multi-feed AT + Metlink GTFS

| Operator | Coverage | Source |
|---|---|---|
| **Auckland Transport (AT)** | Auckland suburban — Eastern, Western, Southern, Onehunga, Manukau lines | [gtfs.at.govt.nz](https://gtfs.at.govt.nz/gtfs.zip) (23 MB) |
| **Metlink Wellington** | Wellington commuter — Kāpiti, Hutt Valley, Wairarapa, Johnsonville, Melling | [static.opendata.metlink.org.nz](https://static.opendata.metlink.org.nz/v1/gtfs/full.zip) (19.8 MB) |

- **Result**: 119 unique stops, 4,979 segments enriched across 8 hexes
- **Busiest stops**:
  - **Waitematā Train Station** (Auckland Britomart) — 419 trains/day
  - **Wellington Station** — 374 trains/day
  - **Ōtāhuhu Station** (Auckland) — 277 trains/day
  - **Middlemore Station** (Auckland) — 274 trains/day
  - **Newmarket Station** (Auckland) — 251 trains/day

### KiwiRail long-distance gap

KiwiRail tourist services (**Northern Explorer**, **TranzAlpine**, **Coastal Pacific**) and freight schedules are NOT in any public GTFS feed. These corridors have very low frequency (~1-4 trains/day) and use OSM defaults. The TranzAlpine across the Southern Alps is one of the world's most scenic rail journeys but operates only daily.

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
