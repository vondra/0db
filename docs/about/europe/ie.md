---
title: Ireland
intro: Noise mapping data sources for Ireland.
map: { center: [-8.0, 53.5], zoom: 7 }
---

## Road traffic

### TII Counter Sites + Daily Class Aggregate

[Transport Infrastructure Ireland (TII)](https://data.tii.ie/) operates ~430 traffic counters on the Irish national road network (motorways M-, primary N-, secondary R-). Per-site daily counts are published with vehicle class breakdown going back to 2013 under CC-BY 4.0.

- **Counter sites JSON**: [data.tii.ie/.../tmu-sites.json](https://data.tii.ie/Datasets/TrafficCountData/sites/tmu-sites.json) — 422 sites with WGS84 coordinates and TMU descriptive names
- **Per-site daily aggregate**: 2019-06-19 (pre-COVID typical weekday) used as AADT proxy
- **Result**: 327 active counter sites, 148,598 enriched road segments
- **Top corridors**:
  - **M50 Dublin orbital** — 170,599 vehicles/day (Finglas, M50/N3 junction)
  - **M1 Dublin Airport link** — 153,689 vehicles/day
  - **N7 Citywest** — 123,789 vehicles/day
  - **N4 Liffey Valley** — 116,005 vehicles/day

### EU city traffic (continental)

Cerema-aggregated EU AADT for Dublin city centre arterials via `/enrich-continent europe`.

### Gaps

TII counters cover only M, N and a handful of R roads (national network). Local L roads use OSM `maxspeed` + class defaults. The latest open daily CSVs end in 2020 — newer counts are reCAPTCHA-protected at trafficdata.tii.ie.

## Railway

### NTA Transport for Ireland unified GTFS

[NTA (National Transport Authority)](https://www.transportforireland.ie/) publishes a single unified GTFS containing **all** Irish public transport in one file (175 MB), updated daily.

- **Source**: [transportforireland.ie/transitData/Data/GTFS_All.zip](https://www.transportforireland.ie/transitData/Data/GTFS_All.zip)
- **Operators**:
  - **Iarnród Éireann (IÉ)** — national rail incl. DART (Dublin Area Rapid Transit electrified suburban)
  - **Luas** — Dublin tram (Red Line + Green Line)
  - Dublin Bus, Bus Éireann, Go-Ahead Ireland — buses (not used for rail enrichment)
- **Result**: 272 unique rail/tram stops, 10,913 enriched railway segments
- **Busiest hubs**:
  - **Jervis** (Luas Red Line, Dublin) — 581 trains/day
  - **Four Courts** (Luas Red Line) — 581 trains/day
  - **Dublin Connolly** (Iarnród Éireann main station) — 452 trains/day
  - **The Point** (Luas Red Line terminus) — 445 trains/day
  - **Spencer Dock** (Luas) — 445 trains/day

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Dublin | 55.9% | 581 (Luas Jervis) |
| Cork | 38.4% | 169 (Cork Kent intercity) |
| Galway | 15.8% | 40 |
| Sligo | 14.2% | 16 |
| Kilkenny | 11.8% | 16 |
| Drogheda | 11.0% | 96 |
| Waterford | 7.1% | 20 |
| Limerick | 6.9% | 58 |

## Buildings

GHSL Built-H R2023A 100 m global raster + sparse OSM `building:levels`. **Tailte Éireann** (formerly Ordnance Survey Ireland) publishes 3.7M building polygon footprints via ArcGIS REST but **no per-building heights or floor counts**. The commercial GeoDirectory is the only Irish source with building attributes.

## Industrial

- **EPA Ireland**: Publishes a [WFS GeoJSON endpoint](https://gis.epa.ie/geoserver/EPA/wfs) with 658 PRTR sites and IED-licensed facilities, but coverage duplicates the continental E-PRTR layer applied via `/enrich-continent europe`.
- **Wind turbines**: Ireland has ~5 GW installed wind capacity (4th in EU per capita). [SEAI](https://www.seai.ie/) publishes a wind farm centroids dataset (335 farms with installed capacity MW, June 2022) but **no per-turbine coordinates or specs**. All turbines use OSM `power=generator` locations + global defaults.
- **EPA already publishes END Round 4 industrial noise contours** (`EPA:Noise_R4_Industry_Agglomerations_Lden`/`Lnight`) via the same WFS — useful as validation reference.

## Validation

Ireland implements END (Environmental Noise Directive 2002/49/EC) via the European Communities (Environmental Noise) Regulations 2018 (S.I. 549/2018). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced every 5 years by:

- **EPA Ireland** — national aggregator, publishes maps via [gis.epa.ie/EPAMaps](https://gis.epa.ie/EPAMaps/)
- **Local authorities** — Dublin, Cork, Limerick, Galway, Waterford agglomerations

The Dublin M50 ring road and DART corridor are Ireland's most noise-affected zones. EPA's END Round 4 noise maps are available as WFS GeoJSON for direct comparison.
