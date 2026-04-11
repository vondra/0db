---
title: Denmark
intro: Noise mapping data sources for Denmark.
map: { center: [9.5, 56.0], zoom: 7 }
---

## Road traffic

### Vejdirektoratet Mastra

[Vejdirektoratet](https://www.vejdirektoratet.dk/) (Danish Road Directorate) operates the **Mastra** national traffic count system, jointly with Danish municipalities. Per-station AADT, ÅDT (årsdøgnstrafik), heavy truck counts (`LBIL_AADT`), and speed measurements are published openly via WFS GeoServer.

- **Source**: [vmgeoserver.vd.dk/geosmastra/opendata/ows](https://vmgeoserver.vd.dk/geosmastra/opendata/ows) (`OPEN_DATA_NOEGLETAL_VIEW`)
- **Catalog**: [opendata.dk/vejdirektoratet/taellinger-nogletal-mastra](https://www.opendata.dk/vejdirektoratet/taellinger-nogletal-mastra)
- **CRS**: EPSG:25832 (ETRS89/UTM32N), reprojected to WGS84 via proj4
- **Pagination**: 22,089 measurement records 2023-2025, downloaded in 8 pages of 3,000
- **Result**: 5,912 unique stations → 173,893 enriched road segments (53 of 71 Danish hexes)
- **Top corridors**:
  - **VEJNR=10** (Køge Bugt Motorvejen) — 147,023 vehicles/day
  - **VEJNR=3** (Helsingørmotorvejen) — 123,709 vehicles/day
  - København motorring + inner ring sections all >100k

### EU city traffic (continental)

Cerema-aggregated EU AADT for København + Aarhus via `/enrich-continent europe` (~5,662 segments preserved).

## Railway

### Rejseplanen unified GTFS

[Rejseplanen](https://www.rejseplanen.dk/) is the Danish national journey planner. They publish a single unified GTFS containing **all** Danish public transport in one file (55 MB), updated every ~14 days.

- **Source**: [rejseplanen.info/labs/GTFS.zip](https://www.rejseplanen.info/labs/GTFS.zip)
- **Operators** (21 in single feed):
  - **DSB** (Danske Statsbaner) — national long-distance + intercity rail
  - **S-tog** — København suburban heavy rail (S-banen)
  - **Metro København** — driverless metro lines M1, M2, M3, M4
  - **Aarhus Letbane** — light rail
  - **Odense Letbane** — light rail
  - **Lokaltog** — private regional rail (Sjælland + Jutland branch lines)
  - **Arriva, GoCollective** — regional operators
  - **Movia, Midttrafik, Sydtrafik, Fynbus, Nordjyllands Trafikselskab, BAT Bornholm** — buses
- **Filtered**: 46 rail/tram routes from 1,611 total
- **Result**: 690 unique rail/tram stops, 19,382 newly enriched segments + 19,213 preserved continental
- **Busiest hubs** (Copenhagen Metro dominates):
  - **Kongens Nytorv St. Metro** — 2,238 trains/day
  - **København H Metro** — 2,010 trains/day
  - **Frederiksberg St. Metro** — 1,613 trains/day
  - **København H** (rail station) — 1,537 trains/day
  - **Østerport St. Metro** — 1,339 trains/day

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| København | 45.6% | 2,010 (Metro) |
| Aarhus | 43.0% | 254 (Aarhus Letbane + DSB) |
| Odense | 37.3% | 254 (Odense Letbane + DSB) |
| Esbjerg | 21.0% | 193 |
| Aalborg | 13.8% | 148 |
| Randers | 8.4% | 72 |

## Buildings

GHSL Built-H R2023A 100 m global raster + sparse OSM `building:levels`. Denmark has the world's best per-building open dataset — **BBR (Bygnings- og BoligRegistret)** — containing every building in Denmark with `byg054AntalEtager` (floor count), height, year built, and footprint. It is published via [Datafordeleren](https://datafordeler.dk/) but bulk download requires a free Datafordeler account with API key.

The DAWA API (`api.dataforsyningen.dk/bygninger`) provides building polygon footprints without auth, but heights/floors are only in BBR.

## Industrial

### Wind turbines — Energistyrelsen Stamdataregister

The [Energistyrelsen](https://ens.dk/) (Danish Energy Agency) publishes the **Stamdataregister for vindmøller** — one of the world's most comprehensive open wind turbine databases.

- **Source**: [ens.dk/media/7828/download](https://ens.dk/media/7828/download) (XLSX, 5.7 MB, monthly updates)
- **Records**: 10,687 entries → 4,807 active (filtered to no decommissioning date)
- **Per-turbine fields**: GSRN id, capacity (kW), rotor diameter (m), `Navhøjde` hub height (m), manufacturer, type, X/Y UTM32N coordinates, on/offshore type
- **Result**: 2,489 OSM wind turbines (32.9%) matched to registry within 200 m, 53 hexes updated
- **Mean rated power**: 1,563 kW (Danish wind fleet has many older turbines from 1990s-2010s)
- **Onshore (LAND)**: 4,139 turbines, **Offshore (HAV)**: 668 turbines
- **License**: Open data CC BY 4.0 (basisdata.dk)

Denmark has ~7 GW installed wind capacity (highest per capita in EU). Major offshore farms: Horns Rev (175 MW + 209 MW + 407 MW), Anholt (400 MW), Kriegers Flak (605 MW). Vestas (Aarhus) is the world's largest wind turbine manufacturer.

### NACE codes — E-PRTR

European Pollutant Release and Transfer Register applied via `/enrich-continent europe`. ~400 Danish PRTR sites including:

- **Novo Nordisk** pharma (Bagsværd, Hillerød, Kalundborg)
- **Maersk** shipping ports (Aarhus, København, Esbjerg)
- **Vestas** wind turbine factories (Aarhus, Lem, Brande)
- **Aalborg Portland** cement
- **Aalborg Ørsted** CHP plants

## Validation

Denmark implements END (Environmental Noise Directive 2002/49/EC) via the Environmental Protection Act (Miljøbeskyttelsesloven). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced every 5 years by:

- **Miljøstyrelsen** (Danish EPA) — national aggregator
- **Vejdirektoratet** — for state roads
- **Banedanmark** — for state railways
- **Municipalities** — København, Aarhus, Odense, Aalborg

The Copenhagen Metro extension (Cityringen + ground-level interchange noise) and the København H rail hub are notable noise sources documented in END Round 4.
