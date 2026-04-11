---
title: Sweden
intro: Noise mapping data sources for Sweden.
map: { center: [15.5, 62.0], zoom: 5 }
---

## Road traffic

### EU city traffic (continental)

[Stockholm](https://www.stockholm.se/) and [Malmö](https://malmo.se/) are covered by the Cerema-aggregated EU AADT dataset via `/enrich-continent europe` (~10K segments preserved).

### Trafikverket NVDB — gap

[Trafikverket NVDB](https://nvdb2012.trafikverket.se/) (Nationell Vägdatabas) "Trafik" product contains per-segment ÅDT (årsdygnstrafik = AADT) for the entire state road network with full vehicle class breakdown. It is published as **CC0 open data** but distributed via [Lastkajen](https://lastkajen.trafikverket.se/), which requires a one-time free email registration. The Trafikverket Open API at `api.trafikinfo.trafikverket.se` exposes 12 NVDB object types but does **not** yet expose per-segment ÅDT.

Stockholm Stad publishes [Trafikflöde Motorfordon](https://openstreetgs.stockholm.se/) via WFS GeoPackage but also requires a free API key. Göteborg Stad's [trafikmangder.stadsbyggnad.goteborg.se](https://trafikmangder.stadsbyggnad.goteborg.se/) is internal-only as of 2026.

Swedish roads currently use OSM `maxspeed` + class defaults outside the EU city traffic coverage.

## Railway

### GTFS Sverige 2 unified (Trafiklab/Samtrafiken)

[Trafiklab](https://www.trafiklab.se/) (operated by Samtrafiken) publishes a single unified GTFS containing **all Swedish public transport** in one file (58 MB), updated daily.

- **Source**: [api.resrobot.se/gtfs/sweden.zip](https://api.resrobot.se/gtfs/sweden.zip)
- **Operators**:
  - **SJ** (Statens Järnvägar) — national long-distance rail
  - **SL Stockholm** — Pendeltåg commuter + Tunnelbana metro + Spårväg tram
  - **MTRX, Snälltåget, Flixtrain** — private intercity
  - **Skånetrafiken** — Pågatåg + Öresundståg
  - **Västtrafik** — Göteborg Spårväg tram + commuter rail
  - **Norrtåg, Tåg i Bergslagen, Mälartåg** — regional operators
- **Filtered**: 4,083 rail/tram routes from 9,159 total
- **Result**: 425 unique rail/tram stops, 12,492 newly enriched segments + 28,360 preserved (continental)
- **Busiest hubs** (Göteborg dominates due to Spårväg tram interchanges):
  - **Göteborg Brunnsparken** — 2,269 trains/day
  - **Göteborg Centralstation** — 2,089 trains/day
  - **Gamlestads Torg** (Göteborg) — 1,382 trains/day
  - **Göteborg Marklandsgatan** — 1,152 trains/day
  - **Göteborg Järntorget** — 1,143 trains/day

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Göteborg | 43.2% | 1,382 (Spårväg) |
| Stockholm | 14.1% | 239 (Tunnelbana) |
| Malmö | 12.4% | 400 (Pågatåg) |
| Helsingborg | 4.3% | 225 (Pågatåg) |
| Umeå | 4.2% | 2 |
| Uppsala | 4.1% | 2 |

## Buildings

GHSL Built-H R2023A 100 m global raster + sparse OSM `building:levels`. **Lantmäteriet** publishes a national building footprint dataset (HVD Feb 2025, ~9.3M buildings, GeoPackage per municipality, CC BY 4.0) via STAC at api.lantmateriet.se/stac-vektor — but **no per-building heights or floor counts**. Building heights were marked "may be added in future" as of 2026-04. Download requires free Geotorget Basic auth signup.

## Industrial

### Wind turbines — Vindbrukskollen

[Länsstyrelsen Vindbrukskollen](https://vbk.lansstyrelsen.se/) is the official Swedish wind turbine registry. Distributed as a Shapefile under **CC0 1.0 Universell** (public domain).

- **Source**: [ext-dokument.lansstyrelsen.se/.../lst.vbk_vindkraftverk.zip](https://ext-dokument.lansstyrelsen.se/gemensamt/geodata/ShapeExport/lst.vbk_vindkraftverk.zip)
- **Records**: 23,144 turbine entries → **5,786 with status="Uppfört"** (built/operating)
- **Per-turbine fields**: `NAVHOJD` (hub height m), `MAXEFFEKT` (rated power MW), `ROTDIAMETE` (rotor diameter m), `FABRIKAT` (manufacturer), `MODELL`
- **Result**: 1,050 OSM wind turbines (13.2%) matched to registry, 81 hexes updated
- **Mean rated power**: 3,157 kW (3.2 MW — typical modern Swedish onshore turbine)

Sweden has ~14 GW installed wind capacity (the registry covers both onshore and offshore in territorial waters).

### NACE codes — E-PRTR

European Pollutant Release and Transfer Register applied via `/enrich-continent europe`. Major Swedish emitters:

- **SSAB** steel mills (Oxelösund, Luleå, Borlänge)
- **Boliden** mining (Aitik open-pit copper mine, Garpenberg zinc, Rönnskär smelter)
- **Stora Enso, SCA, Holmen** pulp & paper (Norrland forest belt)
- **Preem** refineries (Lysekil, Gothenburg)
- **Sandvik, SKF, Höganäs** specialty metals

The Naturvårdsverket SMP (Svenska Miljöemissionsdata) Swedish PRTR portal at utslappisiffror.naturvardsverket.se duplicates these but offers no bulk download.

## Validation

Sweden implements END (Environmental Noise Directive 2002/49/EC) via the Environmental Code (Miljöbalken). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced every 5 years by:

- **Naturvårdsverket** (Swedish EPA) — national aggregator
- **Trafikverket** — for state roads + railways
- **Municipalities** — Stockholm, Göteborg, Malmö, Uppsala, Linköping, Västerås, Örebro, Helsingborg

The Stockholm tunnelbana (metro) underground sections, Göteborg Spårväg trams (extensive central city network), and Inlandsbanan rail freight corridor are notable noise sources documented in END Round 4.
