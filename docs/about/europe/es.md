---
title: Spain
intro: Noise mapping data sources for Spain.
map: { center: [-3.7, 40.4], zoom: 6 }
---

## Road traffic

### MITMA Mapa de Tráfico (national state-network census)

The Ministerio de Transportes y Movilidad Sostenible publishes the **Mapa de Tráfico** annual census on the state road network (RCE).

- **Source**: [mapatrafico.transportes.gob.es/2022](https://mapatrafico.transportes.gob.es/2022/)
- **Coverage**: 7,289 segments across ~26,500 km of autopistas (AP-*), autovías (A-*) and N-roads
- **Result**: 738,205 newly enriched road segments (matched by ref + 30 km proximity)
- **Top corridors**: M-40 Madrid 170k veh/day, A-2 Madrid–Barcelona 165k, AP-7 Mediterranean 156k, V-30 Valencia 152k, A-1 Madrid 151k

### EU city traffic (from `/enrich-continent europe`)

Cerema-aggregated EU AADT for Madrid, Barcelona, Valencia preserves 103,408 city-street segments.

### Regional traffic gaps

Catalonia (Generalitat `xsvx-ym46`), Andalucía (Plan General de Aforos 2021), and Diputació de Barcelona publish additional regional AADT on autonómicas (C-xxx, A-xxx) but these are not yet ingested.

## Railway

Three Spanish rail GTFS feeds are downloaded and merged:

| Operator | Coverage | Source |
|---|---|---|
| **Renfe AV/LD/MD** | High-speed AVE + intercity Larga Distancia + Media Distancia | [data.renfe.com](https://data.renfe.com/) |
| **Renfe Cercanías** | Commuter rail in Madrid, Barcelona, Valencia, Bilbao, Asturias, Sevilla, Málaga, Murcia, Cádiz | data.renfe.com |
| **FGC Catalunya** | Ferrocarrils de la Generalitat de Catalunya | [fgc.cat](https://www.fgc.cat/google/google_transit.zip) |

- **Merged**: 1,109 unique stops
- **Result**: 42,389 segments enriched + 8,992 preserved across 137 hexes
- **Busiest hubs**: Madrid-Chamartín 1,135 trains/day, Madrid-Atocha 1,046, Barcelona-Sants 975

### Coverage by city

| City | % Enriched | Max trains/day |
|---|---|---|
| Madrid | 20.0% | 1,135 |
| Barcelona | 20.3% | 975 |
| Bilbao | 35.5% | 298 |
| Valencia | 9.1% | 263 |
| Sevilla | 14.2% | 211 |
| Málaga | 47.4% | 132 |

### Rail GTFS gaps

**Renfe Feve** (narrow-gauge: Asturias, Cantabria, Galicia, La Rioja) and **Euskotren** (Basque Country) require API keys via the Spanish National Access Point (transportes.gob.es). Not yet ingested — northern Spain narrow-gauge rail uses OSM class defaults.

## Buildings

### Catastro INSPIRE per-province GML

Building polygons with `numberOfFloorsAboveGround` from the [Catastro INSPIRE Buildings ATOM feed](https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml).

- **Provinces processed**: Madrid (28), Barcelona (08), Valencia (46), Sevilla (41), Zaragoza (50), Málaga (29), Bizkaia/Bilbao (48), Alicante (03)
- **Result**: 1,521,485 buildings with floor counts (10.5% of OSM building stock in Spanish hexes)
- **Method**: GML centroid match to OSM buildings within 30 m

The remaining 42 Spanish provinces (Galicia, Asturias, Cantabria, Castilla-León, Castilla-La Mancha, Murcia, Canarias, Baleares, etc.) use the global GHSL Built-H 100 m raster.

## Industrial

### Wind turbines — Castilla-La Mancha

Castilla-La Mancha is the only Spanish autonomous community publishing per-turbine open data:

- **Source**: [datosabiertos.castillalamancha.es — AEROGENERADORES CLM](https://datosabiertos.castillalamancha.es/dataset/aerogeneradores)
- **Records**: 3,118 turbines with `ALTURA_BUJE` (hub height), `POTENCIA_UNI` (rated kW), `RADIO` (rotor radius)
- **CRS**: ETRS89/UTM30N (EPSG:25830)
- **Result**: 1,928 OSM turbines (19% of CLM-area total) matched within 200 m
- **Mean rated power**: 1,261 kW (typical 2000-2010 vintage)

The other major Spanish wind regions (Galicia, Castilla y León, Aragón, Andalucía, Navarra) use OSM defaults (2 MW / 80 m hub) since AEE/REE/IDAE per-turbine data is not openly published.

### Industrial NACE codes

E-PRTR (European Pollutant Release and Transfer Register) provides 2-digit NACE sector codes for ~2,500 Spanish industrial complexes via the continental enrichment pass. The Spanish national PRTR-España emissions XML adds substance-level detail but lacks open coordinates (CAPTCHA-gated INSPIRE service).

### Power plants

Cofrentes nuclear, Almaraz 1/2, refineries (Cartagena, Tarragona, Bilbao, Castellón, A Coruña, Huelva) and major thermal plants are covered by the WRI Global Power Plant Database via `/enrich-global`.

## Validation

Spain implements END (Environmental Noise Directive 2002/49/EC) via Royal Decree 1513/2005 and 1367/2007. Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced by:

- **MITECO** (Ministerio para la Transición Ecológica) — national aggregator
- **CCAA noise observatories** — Catalunya (`mediambient.gencat.cat`), Madrid, Andalucía, País Vasco
- **SICA** (Sistema de Información sobre Contaminación Acústica) — national noise monitoring database

Per-agglomeration strategic noise maps are available for Madrid, Barcelona, Valencia, Sevilla, Zaragoza, Málaga, Murcia, Bilbao, Las Palmas, Palma, Alicante, Córdoba, Valladolid, Vigo, Gijón, Granada, Vitoria-Gasteiz, A Coruña, Tarragona, Sabadell, and ~50 other large municipalities — useful for spot validation.
