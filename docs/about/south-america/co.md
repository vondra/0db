---
title: Colombia
intro: Noise mapping data sources for Colombia.
map: { center: [-74, 4], zoom: 5 }
---

## Road traffic

### INVIAS Red Vial Nacional + TPDS_NUBE TPDA (UNIQUE: with vehicle class breakdown)

**Colombia is the only country in this entire pipeline whose national TPDA dataset includes per-segment vehicle class breakdown** (cars/buses/trucks percentages + axle-class counts). Brazil/Argentina/Chile only had AADT totals — Colombia's INVIAS publishes the actual CNOSSOS-format inputs.

- **Source 1 — Road network**: INVIAS via Esri Chile mirror (`SIG_INVIAS` orgId `kyerLIHvrND0OSya`)
  - URL: `https://services6.arcgis.com/kyerLIHvrND0OSya/arcgis/rest/services/RedVialNacional_OpenData/FeatureServer/0`
  - Records: **625 polylines**
  - Fields: `codigo_via`, `superficie` ('1'=paved/'2'=unpaved), `administrador` ('1'=INVIAS / '2'=ANI / '3'=Concesión Departamental), `calzada` ('1'=single/'2'=dual), `concesion`
  - INVIAS administers ~17,000 km national roads; ANI ~8,000 km of 4G concessioned program

- **Source 2 — TPDS_NUBE TPDA traffic counts**: INVIAS Plan Nacional de Censos
  - URL: `https://services6.arcgis.com/kyerLIHvrND0OSya/arcgis/rest/services/TPDS_NUBE/FeatureServer/0`
  - Records: **1,271 polyline segments**, of which **822 have non-zero `conteo`** (real AADT)
  - Stats: min=49, median=5,297, max=**86,400**, mean=8,617
  - **Critical fields**:
    - `conteo` — total AADT
    - `au_p` — automoviles (cars) %
    - `bu_p` — buses %
    - `ca_p` — camiones (trucks) %
    - `tcam` — total truck count (raw)
    - `c3, c4, c5, c6, c7` — axle-class breakdown (3, 4, 5, 6, 7+ axles)
  - Sample: estacion 7 SALITRE-SOPÓ-BRICEÑO Cundinamarca, conteo=14,720, au=68% / bu=12% / ca=20%
  - Vintage: 2024 (latest INVIAS census)
  - Source CRS: MAGNA-Sirgas Bogotá WKID 3116 — server reprojects via `outSR=4326`

### Vehicle splits — TPDA per-segment vs default

**On TPDA-matched segments**: Apply real `au_p`/`bu_p`/`ca_p` from INVIAS census. Buses → CNOSSOS "medium". Motorcycles aren't in TPDA so we add 5% moto allocation.

**Default Colombian splits** (fallback for non-matched segments):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Bogotá / Medellín) | 55% | 5% | 10% | **30%** |
| Tier-2 | 60% | 5% | 10% | **25%** |
| Rural | 55% | 8% | 22% | **15%** |
| **Coal corridor (La Guajira / Cesar)** | 40% | 5% | **45%** | 10% |

Colombia has the **second-highest motorcycle share** in this pipeline after Vietnam/Indonesia. Bogotá and Medellín especially have heavy motorbike traffic.

### AADT defaults (fallback)

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (autopista, Ruta del Sol) | 35,000 | 70,000 | 49,000 |
| 1 trunk (INVIAS Red Vial paved) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 700 | 1,400 | 980 |

### Red Vial spatial-match AADT

| RVN combination | AADT (rural) |
|---|---:|
| ANI + paved + dual calzada (Concesionado 4G) | 25,000 |
| ANI + paved + single calzada | 18,000 |
| INVIAS + paved | 12,000 |
| Departamental + paved | 6,000 |
| Unpaved | 1,500 |

**Tier-1 metros** (×2.0): **Bogotá D.C.** (~8M, 2,640m altitude), **Medellín** (Valle de Aburrá, ~3.5M).

