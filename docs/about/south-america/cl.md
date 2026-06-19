---
title: Chile
intro: Noise mapping data sources for Chile.
map: { center: [-71, -35], zoom: 4 }
---

## Road traffic

### MOP Vialidad Red Vial + Plan Nacional de Censos TMDA 2024-2025

Chile has the **freshest TMDA dataset in the entire pipeline** — the Plan Nacional de Censos publishes 2024 and 2025 data via the MOP MapServer (vs. Argentina's 2017-18 vintage). Combined with the official Red Vial Nacional via the Esri Chile mirror, Chile is one of the best-covered non-EU countries for road traffic enrichment.

- **Source 1 — Road network**: MOP Dirección de Vialidad via Esri Chile mirror
  - URL: `https://services.arcgis.com/r7t1P5pnkoOLRdhr/arcgis/rest/services/Red_Vial/FeatureServer/0`
  - Records: **13,962 polylines** (all national + regional + provincial roads)
  - Owner: `solutions_EsriChile` (orgId `r7t1P5pnkoOLRdhr`) — official Esri Chile SpA mirror
  - Fields: `ROL`, `CLASIFICACION` (Camino Nacional Longitudinal/Nacional/Regional Principal/Provincial/Comunal/Acceso/Privado), `CARPETA` (pavement), `CONCESIONADO` (toll), `KM_I`, `KM_F`, `NOMBRE_CAMINO`, `REGION`

- **Source 2 — Plan Nacional de Censos TMDA 2024-2025**: MOP Dirección de Vialidad
  - URL: `https://rest-sit.mop.gob.cl/arcgis/rest/services/VIALIDAD/Plan_Nacional_de_Censos/MapServer/0`
  - Records: **863 census stations × ~2.7 ramas/station = 2,364 individual TMDA values**
  - Vintage: 512 stations from 2024, 351 from 2025 — truly current
  - Stats: min=4, median=1,614, **max=93,752 (Talca, Ruta 115)**, mean=3,034
  - Format quirk: only `f=json` (Esri JSON), not `f=geojson` — geometry must be converted from `{x,y}` to GeoJSON Point

### AADT defaults (fallback when no TMDA match)

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (autopista, Ruta 5 toll) | 50,000 | 100,000 | 70,000 |
| 1 trunk (Camino Nacional) | 18,000 | 36,000 | 25,200 |
| 2 primary | 9,000 | 18,000 | 12,600 |
| 3 secondary | 4,000 | 8,000 | 5,600 |
| 4 tertiary | 1,800 | 3,600 | 2,520 |
| 5 residential | 800 | 1,600 | 1,120 |

### Red Vial spatial-match AADT (by classification + carpeta + concesion)

| Red Vial combination | AADT (rural) |
|---|---:|
| Concesionado + paved (Autopista Central, Costanera Norte, Ruta 5 toll) | 35,000 |
| Camino Nacional Longitudinal + paved (Ruta 5 backbone) | 22,000 |
| Camino Nacional + paved | 14,000 |
| Camino Regional Principal + paved | 7,000 |
| Camino Regional Provincial + paved | 3,500 |
| Unpaved (Ripio/Tierra) | 1,500 |

**Tier-1 metros** (×2.0): **Santiago (Gran Santiago)** — only metro reaching tier-1 status.

**Tier-2 cities** (×1.4, 24 cities): Valparaíso, Viña del Mar, Concepción, Talcahuano, La Serena, Coquimbo, Antofagasta, Iquique, Arica, Temuco, Rancagua, Talca, Chillán, Puerto Montt, Osorno, Valdivia, Calama, Copiapó, Punta Arenas, Curicó, Los Ángeles, San Antonio, Quillota, Tomé.

### Chilean vehicle split

Chile is dominated by Pampean-style truck freight similar to Argentina but with **two unique factors**: massive **mining truck traffic** in the northern regions (Antofagasta/Tarapacá/Atacama) and **forestry truck traffic** in the south (Bío Bío/Araucanía/Los Lagos). Motorcycle share is moderate.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Santiago) | 75% | 10% | 10% | 5% |
| Tier-2 | 73% | 10% | 12% | 5% |
| Rural | 60% | 10% | 27% | 3% |
| **Mining region (Norte Grande)** | **50%** | 10% | **38%** | 2% |

