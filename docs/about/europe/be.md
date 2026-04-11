---
title: Belgium
intro: Noise mapping data sources for Belgium.
map: { center: [4.5, 50.5], zoom: 8 }
---

## Road traffic

Belgium has **no clean per-segment AADT dataset** for any of its three regions:

- **Wallonia** publishes Telraam citizen-sensor counts as GeoPackage but with CC-BY-NC license
- **Flanders** Vlaams Verkeerscentrum publishes per-minute MIV XML on ~4,500 motorway loops, no AADT aggregates
- **Brussels Mobility** publishes 90 loop locations (devices) but no historical aggregates

Belgian roads currently use OSM `maxspeed` + class defaults. Strategic noise maps published every 5 years by the regional environment agencies (Bruxelles Environnement, VMM, AWAC) contain AADT in the model inputs but are not redistributed as open data.

## Railway

### National rail (continental SNCB)

[SNCB/NMBS](https://www.belgiantrain.be/) GTFS feed via [gtfs.irail.be](https://gtfs.irail.be/) is applied via `/enrich-continent europe`. Provides intercity, IR, L (local), S (suburban), and tourism rail across the entire Belgian network.

### Urban metro / tram (BE-specific multi-feed)

Three regional urban operator feeds added on top of SNCB national:

| Operator | Coverage | Source |
|---|---|---|
| **STIB/MIVB** | Brussels: 4 metro lines + 18 tram lines + bus | [stibmivb.opendatasoft.com](https://stibmivb.opendatasoft.com/) (Mobility Database mdb-1088) |
| **De Lijn** | Flanders: Antwerpen pre-metro/tram + Gent tram + Coast Tram (Kusttram, longest tram in Europe) + bus | [gtfs.irail.be/de-lijn](http://gtfs.irail.be/de-lijn/de_lijn-gtfs.zip) |
| **TEC** | Wallonia: Charleroi pre-metro (light rail) + bus | [opendata.tec-wl.be](http://opendata.tec-wl.be/Current%20GTFS/TEC-GTFS.zip) |

- **Merged**: 1,427 unique urban stops
- **Result**: 39,175 newly enriched railway segments (combined with 35,031 SNCB pre-existing = 74,206 total)
- **Busiest urban hubs**:
  - Antwerpen Van Eeden Metro — 614 trains/day (Antwerpen pre-metro)
  - LIEDTS (Brussels) — 568 trains/day (STIB tram interchange)
  - Gent Koning Albertbrug — 560 trains/day (Gent tram)
  - MONTGOMERY (Brussels) — 531 trains/day (STIB metro)

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Bruxelles | 56.4% | 1,062 (Bruxelles-Midi) |
| Charleroi | 33.3% | 401 (pre-metro + intercity) |
| Gent | 29.5% | 580 (tram + intercity) |
| Liège | 23.4% | 461 |
| Leuven | 16.9% | 648 |
| Brugge | 16.3% | 302 |
| Namur | 15.7% | 382 |
| Antwerpen | 15.2% | 759 |
| Mons | 14.8% | 270 |

## Buildings

Belgium has excellent regional building height datasets but all require authentication:

- **Flanders 3D GRB Gebouw LOD1 DHMV II** — per-building LOD1 heights from LiDAR, requires `auth.vlaanderen.be` registration
- **Wallonia PICC** (Plan Cartographique Cadastral) — 3D building footprints with vertex Z-coordinates, requires download basket form
- **Brussels UrbIS 3D Constructions** — 230k buildings with roof heights, distributed as 3D Tiles only

Belgian buildings currently use GHSL Built-H 100 m raster + sparse OSM `building:levels`.

## Industrial

- **E-PRTR**: Belgian facilities receive NACE 2-digit codes via `/enrich-continent europe`. Major emitters (BASF Antwerp chemical complex, Total Antwerp refinery, ArcelorMittal Ghent steel mill, Carmeuse cement, Solvay) are correctly classified.
- **Wind turbines**: Belgium has ~5 GW installed wind capacity (mostly North Sea offshore + Wallonia onshore farms) but no regional registry is openly downloadable. OSM `power=generator` provides locations only.

## Validation

Belgium implements END (Environmental Noise Directive 2002/49/EC) via three regional decrees (Brussels 2008, Flanders 2008, Wallonia 2009). Strategic noise maps are produced every 5 years by:

- **Bruxelles Environnement / Leefmilieu Brussel** — Brussels-Capital Region maps
- **Vlaamse Milieumaatschappij (VMM)** — Flanders maps
- **AWAC (Agence wallonne de l'Air et du Climat)** — Wallonia maps

The Brussels Petite Ceinture (inner ring road) and Antwerp port area are among Belgium's most noise-affected zones.