**Tier-2 cities** (×1.4, 24 cities): Cali, Barranquilla, Cartagena, Cúcuta, Bucaramanga, Pereira, Santa Marta, Ibagué, Manizales, Pasto, Villavicencio, Neiva, Armenia, Soledad, Soacha, Valledupar, Montería, Sincelejo, Buenaventura, Tunja, Riohacha, Quibdó, Florencia, Popayán.

### Coal mining regions (extreme HGV share)

Colombia is the **5th-largest coal exporter globally**. Two major coal regions get a special 45% heavy-vehicle share:

- **La Guajira (Cerrejón)**: Cerrejón mine (Glencore since 2021), 31 Mtpa thermal coal, exclusive Cerrejón coal railway 150 km to Puerto Bolívar (world's longest privately-operated coal railway)
- **Cesar (Drummond/Calenturitas)**: Drummond Calenturitas + La Loma + El Descanso, ~70 Mtpa via FENOCO railway to Santa Marta port

### National route network

- **Ruta del Sol** (RNT route) — Caribbean coast ↔ Bogotá ↔ Medellín, the central-northern spine via Magdalena Medio
- **Pan-American Highway** (Vía Bolivariana) — Pasto ↔ Popayán ↔ Cali ↔ Medellín ↔ Bogotá ↔ Cúcuta (Venezuela border)
- **Vía al Llano** — Bogotá ↔ Villavicencio (extremely steep mountain descent through Cundinamarca/Meta)
- **Autopista Norte** — Bogotá ↔ Tunja ↔ Bucaramanga
- **Autopista Sur** — Bogotá ↔ Soacha ↔ Girardot
- **Costa Caribe coastal road** — Cartagena ↔ Barranquilla ↔ Santa Marta ↔ Riohacha
- **Las Pavas** — Magdalena Medio corridor
- **Autopista Medellín** — Bogotá ↔ Medellín mountain pass
- **Pacífico 1/2/3** — 4G concession program connecting Antioquia to the Pacific
- **Mar 1 / Mar 2** — Antioquia ↔ Caribbean coast 4G concessions

## Railway

### Estaciones SITVA (Metro de Medellín)

- **Source**: `services1.arcgis.com/Qrk4Z5vQ94JXkdYM/arcgis/rest/services/Estaciones_SITVA/FeatureServer/0`
- **Records**: **69 station points** (no track polylines)
  - **39 METRO** (TIPO=1) — Lines A, B
  - **10 METROCABLE** (TIPO=2) — Lines K, J, L, H, M, P (cable cars)
  - **20 METROPLÚS / BRT** (TIPO=3) — bus rapid transit, NOT rail (excluded)
- **Mitigation**: Geographic Metro boost via Valle de Aburrá bbox + OSM `railway=light_rail/subway` tag.

### Colombian rail context

Colombia has extremely limited operational rail. Almost all is freight, dominated by coal corridors:

- **Metro de Medellín** — Lines A and B + 6 Metrocable cable car lines (K/J/L/H/M/P) + Tranvía Ayacucho LRT — **only fully operational metro system in Colombia** (~1M daily passengers pre-pandemic)
- **Bogotá Metro Line 1** — under construction by CHEC consortium, target 2028
- **Bogotá Regiotram** — Cundinamarca regional commuter, under construction
- **TransMilenio Bogotá** — BRT bus rapid transit (NOT rail)
- **Cerrejón Railway** — 150 km privately-operated coal corridor, **world's longest** for a single mine (La Guajira → Puerto Bolívar)
- **FENOCO** (Ferrocarriles del Norte de Colombia) — coal corridor Chiriguaná (Cesar) → Santa Marta port (Drummond, Glencore)
- **Ferrocarril del Pacífico** — Cali ↔ Buenaventura limited freight (Ferrosur)
- **Atlantic Railway Network (FRC)** — mostly inactive

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Cerrejón coal corridor (La Guajira)** | 0 | 60 |
| **FENOCO Drummond corridor (Cesar→Santa Marta)** | 0 | 50 |
| Pacífico Cali↔Buenaventura | 0 | 12 |
| Other operational rural | 1 | 6 |
| Branch lines | 0 | 4 |
| Industrial sidings | 0 | 6 |
| **Metro de Medellín (light_rail Lines A/B)** | 350 | 0 |
| Tranvía Ayacucho (tram) | 200 | 0 |
| Metrocable cable car (light_rail) | 100 | 0 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. No Colombian cadastre downloaded — IDECA Bogotá publishes Bogotá-specific data but the catastro server was unreachable. Microsoft contributed Colombian building footprints in their 2023-2024 Overture release.

## Industrial

### GEM Global Integrated Power — 937 plants, 251 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Colombia'`

**Top 10 operating plants** (hydropower-dominated — Colombia gets ~70% of electricity from hydro):

| Plant | MW | Type | Department |
|---|---:|---|---|
| Guavio | 1,250 | hydropower | Cundinamarca |
| San Carlos | 1,240 | hydropower | Antioquia |
| **Hidroituango** | 1,200 | hydropower | Antioquia (partial after 2018 disaster) |
| Chivor | 1,000 | hydropower | Boyacá |
| Sogamoso | 820 | hydropower | Santander |
| Termobarranquilla | 791 | oil/gas | Atlántico |
| Porce III | 660 | hydropower | Antioquia |
| Termocandelaria | 566 | oil/gas | Bolívar |
| Guatapé | 560 | hydropower | Antioquia |
| Betania | 540 | hydropower | Huila |

### ANM Títulos Mineros 2023 (UNIQUE: with mineral classification)

Colombia has **the most detailed mining classification** in the entire pipeline. Each title has a `MINERALES` field allowing per-mine NACE classification.

- **Source**: `services9.arcgis.com/pZylgd2zhNey2qXF/arcgis/rest/services/Titulos_mineros_vigentes__2023__Colombia/FeatureServer/62`
- **Records**: **7,541 polygon features**
- **Status filter**: Only `Explotación` + `Construcción y montaje` (~6,087 active in CO bbox)
- **Top minerals**: gold (985), coal/anhydrite (821), sand/gravel (740), anthracite/coking coal (584), river sand (409), clay (316), copper (298), thermal coal (284)
- **NACE classification (custom)**:
  - Coal/anthracite/lignite/peat → **NACE 05** (Mining of coal and lignite)
  - Metals (gold/copper/iron/silver/zinc/lead/nickel/molybdenum/emerald) → **NACE 07** (Mining of metal ores)
  - Stone/sand/clay/gravel/quarry → **NACE 08** (Other mining and quarrying)

**Major mines included**:

- **Cerrejón** (La Guajira) — 31 Mtpa thermal coal, world's largest open-pit coal mine in South America (Glencore since 2021)
- **Drummond Calenturitas + La Loma + El Descanso** (Cesar) — ~70 Mtpa coal
- **Cerro Matoso** (Córdoba) — ferronickel mine + smelter (Anglo American until 2021, now SOUTH32)
- **Buriticá** (Antioquia) — gold mine (Continental Gold / Zijin Mining)
- **Marmato** (Caldas) — gold mine
- **Segovia** (Antioquia) — gold mine (Aris Mining)
- Various **emerald mines** (Muzo, Coscuez, Chivor in Boyacá) — Colombia is the world's #1 emerald producer

### ANH Hidrocarburos 2023

- **Source**: `services9.arcgis.com/pZylgd2zhNey2qXF/arcgis/rest/services/Explotación_de_hidrocarburos_2023__ANH_/FeatureServer/19`
- **Records**: **445 oil/gas production blocks** (236 in PRODUCCION, only these enriched)
- **Operators**: Ecopetrol, Occidental, Parex, GeoPark, Frontera Energy, Hupecol, Tecpetrol, Equion (formerly BP), Mansarovar, Pacific E&P
- **Cuencas (sedimentary basins)**:
  - **Llanos Orientales** — Cusiana, Cupiagua, Rubiales, Castilla, Quifa
  - **VMM** (Valle Medio del Magdalena) — Apiay, Yariguí-Cantagallo
  - **Catatumbo** — Caño Limón (Arauca, near Venezuela), Tibú
  - **Putumayo** — Orito, Tello
- **NACE classification**: All map to **NACE 06** (Extraction of crude petroleum and natural gas)

### Industrial enrichment results

- 575 CO-bbox hexes with industrial.arrow
- 13,264 OSM sites scanned, **1,445 matched** (807 ANM mining + 368 ANH oil/gas + 270 GEM power), **1,421 new NACE entries**

## Validation

Colombia implements noise regulation via:

- **Ministerio de Ambiente y Desarrollo Sostenible (MinAmbiente)** at [minambiente.gov.co](https://www.minambiente.gov.co/)
- **Resolución 627/2006** Norma de Emisión de Ruido y Ruido Ambiental — limit values:
  - Residential day/night: 65/55 dBA
  - Commercial: 70/60 dBA
  - Industrial: 75/75 dBA
  - Tranquility (hospitals/schools): 55/45 dBA
- **ANLA** (Autoridad Nacional de Licencias Ambientales) — environmental licensing, includes noise limits in EIA
- **CARs** (Corporaciones Autónomas Regionales) — 33 regional environmental authorities for local enforcement
- **IDEAM** (Instituto de Hidrología, Meteorología y Estudios Ambientales) — environmental monitoring

Notable noise zones:

- **Avenida Carrera 30 (Norte-Quito-Sur, NQS)** Bogotá — major north-south arterial
- **Calle 26** Bogotá — Aeropuerto El Dorado access
- **Avenida Boyacá / Avenida 68** Bogotá — circumvalation arterials
- **Autopista Norte** Bogotá ↔ Tunja
- **Autopista Sur** Bogotá ↔ Soacha
- **Vía al Llano** Bogotá ↔ Villavicencio (extreme mountain descent)
- **Autopista Medellín** Bogotá ↔ Medellín
- **Túnel de la Línea** Quindío/Tolima — South America's longest highway tunnel (8.65 km)
- **Metro de Medellín Lines A/B** — partly elevated viaducts through Valle de Aburrá
- **Cerrejón coal railway** (La Guajira, 150 km) — frequent heavy coal trains
- **FENOCO Cesar↔Santa Marta corridor** (245 km) — heavy coal trains
- **El Dorado (BOG/SKBO Bogotá)**, **José María Córdova (MDE/SKRG Medellín)**, **Alfonso Bonilla Aragón (CLO/SKCL Cali)**, **Ernesto Cortissoz (BAQ/SKBQ Barranquilla)**, **Rafael Núñez (CTG/SKCG Cartagena)**, **Matecaña (PEI/SKPE Pereira)**, **Camilo Daza (CUC/SKCC Cúcuta)**, **Palonegro (BGA/SKBG Bucaramanga)** — covered by global aircraft layer
- **Hidroituango** (Antioquia, 1,200 MW partial) — Colombia's largest power plant (massively delayed by 2018 dam disaster)
- **Cerrejón mine + Puerto Bolívar coal terminal** (La Guajira)
- **Drummond coal complex + Santa Marta port** (Cesar/Magdalena)
- **Barrancabermeja Ecopetrol refinery** (250k bpd) — Colombia's largest refinery
- **Cartagena Ecopetrol refinery** (165k bpd) — Caribbean coast petrochemicals
- **Cerro Matoso ferronickel mine + smelter** (Córdoba)
- **Termobarranquilla** (Atlántico, 791 MW oil/gas)
- **Termocandelaria** (Bolívar, 566 MW oil/gas)
