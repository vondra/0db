---
title: Argentina
intro: Noise mapping data sources for Argentina.
map: { center: [-64, -38], zoom: 4 }
---

## Road traffic

### IGN GeoServer + DNV TMDA 2017-18 (real AADT)

Argentina is one of the very few non-EU countries in this pipeline with **publicly available per-segment AADT measurements**. The DNV (Dirección Nacional de Vialidad) operated a national traffic census whose 2017-18 results are exposed as a GeoServer WFS layer at IDE Transporte (`ide.transporte.gob.ar/geoserver/observ/ows`). Although the vintage is stale, relative volumes between corridors are still informative for noise modeling.

- **Source 1 — Road network**: IGN GeoServer (Instituto Geográfico Nacional)
  - URL: `https://wms.ign.gob.ar/geoserver/transporte/ows`
  - Layers: `transporte:vial_nacional` (2,723 RN routes) + `transporte:vial_provincial` (12,936 RP routes)
  - Authority: DNV via IGN
  - Fields: `tipo_de_via_de_transporte` (Ruta/Autopista/Autovía), `tipo_de_superficie_de_via` (Pavimentado/Consolidado/Tierra), `designacion_de_red_vial`
- **Source 2 — TMDA traffic counts**: IDE Transporte
  - URL: `https://ide.transporte.gob.ar/geoserver/observ/ows`
  - Layer: `observ:_3.4.1.4.1.tmda_17_18_view` — **1,234 line segments with REAL AADT** (`valor`/`tmda17` fields)
  - Vintage: 2017-18 (DNV publishes annual TMDA but newer years are not exposed via WFS)
  - Stats: min=10, median=3,450, mean=10,511, max=264,600 vehicles/day

Argentina's "open ArcGIS" equivalent is **IGN GeoServer** (not ArcGIS Online) — same role, different platform.

### AADT defaults (fallback when no TMDA match)

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (autopista) | 45,000 | 90,000 | 63,000 |
| 1 trunk (RN paved) | 18,000 | 36,000 | 25,200 |
| 2 primary | 9,000 | 18,000 | 12,600 |
| 3 secondary | 4,000 | 8,000 | 5,600 |
| 4 tertiary | 1,800 | 3,600 | 2,520 |
| 5 residential | 800 | 1,600 | 1,120 |

### DNV spatial-match AADT (by surface + type)

| DNV combination | AADT (rural) |
|---|---:|
| Pavimentado + Autopista/Autovía | 30,000 |
| Pavimentado + Ruta (national RN) | 18,000 |
| Pavimentado + Ruta (provincial RP) | 12,000 |
| Consolidado / Tierra | 3,000 |

**Tier-1 metros** (×2.0): **Buenos Aires** (Gran Buenos Aires including La Plata), **Córdoba**.

**Tier-2 cities** (×1.4, 22 cities): Rosario, Mendoza, San Miguel de Tucumán, La Plata, Mar del Plata, Salta, Santa Fe, San Juan, Resistencia, Neuquén, Bahía Blanca, Posadas, Corrientes, Paraná, Santiago del Estero, San Salvador de Jujuy, Río Cuarto, Comodoro Rivadavia, San Luis, La Rioja, Catamarca, Formosa.

### Argentine vehicle split

