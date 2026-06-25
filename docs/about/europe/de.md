---
title: Germany
intro: Noise mapping data sources for Germany.
map: { center: [10.5, 51.2], zoom: 6 }
---

## Road traffic

### BASt SVZ 2021 (Straßenverkehrszählung)

National road traffic census conducted every 5 years by [BASt](https://www.bast.de/) (Bundesanstalt für Straßenwesen).

- **Coverage**: 11,500 counting sections on Autobahnen (2,494) and Bundesstraßen (9,006)
- **Vehicle classes**: LVm (cars/light vans), Bus, LoA (medium trucks), LZ (heavy trucks + trailer), Krad (motorcycles)
- **Coordinates**: ETRS89/UTM32N (converted to WGS84)
- **Format**: Excel (Zeilenformat sheet) from bast.de
- **Year**: 2021 census (most recent complete; next SVZ running 2024-2025)
- **License**: Open data

Vehicle class mapping to CNOSSOS:
| BASt | CNOSSOS | Arrow column |
|------|---------|-------------|
| LVm (cars + light vans) | Category 1 (light) | `aadt_light` |
| Bus + LoA (buses + medium trucks) | Category 2 (medium) | `aadt_medium` |
| LZ (heavy trucks + trailer) | Category 3 (heavy) | `aadt_heavy` |
| Krad (motorcycles) | Category 4 (moto) | `aadt_moto` |

### BASt Dauerzählstellen

2,110 automatic counting stations on federal roads with hourly data, day/evening/night split, and WGS84 coordinates. Cached for future period-profile enrichment.

### Additional sources (cached, not yet integrated)

- **NRW shapefiles**: 7,000 stations incl. Landesstraßen/Kreisstraßen from opengeodata.nrw.de
- **Bavaria BAYSIS WFS**: 9,441 stations with road segment geometry
- **Baden-Württemberg**: SVZ results for all road classes from mobidata-bw.de
- **Toll Collect**: 138,000 truck sections from webgis.toll-collect.de ArcGIS Feature Service

## Railway

### DELFI GTFS (applied via the continental rail pass)

National GTFS feed covering all passenger rail operators (DB, private railways, S-Bahn, tram), ingested by the Europe-wide GTFS railway enrichment (`enrich-railway-europe.ts`, `de` feed) alongside ~16 other countries.

- **Stops**: 7,200+
- **Source**: data.public-transport.earth/gtfs/de
- **Applied**: trains_passenger column in railways.arrow
- **Gap**: Freight train frequencies not available from GTFS

## Industrial / Wind energy

### MaStR (Marktstammdatenregister)

Germany's energy facility registry from [Bundesnetzagentur](https://www.marktstammdatenregister.de/). Contains ~30,000 onshore wind turbines with:
- Rated power (kW)
- Hub height (m)
- Rotor diameter
- Exact GPS coordinates
- Commissioning date, manufacturer, model

**Applied**: turbines matched to OSM `power=generator` wind turbines by proximity (<200 m); hub_height + rated_power_kw written into industrial.arrow (`enrich-industrial-de.ts`).

### E-PRTR (applied via the continental industrial pass)

The European Pollutant Release and Transfer Register supplies 2-digit NACE sector codes (steel, cement, chemical, waste, food, paper, etc.) for German industrial complexes, matched to OSM industrial sites within 2 km (`enrich-global-industrial.ts`).

### GPPD (applied via /enrich-global)

The WRI Global Power Plant Database covers German power plants with NACE 35 (energy) classification.

## Buildings

### BKG LoD1-DE

BKG (Bundesamt für Kartographie und Geodäsie) maintains LoD1 3D building models for all 54 million German buildings with median building heights.

**Status**: NOT open data — restricted to authorized users. Only test data freely available.

### State-level LoD1/LoD2 (potential future sources)

Some German states publish LoD1/LoD2 as open data:
- **NRW**: OpenGeodata.nrw.de — LoD1+LoD2 for all NRW buildings
- **Berlin**: daten.berlin.de — LoD2 CityGML
- **Hamburg**: transparenz.hamburg.de — LoD1+LoD2
- **Brandenburg**: geobroker.geobasis-bb.de — LoD1
- Others vary by state

## Overture building heights (applied via /enrich-global)

Overture Maps provides per-building heights from LiDAR for Berlin (60.3% coverage). See global enrichment.

## Validation

Germany implements the EU Environmental Noise Directive (END) through the Bundes-Immissionsschutzgesetz (BImSchG). Strategic noise maps are produced by state agencies for major roads, railways, airports, and agglomerations.

- **VBUS/VBEB/VBUSch**: German calculation methods implementing CNOSSOS-EU
- **LDEN/Lnight maps**: Published every 5 years per END, available via state environmental agencies