### National route network

- **Ruta 5** — the Pan-American backbone, 3,364 km from **Arica** (Peru border) to **Quellón** (Chiloé island). Toll-concessioned in much of central Chile.
- **Ruta 7 (Carretera Austral)** — 1,240 km gravel/paved through Patagonian wilderness from Puerto Montt to Villa O'Higgins (interrupted by ferries)
- **Ruta 9** — Sur Patagonia: Punta Arenas ↔ Puerto Natales (Torres del Paine access)
- **Ruta 11** — Arica ↔ Tambo Quemado (Bolivia border, La Paz access)
- **Ruta 16, 21, 25, 27** — Antofagasta region mining access roads
- **Ruta 60** — Mendoza international corridor (Los Libertadores pass)
- **Ruta 68** — Santiago ↔ Valparaíso (commuter corridor, ~120,000 AADT in peak)
- **Ruta 78** — Santiago ↔ San Antonio (port + Costa Central)
- **Autopista Central / Costanera Norte / Vespucio Norte/Sur/Oriente** — Santiago's tolled urban autopistas

## Railway

Chile has **no bespoke rail enricher** — only Argentina does in South America. Chilean rail noise is computed from **OSM rail geometry with class-default passenger/freight frequencies** (the table below), not from an ingested national rail feed. The datasets noted here were evaluated for a future enricher but are **not currently integrated**; the defaults assign heavier freight counts to the northern mining corridors by line type, not by matching against these layers.

### Red Ferroviaria Nacional (evaluated, not yet integrated)

- **Source**: `services6.arcgis.com/133a00biU9FItiqJ/arcgis/rest/services/Red_Ferroviaria/FeatureServer/0`
- **Records**: 1,244 polyline segments (890 with `Activ_2016='SI'`, 37 inactive, 317 blank). Not currently ingested — rail geometry comes from OSM.

### Operators

Chilean rail is **freight-dominated** with limited regional passenger service. No long-distance passenger rail (cancelled 1990s).

- **EFE** (Empresa de los Ferrocarriles del Estado) — passenger:
  - **Biotrén** (Concepción/Greater Bío Bío)
  - **Metrotrén Rancagua/Nos** (Santiago commuter to Rancagua/Nos)
  - **Tren Limache-Puerto** (Valparaíso suburban, Limache ↔ Puerto Valparaíso)
  - **Tren del Recuerdo** (heritage tourist trains)
- **Ferronor** — northern mining cargo (Atacama/Antofagasta)
- **FCAB** (Antofagasta-Bolivia, narrow gauge) — copper concentrate to ports
- **FEPASA** (Ferrocarriles del Pacífico) — central/south freight (forestry, agriculture)
- **Trans Andes Logística** — regional freight

### Metro de Santiago

- **Lines**: 6 operating lines (1, 2, 3, 4, 4A, 5, 6) — **3rd-busiest metro in Latin America** after Mexico City and São Paulo (~2.5M daily passengers pre-pandemic). The OCUC `Lineas_actuales_metro` ArcGIS layer was evaluated (it still marks Lines 3 and 6 as PROYECTADA despite operation since 2017-2019) but is **not ingested** — Metro track geometry comes from OSM `railway=subway`, with the light_rail default frequency below.

### DTPM GTFS (not integrated)

- A DTPM (Directorio de Transporte Público Metropolitano) GTFS feed exists for the Red Metropolitana de Movilidad (buses + Metro). It is **not integrated** — no measured Metro frequencies are used; the light_rail class default applies instead.

### trains/day defaults

These are **class-default frequencies** (geometry-driven, not measured train counts):

