---
title: Bolivia
intro: Noise mapping data sources for Bolivia.
map: { center: [-65, -17], zoom: 5 }
---

## Road traffic

### ABC Red Vial Fundamental + WCS (community mirrors)

Bolivia's official GeoBolivia portal was **shut down in March 2023** and IGM/ABC GeoServer endpoints are either 503 or TCP-blocked. Road data reaches us via two community ArcGIS Online mirrors:

- **Source 1 — ABC Red Vial Fundamental 2024**: `services2.arcgis.com/1GTOs4RWV6SKu0wr/arcgis/rest/services/Red_Vial_Fundamental_De_Bolivia/FeatureServer/0`
  - **79 polylines** (partial coverage — concentrated in TARIJA/POTOSI/CHUQUISACA)
  - Fields: `ruta`, `rodadura` (Pavimentada/Ripio/Urbano/Pav. en Construccion), `tipo` (CARRETERA/DOBLE VIA), `depto`
- **Source 2 — WCS RED_VIAL (broader primary network)**: `services.arcgis.com/x494PplYsmeeZsYB/arcgis/rest/services/RED_VIAL/FeatureServer/0`
  - **556 polylines** covering all "Primer Orden" national routes
  - Fields: `Nombre`, `Fuente`, `Categoria_` (all "Primer Orden"), `Revestimie` (Asfalto 426 / Tierra 61 / blank 69)

**No TPDA/IMD/AADT is published** anywhere by ABC in machine-readable form.

### Bolivian AADT defaults (Altiplano/Valles/Llanos regional split)

| OSM class | Altiplano | Valles | Llanos | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|---:|---:|
| 0 motorway | 25,000 | 20,000 | 25,000 | 50,000 | 35,000 |
| 1 trunk | 10,000 | 8,000 | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 4,000 | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 2,000 | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 1,000 | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 500 | 600 | 1,200 | 840 |

### ABC/WCS spatial-match AADT

| Combination | AADT (rural) |
|---|---:|
| Pavimentada/Asfalto Ruta Fundamental | 15,000 |
| Urbano (inside city) | 12,000 |
| Ripio / in construction | 5,000 |
| Tierra (unpaved) | 2,000 |

