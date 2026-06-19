---
title: Peru
intro: Noise mapping data sources for Peru.
map: { center: [-76, -10], zoom: 5 }
---

## Road traffic

### MTC Provías Red Vial Nacional + dIMD

Peru's official MTC portals at `mtc.gob.pe` are TCP-blocked from non-PE IPs, but MTC/Provías road data is mirrored by community users on ArcGIS Online. The 2024 MTC PROVIAS layer has rich attributes including per-segment `dIMD` (Índice Medio Diario) real AADT for 866 segments.

- **Source 1 — Red Vial Nacional**: `services6.arcgis.com/G8JFnqCHKQ9vb8YW/arcgis/rest/services/Red_Vial_Nacional_2024_MTC_PROVIAS_GEO_GPS_PERU_Suyo_Pomalia/FeatureServer/0`
  - **7,340 polylines** — national road network
  - Key fields: `cCodRuta`, `cNomRuta`, `cClasifica`, `cRegion`, `cSuperfici`, `cPeajes` (toll flag), `dIMD`, `dNroCarril`, `dVelProTra`
  - **dIMD values**: 866 non-zero (median 728, max 26,019) — census vintage ~2010-2019

- **Source 2 — Red Vial Departamental**: `services.arcgis.com/gafQrINhKg5HqHyr/arcgis/rest/services/Red_Vial_Departamental/FeatureServer/0`
  - 3,150 provincial road polylines (no IMD)

### Route classifications

| cClasifica | Count | Description |
|---|---:|---|
| LONGITUDINAL DE LA COSTA | 618 | **Panamericana Norte/Sur** (PE-1N, PE-1S) — main coastal spine |
| LONGITUDINAL DE LA SIERRA | 980 | **Andean highway spine** (PE-3N, PE-3S) |
| LONGITUDINAL DE LA SELVA | 486 | **Amazon road spine** (PE-5N, PE-5S) |
| TRANSVERSAL | 2,269 | East-west cross routes (PE-20, PE-22, PE-26, etc.) |
| RAMAL | 2,255 | Branches |
| VARIANTE | 732 | Alternate routes |

### Peruvian AADT defaults

Peru has a strong **tri-regional split** — COSTA (coastal desert), SIERRA (highlands), SELVA (Amazon). Traffic volumes differ dramatically.

| OSM class | Costa | Sierra | Selva | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|---:|---:|
| 0 motorway (Panam toll) | 35,000 | 15,000 | 8,000 | 70,000 | 49,000 |
| 1 trunk (LONGITUDINAL) | 12,000 | 5,000 | 2,500 | 24,000 | 16,800 |
| 2 primary (TRANSVERSAL) | 6,000 | 2,500 | 1,200 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 1,500 | 800 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 700 | 400 | 3,000 | 2,100 |
| 5 residential | 700 | 400 | 200 | 1,400 | 980 |

### MTC spatial-match AADT (by classification + peaje)

| Combination | AADT (rural) |
|---|---:|
| Concesión + LONGITUDINAL DE LA COSTA (Panam toll) | 20,000 |
| Concesión + other LONGITUDINAL | 10,000 |
| LONGITUDINAL DE LA COSTA paved | 12,000 |
| LONGITUDINAL DE LA SIERRA/SELVA paved | 6,000 |
| TRANSVERSAL paved | 4,000 |
| RAMAL / VARIANTE / DEPARTAMENTAL paved | 2,500 |
| Unpaved | 1,200 |

**Tier-1 metros** (×2.0): **Lima / Callao** (~11M, coastal). Peru's only truly tier-1 metro.

**Tier-2 cities** (×1.4, 24 cities): Arequipa, Trujillo, Chiclayo, Piura, Iquitos, Cusco, Chimbote, Huancayo, Tacna, Juliaca, Ica, Cajamarca, Pucallpa, Sullana, Ayacucho, Chincha Alta, Huánuco, Tarapoto, Puno, Tumbes, Huaraz, Jaén, Huacho, Pisco.

### Peruvian vehicle split

Moderate motorcycle share (~15% urban), elevated heavy share on mining corridors, tri-regional differences.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Lima) | 65% | 6% | 14% | 15% |
| Tier-2 | 68% | 6% | 12% | 14% |
| Costa rural | 60% | 8% | 22% | 10% |
| **Sierra (Andes highways)** | 50% | 10% | **30%** | 10% |
| Selva (Amazon) | 60% | 8% | 22% | 10% |
| **Mining corridor** | **45%** | 8% | **38%** | 9% |

### National route network

