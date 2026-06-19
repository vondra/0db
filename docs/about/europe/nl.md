---
title: Netherlands
intro: Noise mapping data sources for the Netherlands — world-class data available, partially integrated.
map: { center: [5.3, 52.2], zoom: 7 }
---

## Road traffic

### NDW (Nationale Databank Wegverkeersgegevens)

The Netherlands has arguably the world's most comprehensive road traffic monitoring network.

- **Coverage**: 27,000 measurement locations across ALL Dutch roads (motorways to local)
- **Data**: AADT, light/heavy split (< 5.6m / >= 5.6m), speeds, per-minute raw data
- **Geometry**: 79,840 road sections in WGS84 shapefile (cached)
- **Access**: Requires free registration at [mijn.ndw.nu](https://mijn.ndw.nu/) — historical data via Dexter database
- **Status**: Shapefile cached, actual traffic counts need Dexter registration

### EU city traffic (continental)

Amsterdam AADT from the EU harmonized 36-city dataset, applied via `/enrich-continent europe`. This is the **only road traffic currently applied** for the Netherlands — Amsterdam street-segment AADT, not the national NDW network. The NDW shapefile above is cached but its traffic counts need Dexter registration. Outside Amsterdam, roads use OSM class + CNOSSOS defaults.

## Railway

### GTFS NL (continental)

Dutch national transit feed covering NS (Nederlandse Spoorwegen) and regional operators, applied as one of the continental GTFS feeds via `/enrich-continent europe`.

- **Stops**: 700+
- **Applied**: trains_passenger in railways.arrow

## Buildings

### 3DBAG — Per-building heights for ALL 10M Dutch buildings

The world's best open building height dataset from [TU Delft 3D Geoinformation](https://3dbag.nl/).

- **Coverage**: ALL 10 million Dutch buildings in LoD2 (actual roof shapes)
- **Data**: Building height, roof type, floor area, 3D geometry
- **Format**: GeoPackage per tile (8,941 tiles)
- **License**: CC BY 4.0
- **Status**: Tile index cached. Full download (~100 GB) deferred — needs dedicated rasterization pipeline.

## Industrial

- **E-PRTR** — Dutch regulated facilities (cement, metals, chemical, waste, food, paper) with NACE codes, applied via `/enrich-continent europe`
- **GPPD** — power plants (NACE 35) via `/enrich-global`
- Wind turbine data available from RVO/Windstats.nl — not yet processed

## Validation

The Netherlands implements END via the Wet geluidhinder. RIVM maintains the national noise model and publishes strategic noise maps. The Dutch noise calculation method (Reken- en meetvoorschrift geluidhinder) is comprehensive and well-documented.