| Context | pax/day | frt/day |
|---|---:|---:|
| Santiago Metrotrén / commuter (Rancagua/Nos) | 80 | 10 |
| Concepción Biotrén / Valparaíso Limache-Puerto | 40 | 8 |
| **Northern mining cargo (Ferronor/FCAB Antofagasta-Tarapacá)** | 0 | 24 |
| FEPASA central/south freight | 1 | 14 |
| Other operational rural | 1 | 8 |
| Branch lines | 1 | 4 |
| **Metro de Santiago (light_rail Lines 1-6)** | 350 | 0 |
| Tram | 60 | 0 |
| Disused/abandoned rail (OSM `railway=disused/abandoned`) | 0 | 0 (skip) |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. Microsoft contributed Chilean building footprints in their 2023-2024 Overture release. No Chilean cadastre downloaded — IDE Chile (`ide.cl`) publishes catastral parcels but only at municipal level.

## Industrial

Chile has **excellent industrial open data** thanks to **CNE** (Comisión Nacional de Energía), **SERNAGEOMIN** (Servicio Nacional de Geología y Minería), and the global **GEM Power Plant Database** all publishing via the Esri Chile mirror.

### CNE Centrales de Generación Eléctrica — 203 thermal plants

- **Source**: `services.arcgis.com/r7t1P5pnkoOLRdhr/arcgis/rest/services/Centrales_de_Generación_Eléctrica/FeatureServer/0`
- **Records**: 203 plants, all `ESTADO='OPERATIVA'`
- **Top operating thermal**: Atacama 716 MW, Guacolda 702 MW, Mejillones 538 MW, Kelar 517 MW, Angamos 502 MW, Cochrane 490 MW, Tocopilla 427 MW
- **Combustibles**: PETROLEO DIESEL 152, GAS NATURAL 14, CARBON 6 (but multiple large coal units), CARBON-PETCOKE 3, CARBON-GAS NATURAL 1, COGENERACION 1, etc.

### GEM Global Integrated Power — 722 plants, 427 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Chile'`

| Fuel | Plants (operating) | Notable facilities |
|---|---:|---|
| **solar** | 422 | **Cerro Dominador 110 MW** (first commercial solar tower in South America), Guanchoi 398 MW, CEME 480 MW. Atacama desert has the **world's best solar resource** |
| **wind** | 122 | Antofagasta region, Ovalle, Coquimbo, Calama, Bío Bío |
| **coal** | 57 | **Mejillones**, **Tocopilla**, **Puchuncaví/Ventanas**, **Coronel**, **Bocamina** (Codelco/Enel/Engie/AES) |
| **oil/gas** | 56 | Kelar 517 MW (Mejillones), Nehuenco 411 MW, Quintero LNG terminal CCGT |
| **hydropower** | 46 | **Ralco 690 MW**, **Pehuenche 570 MW**, **Colbún 474 MW**, **Pangue 467 MW**, **El Toro 450 MW**, Antuco, Rapel, Chacabuquito |
| **bioenergy** | 14 | Forestry/sawmill cogeneration in Bío Bío/Araucanía |
| **geothermal** | 5 | **Cerro Pabellón 81 MW** — only operating geothermal plant in South America |

### SERNAGEOMIN Catastro Relaves — 795 mining tailings dams (UNIQUE TO CHILE)

Chile is the **world's largest copper producer** (~28% of global supply). The SERNAGEOMIN Catastro Relaves layer is unique to Chile in this pipeline.

- **Source**: `services.arcgis.com/r7t1P5pnkoOLRdhr/arcgis/rest/services/Catastro_Relaves/FeatureServer/0`
- **Records**: 795 tailings dams, **140 active** (128 ACTIVO + 12 EN CONSTRUCCION)
- **Resources**: 324 COBRE + 167 COBRE-ORO + 16 COBRE-MOLIBDENO = ~507 copper-related; 204 ORO + 34 ORO-COBRE = ~242 gold-related
- **NACE mapping**: All map to **NACE 07** (Mining of metal ores) — distinct from NACE 35 power generation