- **PE-1N / PE-1S (Panamericana Norte/Sur)** — main coastal spine, Tumbes (Ecuador border) ↔ Chile (Tacna). 2,500+ km. Partially concessioned (Red Vial 4, 5, 6, Autopista del Sol).
- **PE-3N / PE-3S (Longitudinal de la Sierra)** — Andean highway spine.
- **PE-5N / PE-5S (Longitudinal de la Selva)** — Amazon spine.
- **PE-22 (Carretera Central)** — Lima ↔ La Oroya ↔ Huancayo. Extreme Andean pass (Ticlio 4,818 m).
- **PE-26 (Interoceánica Sur / IIRSA Sur)** — Peru-Brazil-Bolivia corridor, Ilo/Matarani ↔ Puerto Maldonado ↔ Brazil border.
- **PE-30 / PE-32 (Interoceánica Norte)** — Paita ↔ Chiclayo ↔ Tarapoto.

## Railway

### Lima Metro + Peruvian rail defaults

Peru has **no bespoke rail enricher** — only Argentina does in South America. Peruvian rail noise is computed from **OSM rail geometry with class-default passenger/freight frequencies** (the table below), not from an ingested rail feed. No national rail line dataset exists for PeruRail/FCCA/Southern Peru Copper anyway — all are private operators without open geometry — and the mining/tourist corridors get their freight/passenger weighting by line type, not by matching a traffic dataset.

A Lima Metro ArcGIS layer (`METRO_LIMA_WFL1` — Line 1 operating, Line 2 under construction, Line 4 planned) exists but is **not ingested**; Metro track geometry comes from OSM, with the light_rail class default.

### Peruvian rail operators

- **Lima Metro Line 1** — 35 km elevated electric, Villa El Salvador ↔ San Juan de Lurigancho, operating since 2011. Lima's **only operating metro line**.
- **Lima Metro Line 2** — underground tunnel, Callao ↔ Ate, under construction (target 2028).
- **Lima Metro Line 4** — partial connector, under construction.
- **Ferrocarril Central Andino (FCCA)** — Callao ↔ La Oroya ↔ Huancayo/Cerro de Pasco. **World's highest mainline railway** (Ticlio pass 4,818 m). Mineral concentrates, cement, petroleum.
- **PeruRail** (private tourist): **Cusco ↔ Machu Picchu** (~20 trains/day to Aguas Calientes), **Cusco ↔ Puno** (Andean Explorer luxury), occasional Arequipa ↔ Juliaca ↔ Cusco
- **Ferrocarril del Sur Oriente (FCSO)** — Arequipa ↔ Juliaca ↔ Cusco
- **Southern Peru Copper Railway** — private mining freight, Toquepala/Cuajone ↔ Ilo port/smelter

### trains/day defaults

**Class-default frequencies** (geometry-driven, not measured train counts); the corridor rows below show the intended weighting by line type:

| Context | pax/day | frt/day |
|---|---:|---:|
| **Lima Metro Line 1 (light_rail)** | 350 | 0 |
| **Southern Peru Copper (Toquepala↔Ilo)** | 0 | 40 |
| **Ferrocarril Central Andino (Callao↔Huancayo)** | 0 | 30 |
| **Machu Picchu tourist corridor** | 20 | 0 |
| Cusco/Puno/Arequipa tourist rail | 4 | 2 |
| Other operational rural | 1 | 4 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. Microsoft contributed Peruvian building footprints in their 2023-2024 release. No PE-specific cadastre downloaded — IGN Peru uses its own non-hosted GeoServer behind blocked gov domain.

## Industrial

**Peru has the most detailed mining polygon data in the entire pipeline.** No other country publishes actual open-pit, tailings dam, leach pad, and waste rock dump geometry openly. This is served via PERUMIN_WFL1 (community mirror of Osinergmin supervised mining data).

### GEM Global Integrated Power — 240 plants, 85 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Peru'`

**Top 10 operating plants**:

| Plant | MW | Type | Location |
|---|---:|---|---|
| Kallpa | 874 | oil/gas CCGT | Chilca |
| Chilca | 862 | oil/gas CCGT | Chilca |
| Mantaro | 798 | hydropower | Huancavelica |
| Santiago Antúnez de Mayolo | 798 | hydropower | Huancavelica |
| Fenix | 570 | oil/gas CCGT | Chilca |
| Ventanilla | 532 | oil/gas CCGT | Callao |
| Cerro del Águila | 525 | hydropower | Huancavelica |
| Chaglla | 456 | hydropower | Huánuco |
| Santo Domingo de los Olleros | 334 | oil/gas | Huarochirí |
| Las Flores | 325 | oil/gas | Chilca |

### INGEMMET Yacimientos Mineros

- **Source**: `services1.arcgis.com/IOnDXYLCAWAfoO54/arcgis/rest/services/INGEMMET_Yacimientos_mineros/FeatureServer/0`
- **Records**: 1,507 mine point records (105 active in PE bbox)

### PERUMIN_WFL1 — UNIQUE DETAILED MINING POLYGONS

