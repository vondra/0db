---
title: Paraguay
intro: Noise mapping data sources for Paraguay.
map: { center: [-57.5, -23.5], zoom: 6 }
---

## Road traffic

### MOPC Rutas Nacionales 2023 (KMZ only)

Paraguay's MOPC (Ministerio de Obras Públicas y Comunicaciones) publishes the national road network as a single KMZ file on Google Drive, linked from `mopc.gov.py/red-vial/`. No ArcGIS/WFS endpoint exists. **No per-segment TPDA is published** in machine-readable form anywhere.

- **Source**: MOPC KMZ (`RUTAS NACIONALES MOPC_2023.shp`)
- **URL**: `https://drive.usercontent.google.com/download?id=12s3Iy1LnuzwHwGMZOjZvxwoI3NJqMknv&export=download&confirm=t`
- **Records**: **22 MultiLineString features** (PY01–PY22), ~8,780 km total
- **Fields**: `CODIGO`, `DEPARTAMEN`, `TIPO_SUP` (PCA=paved/T=unpaved/mixed), `TIPO_RED`, `DESCP_TRAM`, `INICIO`, `FIN`, `REGION` (ORIENTAL/OCCIDENTAL)
- **Conversion**: Downloaded as KMZ → unzipped to KML → custom Python parser → GeoJSON

### Paraguayan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (none in PY) | 30,000 | 60,000 | 42,000 |
| 1 trunk (Ruta Nacional paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Paraguay has no autopistas** — all major roads are single-calzada 2-lane Rutas Nacionales.

### MOPC spatial-match AADT

| Combination | AADT (rural) |
|---|---:|
| PCA (fully paved) | 12,000 |
| PCA, T (mixed) | 8,000 |
| T (unpaved) | 3,000 |

**Tier-1 metros** (×2.0): **Gran Asunción** (Asunción + Luque + San Lorenzo + Capiatá + Lambaré + Fernando de la Mora + Limpio + Ñemby). ~2.3M population (~34% of Paraguay).

**Tier-2 cities** (×1.4, 17 cities): Ciudad del Este, Encarnación, Luque, San Lorenzo, Capiatá, Lambaré, Fernando de la Mora, Limpio, Ñemby, Pedro Juan Caballero, Concepción, Coronel Oviedo, Villarrica, Pilar, Caaguazú, Filadelfia (Chaco), Salto del Guairá.

### Paraguayan vehicle split

Moderate motorcycle share (~20% urban — Paraguay has cheap Chinese motorbike imports). Very high heavy share on Ruta 2 and Ruta 7 (soy freight to Paranaguá/Buenos Aires).

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Gran Asunción) | 65% | 5% | 10% | **20%** |
| Tier-2 | 62% | 6% | 12% | **20%** |
| **Rural Oriental (soy freight)** | 55% | 8% | **25%** | 12% |
| **Chaco (low-density)** | 60% | 10% | 20% | 10% |

### National route network

- **Ruta 1 (Mariscal Francisco Solano López)** — Asunción ↔ Encarnación ↔ Argentina (378 km)
- **Ruta 2 (Gaspar Rodríguez de Francia)** — Asunción ↔ Ciudad del Este ↔ Brazil (343 km, **main soy freight corridor**)
- **Ruta 3 (General Elizardo Aquino)** — Asunción ↔ Pedro Juan Caballero (413 km, north)
- **Ruta 4** — Villarrica ↔ Ciudad del Este
- **Ruta 5** — Concepción ↔ Pedro Juan Caballero
- **Ruta 6** — Ciudad del Este ↔ Encarnación
- **Ruta 7** — Ciudad del Este ↔ Villarrica (417 km)
- **Ruta 9 (Transchaco / Carlos Antonio López)** — Asunción ↔ Filadelfia ↔ Bolivia (**780 km**, the only highway across the Gran Chaco)
- **Ruta 10 (Las Residentas)** — Pedro Juan Caballero ↔ Salto del Guairá
- **Ruta 12** — 744 km

## Railway

### No operational rail — minimal defaults only

Paraguay has **essentially no operational rail**. The Ferrocarril Central del Paraguay (Asunción ↔ Encarnación) operated until the early 2000s but was progressively dismantled. Currently:

- **Sapucai tourist steam train** — short heritage run from Sapucai (rare)
- **FEPASA** (Ferrocarriles del Paraguay S.A.) — nominally responsible for the disused network but operates essentially no freight
- **Small spurs** at Ciudad del Este and near the Brazil border
- **No urban metros or light rail** — Gran Asunción uses buses only

### trains/day defaults (minimal)

