---
title: Venezuela
intro: Noise mapping data sources for Venezuela.
map: { center: [-66, 8], zoom: 6 }
---

## Road traffic

### VE360 Vialidad (SIGOT community mirror)

**Virtually all Venezuelan government portals are offline** due to the post-2014 political/economic crisis. MINTRANSPORTE, PDVSA, IFE, CVG, Metro Caracas, INE, Corpoelec, and MINPET are all unreachable (timeouts, DNS failures, or HTTP refused). IGVSB is the only gov domain that responds but has no ArcGIS REST endpoint.

**`proyecto.ve360`** (Venezuela360) is a community ArcGIS Online mirror that preserves the complete SIGOT (Sistema de Información Geográfica del Ordenamiento Territorial) national dataset from ~2013-2019 vintage. **This is the only working source for Venezuelan spatial data**.

- **Source — VE360 Vialidad**: `services6.arcgis.com/lpJCO3ug8HhNiEOV/arcgis/rest/services/Vialidad/FeatureServer/0`
- **Records**: **15,528 polyline features** with `Tipo_vía` classification

**Tipo_vía distribution**:

| Category | Count |
|---|---:|
| Carretera de Tierra (unpaved) | 6,666 |
| Camino Carretero | 3,464 |
| Camino Carretero / Sendero o Pica | 1,941 |
| (blank) | 1,192 |
| Carretera Engranzonada de 2 vías | 769 |
| Sendero o Pica | 760 |
| Carretera Engranzonada de +2 vías | 554 |
| Carretera Pavimentada + 2 Vías | 123 |
| **Autopista** | **49** |

Only ~180 segments are fully paved dual-carriageway or better. **No per-segment TPDA/IMD published** — MINTRANSPORTE/INVEA is offline.

### Venezuelan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (autopista) | 30,000 | 60,000 | 42,000 |
| 1 trunk (Troncal paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

Conservative estimates — Venezuela's auto fleet is shrinking due to the economic collapse (fuel shortages, ~7M emigration since 2015, lack of car imports).

### Vialidad spatial-match AADT

| Tipo_vía | AADT (rural) |
|---|---:|
| Autopista | 22,000 |
| Carretera Pavimentada + 2 Vías | 12,000 |
| Carretera Pavimentada de 2 vias | 8,000 |
| Carretera Engranzonada de +2 vías | 5,000 |
| Carretera Engranzonada de 2 vías | 3,000 |
| Camino Carretero | 1,800 |
| Carretera de Tierra | 1,500 |
| Camino Carretero / Sendero o Pica | 1,000 |
| Sendero o Pica | 500 |

**Tier-1 metros** (×2.0, 4 metros): **Caracas** (~2.2M, Coastal Range valley), **Maracaibo** (~1.5M, Lake Maracaibo oil capital), **Valencia** (~1.4M, Carabobo industrial), **Barquisimeto** (~1M, central).

**Tier-2 cities** (×1.4, 19 cities): Ciudad Guayana, Maracay, Maturín, Barcelona, Puerto La Cruz, San Cristóbal, Cumaná, Mérida, Ciudad Bolívar, Cabimas, Coro, Los Teques, Guarenas, Guanare, Valera, Punto Fijo, Acarigua, Barinas, San Felipe.

### Venezuelan vehicle split

High motorcycle share (~25% urban). Heavy share is **lower than rest of SA** due to economic collapse.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Caracas/Maracaibo/Valencia/Barquisimeto) | 60% | 5% | 10% | **25%** |
| Tier-2 | 62% | 6% | 12% | 20% |
| Rural | 58% | 8% | 22% | 12% |

### National route network

- **Autopista Regional del Centro (ARC)** — Caracas ↔ Valencia (110 km)
- **Autopista Francisco Fajardo** — Caracas bypass
- **Autopista Caracas ↔ La Guaira** — airport access
- **Troncal 1** — Caracas ↔ Valencia ↔ Barquisimeto ↔ Maracaibo (coastal spine)
- **Troncal 9** — Caracas ↔ Puerto La Cruz ↔ Cumaná (east coast)
- **Troncal 10** — Puerto La Cruz ↔ Ciudad Bolívar ↔ Puerto Ordaz ↔ Brazil border
- **Troncal 17** — Maracaibo ↔ Machiques ↔ Colombia border

## Railway

### Class defaults only — OSM rail geometry + context defaults

There is no Venezuela-specific rail enrichment. Rail geometry comes from OSM; trains/day are applied from the geographic defaults below. (The VE360 SIGOT mirror does host a Metro/Sistema Ferroviario layer, but we do not ingest it — the Vialidad road layer we do use contains only 5 incidental `Ferrocarril` segments — not a rail source.)

### Venezuelan rail context

- **Metro de Caracas** — 5 lines (L1-L5), opened 1983, extended through 2015. Degraded but operational. ~1M daily passengers pre-crisis.
- **Metro de Los Teques** — suburban Caracas
- **Metro de Valencia** — 1 line (~5 km, opened 2006)
- **Metro de Maracaibo** — 1 line, **largely abandoned post-2018** due to power/security issues
- **Sistema Ferroviario Ezequiel Zamora** — **only operational heavy rail commuter**, Caracas ↔ Charallave ↔ Cúa (41 km). Intended as first phase of never-built national rail network.
- **Ferrocarril Ferrominera Orinoco** — CVG iron ore freight, Ciudad Piar ↔ Puerto Ordaz (320 km). Cerro Bolívar iron ore → SIDOR + export.
- **No other operational rail** — all planned networks cancelled or abandoned.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Metro de Caracas (subway)** | 400 | 0 |
| Metro de Los Teques | 200 | 0 |
| Metro de Valencia / Maracaibo | 60 | 0 |
| **Sistema Ferroviario Ezequiel Zamora (Caracas↔Cúa)** | 50 | 4 |
| **Ferrominera Orinoco (Ciudad Piar↔Puerto Ordaz)** | 0 | 24 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. No VE-specific cadastre.