| Layer | Records | Content |
|---|---:|---|
| 2 | 335 (786 vigente) | Unidades Mineras Supervisadas (active concessions) |
| **4** | **27** | **Tajos Abiertos (open-pit polygons)** |
| **5** | **12** | **Relaveras (tailings dam polygons)** |
| **6** | **17** | **Pila de Lixiviación (heap leach pad polygons)** |
| **7** | **37** | **Desmonteras (waste rock dump polygons)** |
| 13 | 16 | Major concession polygons with METALES_MINERALES |

**Major Peruvian mines captured** (all NACE 07 — Mining of metal ores):

- **Antamina** (Ancash, BHP/Glencore/Teck/Mitsubishi) — world's 8th largest copper mine, also zinc/silver/molybdenum
- **Cerro Verde 1/2/3** (Arequipa, Freeport) — world's 5th largest copper mine
- **Yanacocha/Chaupiloma** (Cajamarca, Newmont/Buenaventura) — world's 2nd largest gold mine by reserves
- **Toquepala + Cuajone** (Moquegua/Tacna, Southern Copper Corporation) — copper-molybdenum
- **Las Bambas/Ferrobamba** (Apurímac, MMG) — major copper, 400kt/yr
- **Toromocho** (Junín, Chinalco) — porphyry copper, 300kt/yr
- **Constancia** (Cusco, Hudbay Minerals) — 90kt Cu/yr
- **Marcona** (Ica, Shougang) — iron ore
- **Antapaccay** (Cusco, Glencore)

### Industrial enrichment results

- 399 PE-bbox hexes with industrial.arrow
- 8,117 OSM sites scanned, **329 matched**, 314 new NACE entries
  - PERUMIN polygons: 181 (richest — pits/tailings/leach pads/waste dumps)
  - GEM power plants: 127
  - INGEMMET yacimientos: 21

## Validation

Peru implements noise regulation via:

- **MINAM** (Ministerio del Ambiente) at [minam.gob.pe](https://www.minam.gob.pe/)
- **DS 085-2003-PCM** — Estándares de Calidad Ambiental para Ruido (noise quality standards)
  - Residential day/night: 60/50 dBA
  - Commercial: 70/60 dBA
  - Industrial: 80/70 dBA
  - Protection zone (hospitals/schools): 50/40 dBA
- **OEFA** (Organismo de Evaluación y Fiscalización Ambiental) — environmental enforcement
- **SENACE** (Servicio Nacional de Certificación Ambiental) — environmental licensing

Notable noise zones:

- **Panamericana Norte / Sur** (PE-1N/PE-1S) — Peru's main 2,500 km coastal highway
- **Carretera Central** (PE-22) — extreme Andean pass, Lima ↔ La Oroya ↔ Huancayo
- **Via de Evitamiento + Javier Prado + Panamericana Sur ring** — Lima urban highway network (~200,000 AADT peak)
- **Avenida Arequipa / Avenida Abancay / Avenida Arequipa** — Lima Centro-Miraflores arterials
- **Carretera Central Huarochirí** — Lima mountain exit
- **Interoceánica Sur (IIRSA Sur)** — Peru-Brazil-Bolivia corridor
- **Lima Metro Line 1** — elevated viaducts through Villa El Salvador ↔ San Juan de Lurigancho
- **Ferrocarril Central Andino (FCCA)** — world's highest mainline, Callao↔Huancayo via Ticlio pass
- **Southern Peru Copper Railway** — Toquepala/Cuajone ↔ Ilo (mining freight)
- **Jorge Chávez (LIM/SPJC Lima)**, **Alejandro Velasco Astete (CUZ/SPZO Cusco)**, **Rodríguez Ballón (AQP/SPQU Arequipa)**, **FAP Carlos Martínez de Pinillos (TRU/SPRU Trujillo)**, **Francisco Secada Vignetta (IQT/SPQT Iquitos)** — covered by global aircraft layer
- **Mantaro Hydroelectric Complex** (Santiago Antúnez de Mayolo, 798 MW, Huancavelica) — Peru's largest power plant
- **Chilca CCGT cluster** (Kallpa 874 + Chilca 862 + Fenix 570 + Las Flores 325 = 2.6 GW) — Peru's largest thermal complex, south of Lima
- **Cerro Verde** (Arequipa) — world's 5th largest copper mine
- **Antamina** (Ancash) — world's 8th largest copper mine
- **Yanacocha** (Cajamarca) — world's 2nd largest gold mine
- **Toquepala + Cuajone + Ilo complex** (Moquegua/Tacna) — copper mines + smelter
- **Las Bambas / Ferrobamba** (Apurímac) — major copper mine
- **Las Bambas mine ↔ Espinar road corridor** — subject to recurring protests over heavy haulage
- **Camisea LNG corridor** (Pampa Melchorita terminal to Cusco gas field)
- **La Pampilla refinery** (Callao, Repsol) — Peru's largest refinery