| Context | pax/day | frt/day |
|---|---:|---:|
| Sapucai tourist / other rail | 1 | 0 |
| Branch lines | 0 | 2 |
| Industrial sidings | 0 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. Microsoft contributed Paraguayan building footprints in their 2023-2024 release. IGN Paraguay (`ign.mil.py`) is TCP-blocked.

## Industrial

Paraguay's power fleet is **99% hydropower** but the two dominant plants are binational and flagged in GEM as belonging to the neighbour:

- **Itaipú Binacional** (14 GW) — flagged `Country_area='Brazil'` in GEM. Physically on the Paraguay/Brazil border at (-25.41, -54.59), Río Paraná at Ciudad del Este / Foz do Iguaçu. Shared 50/50 between Paraguay and Brazil. **World's 2nd largest hydro plant**. Paraguay consumes ~10% of its 50% share and exports ~90%.
- **Yacyretá Binacional** (3.1 GW) — flagged `Country_area='Argentina'` in GEM. Physically on the Paraguay/Argentina border at (-27.48, -56.72), Río Paraná at Encarnación / Posadas. Shared 50/50 between Paraguay and Argentina.

We perform an additional GEM query by name to capture them for Paraguay industrial context, then merge with the Paraguay-flagged entries.

### Top operating plants captured (inside PY bbox)

| Plant | MW | Type | Location |
|---|---:|---|---|
| **Itaipú** | 14,000 | hydropower | Paraguay/Brazil border (Ciudad del Este/Foz do Iguaçu) |
| **Yacyretá** | 3,100 | hydropower | Paraguay/Argentina border (Encarnación/Posadas) |
| **Acaray** | 210 | hydropower | Alto Paraná (1968-94, 100% PY, ANDE) |
| Filadelfia solar farm | 1 | solar | Chaco |
| Frigorífico Guaraní | 1 | solar | Lambaré (self-consumption) |

Paraguay generates ~30 TWh/year but consumes only ~5 TWh — **~20-25× its own consumption**. Paraguay is a **massive net electricity exporter** to Brazil (via Itaipú) and Argentina (via Yacyretá). This makes Paraguay one of the most renewable-energy-reliant economies in the world (99%+).

All operating plants map to **NACE 35** (Electricity generation).

### Paraguay does NOT have

- **No autopistas** — all major roads are 2-lane Rutas Nacionales
- **No operational rail** — FEPASA network is essentially defunct
- **No urban metro/light rail** — Asunción uses buses only
- **No oil refinery** — PETROPAR imports refined products via the Paraná pipeline from Paranaguá (Brazil)
- **No major mining** — minimal limestone, granite, dolomite
- **No heavy industry** — small cement (INC Vallemí), brewery (Cervepar Pilsen), soy processors (Cargill/ADM), nothing else
- **No per-segment TPDA data** — one of only three SA countries in this pipeline (with Uruguay and Ecuador) without any real traffic counts

## Validation

Paraguay implements noise regulation via:

- **MADES** (Ministerio del Ambiente y Desarrollo Sostenible) at [mades.gov.py](https://www.mades.gov.py/)
- **Ley 1.100/1997** — Ley de Prevención de la Polución Sonora
- **Ordenanza 63/95** (Municipalidad de Asunción) — stricter urban noise limits
- Typical limits: Residential day/night 55/45 dBA, commercial 65/55 dBA, industrial 70/65 dBA

Notable noise zones:

- **Ruta 2** Asunción ↔ Ciudad del Este — main soy freight corridor (heavy truck traffic)
- **Ruta 7** Ciudad del Este ↔ Villarrica — Alto Paraná agricultural freight
- **Ruta 9 Transchaco** — only highway across the Gran Chaco (780 km)
- **Av. Eusebio Ayala / Av. Mcal. López / Av. España / Av. Aviadores del Chaco** Asunción — major arterials
- **Autopista Ñu Guazú** Asunción airport access
- **Puente de la Amistad** Ciudad del Este ↔ Foz do Iguaçu (Brazil) — busiest border crossing in South America
- **Puente San Roque González de Santa Cruz** Encarnación ↔ Posadas (Argentina)
- **Silvio Pettirossi (ASU/SGAS Asunción)**, **Guaraní (AGT/SGES Ciudad del Este)**, **Teniente Alejo Garcia Pueyo (ENO/SGEN Encarnación)** — covered by global aircraft layer
- **Itaipú Binacional dam** (Ciudad del Este/Foz do Iguaçu, 14 GW) — world's 2nd largest hydro plant, massive spillway + turbine noise
- **Yacyretá Binacional dam** (Encarnación/Posadas, 3.1 GW)
- **Acaray hydroelectric dam** (Alto Paraná, 210 MW — Paraguay's only fully domestic large power plant)
- **Port of Asunción** (Río Paraguay) — container + bulk freight for soy exports
