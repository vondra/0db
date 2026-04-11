---
title: Canada
intro: Noise mapping data sources for Canada.
map: { center: [-95.0, 60.0], zoom: 3 }
---

## Road traffic

### Quebec MTQ DJMA (Débit Journalier Moyen Annuel)

The [Ministère des Transports et de la Mobilité durable du Québec](https://www.donneesquebec.ca/recherche/dataset/debit-de-circulation) publishes per-segment DJMA (= AADT) for the entire Quebec state highway network as a WFS GeoJSON service.

- **Source**: [ws.mapserver.transports.gouv.qc.ca](https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:circulation_routier&srsname=EPSG:4326&outputformat=geojson)
- **Records**: 7,767 LineString features
- **Per-segment fields**: DJMA (annual avg), DJME (summer), DJMH (winter), %cam (truck share), 10 years of history
- **Result**: 84,845 road segments enriched across 144 Quebec hexes
- **Top corridors**: Décarie Expressway A-15 (186,000 DJMA), Metropolitan A-40 (182,000), Bonaventure A-10 (180,000) — all in Montreal
- **License**: CC-BY 4.0 (donneesquebec.ca)

### Federal HPMS-equivalent — gap

Canada has **no national HPMS-equivalent**. Each province publishes traffic counts separately:

- **Ontario MTO**: Provincial Highways AADT 1988-2021 as CSV (no geometry — requires LHRS join to ORN linear-referenced segments). Not yet ingested.
- **British Columbia MoTI**: per-site reports only at `th.gov.bc.ca/trafficdata/`, no bulk spatial export.
- **Alberta**: XLSX tabular, requires Control Section join to ARNOS network.
- **Calgary city**: Socrata GeoJSON `u2zq-hjgc` (city-only).

Toronto and Vancouver currently use OSM defaults — these are the largest gaps in CA road enrichment.

### Continental EU city traffic

Cerema-aggregated EU traffic dataset includes Toronto, Montreal, and Vancouver via `/enrich-continent europe`.

## Railway

### Multi-feed Canadian GTFS

Eight GTFS feeds covering all major Canadian transit operators:

| Operator | Coverage | Source |
|---|---|---|
| **VIA Rail Canada** | National passenger rail (Toronto–Montreal corridor, Canadian, Ocean) | [viarail.ca/.../gtfs/viarail.zip](https://www.viarail.ca/sites/all/files/gtfs/viarail.zip) |
| **GO Transit Metrolinx** | Toronto/Hamilton commuter rail (Lakeshore West/East, Milton, Kitchener, Barrie, Richmond Hill, Stouffville) | [metrolinx.com](https://www.metrolinx.com/) |
| **TTC Toronto** | Subway (Yonge-University, Bloor-Danforth, Scarborough, Sheppard) + streetcar (10 routes) + bus | [opendata.toronto.ca](https://open.toronto.ca/) |
| **STM Montréal** | Metro (Orange, Green, Yellow, Blue lines) + bus | Mobility Database mdb-2126 |
| **TransLink Vancouver** | SkyTrain (Expo, Millennium, Canada Line) + SeaBus + bus | [gtfs-static.translink.ca](https://gtfs-static.translink.ca/) |
| **OC Transpo Ottawa** | O-Train LRT (Confederation Line, Trillium Line) + bus | OC Transpo Azure CDN |
| **Calgary Transit** | C-Train LRT (Red, Blue lines) + bus | [data.calgary.ca](https://data.calgary.ca/) |
| **Edmonton ETS** | LRT (Capital, Metro, Valley lines) + bus | [gtfs.edmonton.ca](https://gtfs.edmonton.ca/) |

- **Merged**: 1,554 unique rail/tram stops
- **Result**: 20,170 newly enriched railway segments + 6,658 preserved
- **Busiest hubs**:
  - **Lionel-Groulx Métro** (Montreal STM Orange/Green interchange) — **954 trains/day**
  - **Nanaimo Station** (Vancouver SkyTrain Expo Line) — **853 trains/day**
  - **Joyce-Collingwood** (Vancouver SkyTrain) — **853 trains/day**
  - **Broadview Station** (Toronto TTC Bloor-Danforth) — **755 trains/day**
  - **St George Station** (Toronto TTC interchange) — **723 trains/day**

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Ottawa | 39.8% | 326 (O-Train + Confederation Line LRT) |
| Toronto | 28.7% | 755 (TTC Broadview) |
| Calgary | 22.7% | 336 (C-Train) |
| Edmonton | 9.5% | 222 (Capital LRT) |
| Vancouver | 7.9% | 520 (SkyTrain) |
| Montreal | 4.4% | 954 (STM Lionel-Groulx) |

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture/Microsoft Building Footprints (already in `/enrich-global`). Statistics Canada Open Database of Buildings (ODB v3.0) provides 14.4M Canadian building footprints but **no heights/floors** — Overture coverage is preferred.

## Industrial

### Wind turbines — NRCan Canadian Wind Turbine Database

[Natural Resources Canada](https://www.nrcan.gc.ca/) (CanmetENERGY) publishes one of the world's most comprehensive wind turbine open datasets.

- **Source**: [open.canada.ca/dataset/79fdad93](https://open.canada.ca/data/en/dataset/79fdad93-9025-49ad-ba16-c26d718cc070)
- **Direct XLSX**: [ftp.cartes.canada.ca/.../Wind_Turbine_Database_en.xlsx](https://ftp.cartes.canada.ca/pub/nrcan_rncan/Wind-energy_Energie-eolienne/wind_turbines_database/Wind_Turbine_Database_en.xlsx)
- **Records**: 7,841 individual wind turbines
- **Per-turbine fields**: Province, Project, Turbine Rated Capacity (kW), Rotor Diameter (m), Hub Height (m), Manufacturer, Model, Commissioning Date, Latitude, Longitude
- **Result**: 7,220 OSM wind turbines matched (21.8%), 174 hexes updated
- **License**: OGL-Canada (Open Government Licence)

Canada has ~14 GW installed wind capacity. Major concentrations: Quebec (Gaspésie), Alberta (Pincher Creek), Ontario (Bruce County, Wolfe Island), Nova Scotia, British Columbia.

### Power plants — GPPD

WRI Global Power Plant Database covers Canadian power plants via `/enrich-global`. Major emitters/noise sources:

- **Hydroelectric majority**: Churchill Falls (5,428 MW), Robert-Bourassa (5,616 MW), Niagara, Sir Adam Beck, BC Hydro plants
- **Nuclear**: Bruce (6,232 MW — largest in North America), Pickering, Darlington (Ontario)
- **Refineries**: Suncor Edmonton, Imperial Oil Strathcona, Esso Sarnia, Irving Saint John

### NPRI (gap)

Canada's federal [National Pollutant Release Inventory](https://www.canada.ca/en/environment-climate-change/services/national-pollutant-release-inventory.html) has ~8,500 facilities with NAICS codes published as bulk CSV from Environment and Climate Change Canada. Not yet integrated.

## Validation

Canada does not implement END (the EU Environmental Noise Directive). Noise regulation is fragmented:

- **Provincial Ministries of Environment** — Ontario MOE, Quebec MELCCFP, BC MOE
- **Transport Canada** — federal aviation noise (NEF contours around airports)
- **Health Canada** — community noise guidelines
- **Municipal noise bylaws** — Toronto, Montreal, Vancouver, Calgary publish noise complaint statistics