**Tier-1 metros** (×2.0, 3 metros):
- **La Paz / El Alto** (~1.8M, world's highest capital at 3,650m)
- **Santa Cruz de la Sierra** (~1.7M, tropical lowland, Bolivia's largest city)
- **Cochabamba** (~700k, valley 2,500m)

**Tier-2 cities** (×1.4, 16 cities): Sucre, Oruro, Tarija, Potosí, Trinidad, Cobija, Riberalta, Montero, Quillacollo, Sacaba, Warnes, Yacuiba, Camiri, Villazón, Viacha, Uyuni.

### Bolivian vehicle split

High motorcycle share (~20-25% urban — cheap Chinese imports). Very high heavy-vehicle share on mining corridors.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 | 60% | 5% | 10% | **25%** |
| Tier-2 | 62% | 6% | 12% | 20% |
| **Altiplano rural** | 50% | 8% | **30%** | 12% |
| Valles rural | 58% | 8% | 22% | 12% |
| **Llanos rural (Santa Cruz soy freight)** | 55% | 8% | 25% | 12% |
| **Mining corridors** | **45%** | 8% | **37%** | 10% |

### National route network

- **Ruta 1** — La Paz ↔ Oruro ↔ Potosí ↔ Tupiza ↔ Villazón (Argentina border, Andean spine)
- **Ruta 2** — La Paz ↔ Desaguadero (Peru border) via Viacha
- **Ruta 3** — La Paz ↔ Caranavi (Yungas cloud forest descent)
- **Ruta 4** — Tambo Quemado (Chile border) ↔ Cochabamba ↔ Santa Cruz (**main east-west spine**)
- **Ruta 5** — Cochabamba ↔ Oruro
- **Ruta 6** — Sucre ↔ Tarija
- **Ruta 7** — Cochabamba ↔ Santa Cruz via Villa Tunari (Chapare)
- **Ruta 9** — Santa Cruz ↔ Yacuiba (Argentina gas corridor)
- **Ruta 10** — Santa Cruz ↔ Puerto Suárez/Quijarro (Brazil border)

## Railway

### No spatial data — two disjoint networks via OSM + defaults

Bolivia has **two disjoint rail networks** that don't connect to each other, operated by different companies:

- **FCA (Ferroviaria Andina)** — **western network, 2,276 km**, operated by Ferroviaria Andina SA. La Paz ↔ Oruro ↔ Uyuni ↔ Villazón (Argentina border), Oruro ↔ Cochabamba branch. Connects to Chilean ports at Arica and Antofagasta. **Mostly mineral concentrate freight**. Token passenger: **Expreso del Sur** / **Wara Wara del Sur** Oruro↔Villazón ~2 days/week.
- **FCO (Ferroviaria Oriental)** — **eastern network, 1,244 km**, operated by Ferroviaria Oriental SA. Santa Cruz ↔ Quijarro (Brazil border, famous **"Tren de la Muerte"** or **"Ferrobus"**), Santa Cruz ↔ Yacuiba (Argentina border), Santa Cruz ↔ Trinidad. Mostly **soy + grain freight** + Puerto Aguirre iron ore (Mutún mine).
- **Tren Metropolitano Cochabamba** — new urban commuter rail, 27 km, Sacaba ↔ El Castillo across Cochabamba valley. **Opened 2022**.
- **Mi Teleférico La Paz** — 10 cable car lines across La Paz/El Alto (~32 km total, **world's largest urban cable car network**). OSM `aerialway=gondola`, NOT rail.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### MHE GeoServer — the richest Bolivian geodata

**MHE** (Ministerio de Hidrocarburos y Energía) at `geoportal.mhe.gob.bo/geoserver/ows` publishes the full national electricity grid as WFS queries in GeoJSON. March 2026 refresh.

- **gen_sin_20260304**: 47 SIN (Sistema Interconectado Nacional) grid plants
- **Gen_Ais_2026**: 35 isolated system plants (off-grid: Beni/Pando/remote)
- **Subestaciones_SIN_MAR_20260**: 230 substations
- **transmision_sin_20260304**: 291 HV transmission lines

Plant types: **HE** (Hidroeléctrica), **TG** (Turbina gas), **BM** (Biomasa), **EO** (Eólica), **SL** (Solar), **DO** (Diesel).

### Top operating SIN plants

| Plant | MW | Tipo | Owner |
|---|---:|---|---|
| Central Termoeléctrica Warnes | 556 | TG | ENDE ANDINA |
| Central Termoeléctrica del Sur | 516 | TG | ENDE ANDINA |
| Central Entre Ríos | 505 | TG | ENDE ANDINA |
| Central Guaracachi | 411 | TG | ENDE GUARACACHI |
| Central Carrasco | 159 | TG | VHE |
| Central Misicuni | 126 | HE | ENDE G |
| Central Solar Oruro | 104 | SL | ENDE G |
| Central Valle Hermoso | 101 | TG | VHE |
| Central Bulo Bulo | 101 | TG | CECBB |
| Central Santa Isabel | 93 | HE | ENDE CORANI |

All mapped to **NACE 35** (Electricity generation).

### GEM Global Integrated Power (backfill)

66 plants total, 37 operating — used as backfill for plants not captured by MHE.

### Bolivia does NOT have

- **No mining concession registry accessible**: AJAM SI-DAT is private; COMIBOL publishes no spatial data. Major mines (**San Cristóbal** Sumitomo silver/zinc/lead Potosí, **Huanuni** tin, **Colquiri** tin/zinc, **Vinto** tin smelter, **San Bartolomé** Cerro Rico silver, **Mutún** Santa Cruz iron ore, **Salar de Uyuni lithium** YLB) rely on OSM coordinates only.
- **No YPFB oil/gas extraction**: YPFB Portal GIS query endpoints return HTTP 400. Gas fields (Camiri, Margarita, Incahuasi, Vuelta Grande, Sábalo), pipelines, and refineries (Gualberto Villarroel Cochabamba, Guillermo Elder Bell Santa Cruz) are not classified.
- **No per-segment TPDA** — ABC publishes only PDF maps.
- **No operational commercial rail geometry** from the two operators (FCA/FCO) — OSM is the only source.

## Validation

Bolivia implements noise regulation via:

- **Ministerio de Medio Ambiente y Agua (MMAyA)** at [mmaya.gob.bo](https://www.mmaya.gob.bo/)
- **Reglamento en Materia de Contaminación Atmosférica (RMCA)** — noise limits under Ley 1333/1992 (Medio Ambiente)
- Typical limits: Residential day/night 55/45 dBA, commercial 65/55 dBA, industrial 70/65 dBA

Notable noise zones:

- **Ruta 4** Santa Cruz ↔ Cochabamba — main east-west highway (Villa Tunari/Chapare pass)
- **Ruta 1** La Paz ↔ Oruro ↔ Potosí ↔ Villazón — Andean spine, high truck traffic
- **Ruta 9** Santa Cruz ↔ Yacuiba — gas corridor
- **Avenida 16 de Julio / El Prado** La Paz — commercial arterial
- **Autopista La Paz-El Alto** — Yungas descent from El Alto (4,100m) to La Paz (3,650m)
- **Tren Metropolitano Cochabamba** — new commuter rail viaduct
- **FCA Oruro↔Villazón mining freight corridor** (Andean spine)
- **FCO Santa Cruz↔Quijarro "Tren de la Muerte"** freight corridor
- **Mi Teleférico La Paz** — cable car viaducts across city center (NOT noise-relevant since it's quiet electric gondolas, but notable visually)
- **El Alto International (LPB/SLLP La Paz, 4,058m — highest international airport in the world)**, **Viru Viru (VVI/SLVR Santa Cruz)**, **Jorge Wilstermann (CBB/SLCB Cochabamba)**, **Juana Azurduy de Padilla (SRE/SLSU Sucre)**, **Joya Andina (UYU/SLUY Uyuni)**, **Alcantarí (SRE new)** — covered by global aircraft layer
- **Warnes thermal complex** (Santa Cruz, 556 MW TG) — Bolivia's largest thermal plant
- **Entre Ríos complex** (Cochabamba, 505 MW TG)
- **Guaracachi complex** (Santa Cruz, 411 MW TG — ENDE Guaracachi)
- **Cerro Rico de Potosí** — mythic silver mountain, active since 1545, still producing
- **San Cristóbal mine** (Potosí, Sumitomo — world's largest silver mine by volume)
- **Vinto tin smelter** (Oruro)
- **Mutún iron ore complex** (Santa Cruz, Brazil border — massive untapped reserves)
- **Refinería Gualberto Villarroel** (Cochabamba, YPFB) — Bolivia's main oil refinery
- **Refinería Guillermo Elder Bell** (Santa Cruz, YPFB)
- **Camisea-like Margarita, Incahuasi, Vuelta Grande gas fields** (Tarija — Bolivia's gas export source)