## Industrial

### VE360 Parque de Generación Eléctrica — 289 plants (31 actually operating)

- **URL**: `services6.arcgis.com/lpJCO3ug8HhNiEOV/arcgis/rest/services/Parque_de_Generación_Eléctrica_gdb/FeatureServer/0`
- **Critical fields**: `PLANTA`, `PROPIEDAD`, `CAPACIDAD_MW`, **`OPERACIÓN_ACTUAL_MW`**, `ESTADO_DEL_MANTENIMIENTO`

**Real-world collapse captured**: the dataset shows **15,361 MW nameplate capacity** but only **3,786 MW actually operating (~25%)**. Most thermal plants are tagged `Mantenimiento Pendiente` and have `OPERACIÓN_ACTUAL_MW = 0`. We filter to only plants actually producing power.

### VE360 Oil Infrastructure — Venezuela's only remaining functional industry

Ingested as point noise sources:

- **Pozos Petroleros**: **20,714 oil wells** across the Faja del Orinoco (extra-heavy crude belt — world's largest proven reserves) and Lake Maracaibo basin (traditional light crude) → NACE 06
- **Oil plants**: 28 processing plants → NACE 19
- **Subestaciones Eléctricas**: 209 substations → NACE 35

The SIGOT mirror also hosts oil pipelines (2,269 oleoducto/gasoducto polylines), ~110 pumping/compressor stations, and ~148 gas flaring/venting points (Venezuela historically has world's highest gas flaring rates), but these are **not currently ingested** as noise sources.

### GEM Global Integrated Power (backfill)

- **Records**: 102 total, 14 operating
- Backfills **Guri Dam / Simón Bolívar Hydroelectric** (**10,200 MW** — one of world's largest hydro plants), **Macagua** (3,140 MW), **Caruachi** (2,280 MW) — the Caroní River cascade

### Venezuela's industrial legacy (OSM-only classification)

These are Venezuela's historically major facilities, most degraded but operational:

- **Paraguaná Refining Center (CRP)** — historically **world's largest refining complex**:
  - **Amuay** (645k bpd nameplate)
  - **Cardón** (310k bpd)
  - **Bajo Grande** (15k bpd)
- **El Palito refinery** (Puerto Cabello, 130k bpd, PDVSA)
- **Puerto La Cruz refinery** (195k bpd, PDVSA)
- **SIDOR** (Siderúrgica del Orinoco, Ciudad Guayana steel mill)
- **Venalum** and **Alcasa** (Ciudad Guayana aluminum smelters — Venalum historically world's largest)
- **Ferrominera Orinoco** (iron ore: Cerro Bolívar + El Pao mines)
- **Bauxilum** (bauxite mining)

All operating at severely reduced capacity (typically <30%) due to post-2014 collapse.

### Venezuela does NOT have

- **No working gov portals** — all are offline
- **No per-segment TPDA/IMD**
- **No current 2020+ data** — VE360 is frozen at 2013-2019
- **No mining sector classification** — SIDOR/Alcasa/Venalum/Ferrominera rely on OSM only
- **No refinery NACE 19 tagging** — Paraguaná/El Palito/Puerto La Cruz tagged via OSM `landuse=industrial`

## Validation

Venezuela implements noise regulation via:

- **MINEC** (Ministerio del Poder Popular de Ecosocialismo) — formerly MINAMB, `minec.gob.ve` (non-functional)
- **Decreto 2217/1992** — Normas Sobre el Control de la Contaminación Generada por Ruido
- Standards are nominally in force but enforcement is minimal given the economic crisis

Notable noise zones:

- **Autopista Regional del Centro** Caracas ↔ Valencia
- **Autopista Francisco Fajardo** Caracas bypass
- **Troncal 1** Valencia ↔ Barquisimeto ↔ Maracaibo
- **Metro de Caracas Lines 1-5** — partly underground, partly elevated
- **Sistema Ferroviario Ezequiel Zamora** (Caracas↔Cúa commuter rail)
- **Ferrominera Orinoco iron ore corridor** (Ciudad Piar↔Puerto Ordaz, 320 km heavy freight)
- **Simón Bolívar (CCS/SVMI Caracas)**, **La Chinita (MAR/SVMC Maracaibo)**, **Arturo Michelena (VLN/SVVA Valencia)**, **Jacinto Lara (BRM/SVBM Barquisimeto)**, **Manuel Carlos Piar (PZO/SVPR Puerto Ordaz)**, **General José Antonio Anzoátegui (BLA/SVBC Barcelona)** — covered by global aircraft layer
- **Guri Dam / Simón Bolívar Hydroelectric** (Bolívar state, 10,200 MW) — one of world's largest hydro plants
- **Macagua** (3,140 MW) + **Caruachi** (2,280 MW) — Caroní cascade
- **Paraguaná Refining Center (Amuay + Cardón + Bajo Grande)** — historically world's largest refinery
- **El Palito refinery** (Puerto Cabello)
- **Puerto La Cruz refinery**
- **Ciudad Guayana industrial complex**: **SIDOR steel** + **Alcasa aluminum** + **Venalum aluminum** + **Ferrominera Orinoco iron ore loading**
- **Faja del Orinoco oil belt**: 20,714 wells scattered across the Orinoco valley, extra-heavy crude extraction
- **Lake Maracaibo oil fields** — legacy Maracaibo basin traditional crude
