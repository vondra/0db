---
title: Norway
intro: Noise mapping data sources for Norway.
map: { center: [10.0, 64.5], zoom: 5 }
---

## Road traffic

### NVDB Trafikkmengde (Statens vegvesen)

[Statens vegvesen](https://www.vegvesen.no/) maintains **NVDB** (Nasjonal vegdatabank), the Norwegian national road database. Per-segment ÅDT (årsdøgntrafikk = AADT) is published via the NVDB API as object type 540 "Trafikkmengde".

- **Source**: [nvdbapiles.atlas.vegvesen.no/vegobjekter/540](https://nvdbapiles.atlas.vegvesen.no/vegobjekter/540)
- **Pagination**: cursor-based via `metadata.neste.href` (NVDB caps at 800 results/page)
- **Records**: 47,438 per-segment ÅDT records covering all state and county roads
- **Per-segment fields**: `4623` ÅDT total, `4624` Andel lange kjøretøy % (heavy share), `4621` year
- **Result**: 1,038,923 enriched road segments (327 of 1,063 Norwegian hexes updated)
- **Top corridors**:
  - **EV6** (E6 Oslo motorring) — 110,000 ÅDT
  - **EV6** (E6 multiple sections through Oslo) — 99,000 - 105,800 ÅDT
  - **EV18** (E18 Oslo–Drammen) — 86,600 ÅDT
- **License**: NLOD 2.0 (Norsk lisens for offentlige data)
- **Headers required**: `User-Agent`, `X-Client`, `Accept: application/vnd.vegvesen.nvdb-v3-rev1+json`

## Railway

### Continental Norway feed (Entur via data.public-transport.earth)

The continental enrichment applies a Norwegian Entur GTFS feed via `/enrich-continent europe`, providing Vy (formerly NSB) national rail and commuter rail coverage.

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Bergen | 54.0% | 339 |
| Oslo | 49.2% | 407 |
| Stavanger | 35.0% | 125 |
| Trondheim | 30.1% | 150 |
| Drammen | 29.7% | 182 |

### Gap — Entur full unified GTFS

The complete [Entur unified GTFS](https://developer.entur.org/) at `https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs.zip` (606 MB, daily updates) would add:

- **Sporveien Oslo T-bane** — 5 metro lines (1, 2, 3, 4, 5)
- **Oslo trams** — 6 lines (11, 12, 13, 17, 18, 19)
- **Bybanen Bergen** — light rail
- **Trondheim Trams** — Gråkallbanen

This was skipped due to feed size; Norwegian metro/tram noise currently uses OSM defaults.

## Buildings

GHSL Built-H R2023A 100 m global raster + sparse OSM `building:levels`. Norway has excellent building data via Kartverket but distribution is complex:

- **FKB-Bygning** (felles kartdatabase) has polygon footprints with `bygningshoyde` (real heights) — but only as 16 county FGDB files via Geonorge order API
- **Matrikkelen-Bygningspunkt** has national coverage but only points with no heights

## Industrial

### Wind turbines — NVE Vindkraft2

[NVE](https://www.nve.no/) (Norges vassdrags- og energidirektorat) publishes the Vindkraft2 ArcGIS REST service with operational wind farms and individual turbines.

- **Layer 0** — Vindkraftverk (parks): [nve.geodataonline.no/.../Vindkraft2/MapServer/0](https://nve.geodataonline.no/arcgis/rest/services/Vindkraft2/MapServer/0)
- **Layer 4** — Vindturbin (individual turbines): [.../Vindkraft2/MapServer/4](https://nve.geodataonline.no/arcgis/rest/services/Vindkraft2/MapServer/4)
- **Operational parks**: 61 (status='D'/Drift)
- **Operational turbines**: 1,366 (across all parks)
- **Total operational capacity**: 5,007 MW
- **Per-turbine power**: derived as park `effekt_MW_idrift / antallTurbiner` (NVE doesn't publish individual turbine specs, only park totals)
- **Result**: 33 OSM wind turbines matched within 500 m (low — Norwegian wind farms in remote mountain terrain have OSM coordinates that differ significantly from official NVE positions)
- **License**: NLOD 2.0

Norway's wind capacity has grown rapidly — major farms include Fosen Vind (1,057 MW, the largest onshore wind project in Norway and among the largest in Europe — Sweden's Markbygden has since surpassed it), Smøla, Tonstad, Sørmarkfjellet (130 MW Trøndelag), and offshore Hywind Tampen (88 MW floating). Equinor leads offshore development.

### NACE codes — E-PRTR

European Pollutant Release and Transfer Register applied via `/enrich-continent europe`. Norwegian major emitters:

- **Equinor** (Statoil) — Mongstad refinery, Kårstø gas processing, Kollsnes
- **Yara** — fertilizers (Porsgrunn, Glomfjord)
- **Hydro** — aluminium (Sunndal, Karmøy, Husnes, Årdal)
- **Elkem** — silicon metals (Salten, Bremanger, Bjølvefossen)
- **Boliden Odda** — zinc smelting

The Norwegian Miljødirektoratet `industrianlegg` ArcGIS layer has 1,880 facilities (more complete than continental E-PRTR's ~500 NO entries) and could be added in a future enrichment run.

## Validation

Norway implements END (Environmental Noise Directive 2002/49/EC) via the Pollution Control Act (Forurensningsloven). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced every 5 years by:

- **Miljødirektoratet** (Norwegian Environment Agency) — national aggregator
- **Statens vegvesen** — for state roads
- **Bane NOR** — for state railways
- **Cities** — Oslo, Bergen, Trondheim, Stavanger publish per-municipality noise maps

The E6 motorring through Oslo (110,000 ÅDT), the Bergensbanen rail line, and Oslo Lufthavn Gardermoen are notable noise sources documented in END Round 4.