**Major mines included**:
- **Chuquicamata** (Codelco) — world's largest open-pit copper mine
- **Escondida** (BHP) — world's largest copper mine by output (~5% global supply)
- **Collahuasi** (Anglo American/Glencore)
- **El Teniente** (Codelco) — world's largest underground copper mine
- **Andina** (Codelco)
- **Spence**, **Radomiro Tomic** (Codelco)
- **Centinela** (Antofagasta Minerals)
- **Quebrada Blanca** (Teck)
- **Mantoverde**, **Mantos Blancos** (Mantos Copper / Capstone)
- **Caserones**, **Sierra Gorda**
- **Pelambres** (Antofagasta Minerals)
- **Andacollo** (Teck), **Candelaria** (Lundin)

### CNE Substations — 1,132 (1,129 ≥110 kV in CL bbox)

- **Source**: `services.arcgis.com/r7t1P5pnkoOLRdhr/arcgis/rest/services/Transmisión_Eléctrica/FeatureServer/2`
- **Filter**: `TENSION_KV >= 110` (transmission-level, skip distribution)
- **NACE mapping**: NACE 35

### Industrial enrichment results

- 984 CL-bbox hexes with industrial.arrow
- 75,962 OSM sites scanned, **5,504 matched** across all sources, **5,286 new NACE entries**
  - 4,241 by CNE Centrales (verified thermal — highest priority)
  - 1,189 by GEM CL (renewable backfill)
  - 74 by SERNAGEOMIN Catastro Relaves (mining → NACE 07)

## Validation

Chile implements noise regulation via:

- **MMA (Ministerio del Medio Ambiente)** at [mma.gob.cl](https://mma.gob.cl/)
- **DS 38/2011** Norma de Emisión de Ruidos Generados por Fuentes Fijas (industrial)
- **DS 146/1997** Norma de Emisión de Ruidos Molestos (general ambient)
- **SMA (Superintendencia del Medio Ambiente)** at [sma.gob.cl](https://sma.gob.cl/) — environmental enforcement
- **SEREMI MMA regional offices** for local enforcement
- Limit values: residential day/night 55/45 dBA, mixed 60/50 dBA, commercial 65/55 dBA, industrial 70/60 dBA

Notable noise zones:

- **Ruta 5 Pan-American Highway** — Arica to Puerto Montt, the entire central Chilean spine. Concessioned with continuous traffic counts (not openly published).
- **Autopista Central, Costanera Norte, Vespucio Norte/Sur/Oriente** — Santiago urban tollways, ~120,000–200,000 AADT in peak segments
- **Avenida Apoquindo / Av. Alameda / Av. Vitacura** (Santiago) — major arterials
- **Ruta 68** Santiago ↔ Valparaíso — major commuter corridor
- **Ruta 78** Santiago ↔ San Antonio
- **Metro de Santiago Lines 1, 2, 4, 5** — partly elevated, mostly underground
- **Biotrén Concepción** — surface commuter rail through Greater Concepción
- **Ferrocarril Antofagasta-Calama (FCAB)** — narrow-gauge mining cargo
- **Mejillones thermal complex** (538+ MW coal/gas) — major industrial noise hub
- **Puchuncaví/Ventanas industrial complex** — coal + smelter (closed 2023) + petrochemicals
- **Coronel thermal complex** (Bocamina I/II coal, ~620 MW)
- **Chuquicamata smelter + mine** — Codelco's flagship operation, in-pit mine + smelter near Calama
- **El Teniente** — Codelco underground mine + Caletones smelter near Rancagua
- **Escondida mine** (BHP, Atacama desert)
- **Cerro Dominador solar tower** (Atacama, 110 MW + 100 MW PV) — first commercial solar tower in South America
- **Ralco/Pangue/Pehuenche** hydroelectric dams (Bío Bío river)
- **Arturo Merino Benítez** (SCL/SCEL Santiago), **Cerro Moreno** (ANF/SCFA Antofagasta), **Diego Aracena** (IQQ/SCDA Iquique), **Carlos Ibáñez del Campo** (PUQ/SCCI Punta Arenas), **Mataveri** (IPC/SCIP Easter Island), **Chacalluta** (ARI/SCAR Arica) — covered by global aircraft layer