Argentina has a **low motorcycle share** (~5% urban, ~3% rural — much lower than Brazil's already-low 5%) and a **very high heavy-vehicle share** on Pampas grain corridors and Patagonian oil/gas routes.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Buenos Aires/Córdoba) | 75% | 10% | 10% | 5% |
| Tier-2 | 73% | 10% | 12% | 5% |
| Rural | 60% | 10% | **27%** | 3% |

### National route network (RN — Rutas Nacionales)

Argentina's federal RN network is one of the longest in Latin America:

- **RN 3** Buenos Aires ↔ Tierra del Fuego (3,079 km — the southernmost national highway in the world, ends at Ushuaia)
- **RN 9** Buenos Aires ↔ Bolivia border (Pan-American Highway segment, La Quiaca)
- **RN 7** Buenos Aires ↔ Chile border at Cristo Redentor pass (Mendoza Andes)
- **RN 14** Mesopotamian corridor along Río Uruguay (Concordia, Paso de los Libres)
- **RN 40** the longest in Argentina — Cabo Vírgenes ↔ La Quiaca (5,194 km along the Andes foothills)
- **RN 12** Iguazú ↔ Buenos Aires via Posadas/Paraná
- **RN 22** Bahía Blanca ↔ Patagonia gas/oil corridor (Cipolletti, Neuquén, Zapala)
- **RN 38** Córdoba ↔ Tucumán via traditional Quebrada de la Concepción
- **RN 11** Rosario ↔ Resistencia (Pampas grain corridor)

## Railway

### IGN GeoServer railway lines

- **Source**: `https://wms.ign.gob.ar/geoserver/transporte/ows`
- **Layer**: `transporte:lineas_de_transporte_ferroviario_AN010`
- **Records**: 1,092 polyline segments
  - **691 Activo** (operational — only these enriched)
  - 268 Abandonado (skipped)
  - 133 Desmantelado (skipped)
- **Fields**: `nombre_geografico`, `estado`, `trocha` (gauge: Ancha 1676mm / Angosta 1000mm / Media 1435mm), `fuente_de_captura` (IGN/Trenes Argentinos Cargas)

### Buenos Aires Subte (no fresh GTFS)

- **SBASE Subte** (`buenosaires.gob.ar/subte`) — 6 metro lines (A/B/C/D/E/H) + 2 Premetro lines (Civico/Savio). Only a 2019 frequency-based GTFS feed is available, **missing the link tables** (`stops.txt`/`trips.txt`/`stop_times.txt`) needed for stop-pair train counting. We apply geographic Subte boost via the Buenos Aires bbox + OSM `railway=subway` tag instead.

### Trenes Argentinos commuter networks (Sofse)

The largest commuter rail system in South America, operated by Trenes Argentinos Operaciones Ferroviarias under Sofse:

- **Línea Mitre** — Retiro ↔ Tigre/José León Suárez/Bartolomé Mitre
- **Línea Sarmiento** — Once ↔ Moreno (extension to Mercedes)
- **Línea Roca** — Constitución ↔ La Plata/Ezeiza/Glew
- **Línea San Martín** — Retiro ↔ Pilar
- **Línea Belgrano Norte** — Retiro ↔ Villa Rosa
- **Línea Belgrano Sur** — Buenos Aires ↔ González Catán/M. Castillo
- **Línea Urquiza** — Federico Lacroze ↔ Lemos/General Lemos

### Long-distance passenger (very limited)

- **Buenos Aires ↔ Mar del Plata** (daily, ~6 hours)
- **Buenos Aires ↔ Bariloche** ("La Trochita" — narrow gauge tourist train)
- **Buenos Aires ↔ Posadas, Tucumán** (irregular, weekly)
- **Tren del Valle** (Cipolletti ↔ Neuquén) — single-line commuter

### Freight (Trenes Argentinos Cargas)

- **Belgrano Cargas** — NW grain corridor: Salta/Jujuy/Tucumán/Santiago del Estero ↔ Rosario port (1,000 km, narrow gauge)
- **Mitre Cargas** — Buenos Aires ↔ Tucumán/Santa Fe (broad gauge)
- **San Martín Cargas** — Buenos Aires ↔ Mendoza/Cuyo

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| Buenos Aires commuter (Trenes Argentinos networks) | 200 | 15 |
| Córdoba/Rosario/Mendoza commuter | 30 | 10 |
| **Belgrano Cargas freight corridor (NOA)** | 1 | 18 |
| Other operational rural | 1 | 8 |
| Branch lines | 1 | 4 |
| **Subte BA (light_rail — A/B/C/D/E/H)** | 280 | 0 |
| Premetro BA (tram) | 200 | 0 |
| Non-operational rail (IGN `estado != Activo`) | 0 | 0 (skip) |

## Buildings

GHSL Built-H R2023A 100 m + Overture Maps Foundation global footprints. Microsoft contributed Argentine building footprints in their 2023-2024 release. No Argentine cadastre downloaded (IDERA's national cadastre is provincial-only).

## Industrial

### GEM Global Integrated Power — 393 AR plants, 263 operating

Argentina has **no SIGACONTROL/CAMMESA equivalent** ArcGIS layer for facility geometry — CAMMESA only publishes spot prices and energy balances; ENRE only regulates distribution. GEM is the only consistent GPS+capacity+fuel source.

- **Source**: GEM Global Integrated Power v1
- **URL**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Argentina'`
- **Records**: 393 plants, **263 operating** (224 inside AR bbox after exclusion zones)

### Operating fleet

| Fuel | Plants | Notable facilities |
|---|---:|---|
| **oil/gas** | 83 | Centrales Costanera (BA), Loma de la Lata (Neuquén), Brigadier López (Santa Fe), Genelba, Manuel Belgrano, Vuelta de Obligado, AES Paraná, Pilar |
| **wind** | 74 | Patagonia: Manantiales Behr, Loma Blanca, Aluar (Puerto Madryn), Arauco; coastal Buenos Aires (Necochea, Tres Arroyos); La Pampa |
| **solar** | 48 | **Cauchari Jujuy 300 MW** (largest in South America when commissioned 2020), La Puna, San Juan |
| **hydropower** | 14 | **Yacyretá 3.1 GW** (binacional with Paraguay), **Salto Grande 1.89 GW** (binacional with Uruguay), **Piedra del Águila 1.42 GW**, **Chocón 1.2 GW**, **Alicurá 1.04 GW**, Futaleufú, Cabra Corral |
| **nuclear** | 3 | **Atucha I** (362 MW, Lima/BA), **Atucha II** (745 MW), **Embalse** (648 MW CANDU heavy-water in Córdoba) |
| **bioenergy** | 1 | Sugarcane bagasse cogeneration (Tucumán region) |
| **coal** | 1 | Río Turbio mine-mouth power plant in Santa Cruz province |

All operating plants map to **NACE 35** (Electricity generation).

### Argentina does NOT have

- **No SIGACONTROL equivalent** — Brazil's ANEEL publishes 11,182 individual wind turbines via ArcGIS Online (`sigacontrol`); Argentina has no per-turbine registry
- **No DNV TMDA 2019-2024 in WFS** — only the 2017-18 vintage is exposed; newer reports are PDF only
- **No fresh Buenos Aires Subte GTFS** — only 2019 frequency-based feed without link tables
- **No nuclear evacuation perimeters** — Atucha I/II and Embalse are tagged as point plants

## Validation

Argentina implements noise regulation via:

- **Ministerio de Ambiente y Desarrollo Sostenible** at [argentina.gob.ar/ambiente](https://www.argentina.gob.ar/ambiente)
- **Ley Nacional 23.778** ratifying noise regulations + provincial enforcement (Buenos Aires Resolución 159/2007, CABA Ley 1.540 "Ley de Control de la Contaminación Acústica")
- **IRAM 4062** noise standard (industrial)
- **CABA Agencia de Protección Ambiental (APRA)** — Buenos Aires city noise enforcement

Notable noise zones:

- **Avenida General Paz** (Buenos Aires Ring Road, 24 km) — ~200,000 AADT in peak segments
- **Autopista Buenos Aires-La Plata** (RN 1, 60 km) — major commuter artery
- **Autopista Acceso Norte / Acceso Oeste** (Pan-American + RN 5/RN 7 access)
- **Avenida 9 de Julio** (BA — claims to be the widest avenue in the world, 110m / 16 lanes)
- **RN 9 Pan-American corridor** Buenos Aires ↔ Rosario ↔ Córdoba ↔ Tucumán ↔ La Quiaca
- **RN 14 Mesopotámica** along Río Uruguay (Concordia, Paso de los Libres border)
- **Subte BA** — 6 underground lines mostly tunneled, some elevated sections (Línea E)
- **Ezeiza (EZE / SAEZ)**, **Aeroparque (AEP / SABE)**, **Córdoba (COR / SACO)**, **Mendoza (MDZ / SAME)**, **Bariloche (BRC / SAZS)**, **Iguazú (IGR / SARI)** — covered by global aircraft layer
- **Yacyretá Hydroelectric Dam** (Corrientes province, 3.1 GW) — Argentina's largest power plant
- **Loma de la Lata gas field** (Neuquén) — Vaca Muerta unconventional gas/oil hub
- **Atucha I/II nuclear complex** (Zárate, Buenos Aires province)
- **Cauchari Solar Park** (Jujuy, 300 MW) — largest solar plant in South America when commissioned
- **Patagonian wind corridor** — Comodoro Rivadavia, Madryn, Trelew (~5 GW operational)
- **Belgrano Cargas freight corridor** — major grain freight from NOA to Rosario port complex
