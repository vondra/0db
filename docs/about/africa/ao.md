---
title: Angola
intro: Noise mapping data sources for Angola.
map: { center: [17, -12], zoom: 5 }
---

## Road traffic

### Road defaults

Angola publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Angola's traffic factor **≈ 0.763** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.763 ≈ 22,890 |
| Trunk | 15,000 × 0.763 ≈ 11,445 |
| Primary | 9,000 × 0.763 ≈ 6,867 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **EN100** — coastal highway (Luanda ↔ Porto Amboim ↔ Lobito ↔ Benguela ↔ Namibe) — main coastal artery
- **EN230** — Luanda ↔ Ndalatando ↔ Malanje (central east, parallel to CFL railway)
- **EN140** — Luanda ↔ Kuito ↔ Luena (central trans-country)
- **EN280** — Lubango ↔ Namibe (south)
- **EN110** — Huambo ↔ Kuito (central plateau)
- **Via Expressa Luanda** + **EN1 Luanda-Viana** — Luanda urban motorway

## Railway

### Angolan rail context

Angola has **3 historic Portuguese colonial railways** built 1888-1929, all destroyed during the 1975-2002 civil war and rehabilitated 2005-2015 with Chinese finance. Total rehabilitated length ~2,730 km — one of Africa's more extensive rail networks.

### CFB (Caminhos de Ferro de Benguela) — Benguela Railway / Lobito Corridor
- **1,344 km**, Lobito/Benguela ↔ Cubal ↔ Huambo ↔ Luena ↔ Luau (DRC border)
- Built 1903-1929 by Tanganyika Concessions (Robert Williams)
- **Historically the most important trans-Africa railway** — continued via DRC National Railway to Zambia Copperbelt
- **Destroyed in civil war, rehabilitated 2005-2014** by China Railway
- **Reopened 2014, full service 2015**
- Now carries copper/cobalt from DRC Katanga + Zambia Copperbelt to Lobito port
- **"Lobito Corridor"** — strategic priority for US (Biden 2023 plan) and EU as alternative to Chinese-built TAZARA and Kinshasa-Matadi routes. **Africa's most geopolitically important rail project of the 2020s**
- Cape gauge (1,067 mm)

### CFL (Caminhos de Ferro de Luanda) — Luanda Railway
- **479 km**, Luanda ↔ Viana ↔ Ndalatando ↔ Malanje (central-eastern Angola)
- Rehabilitated, includes **Luanda commuter rail** (electrified suburban service from Luanda station to Viana / Cacuaco)
- Cape gauge

### CFM (Caminhos de Ferro de Moçâmedes / Namibe) — Namibe Railway
- **907 km**, Namibe ↔ Lubango ↔ Menongue (southern Angola)
- Rehabilitated, carries iron ore from Cassinga
- Cape gauge

**No metros, no trams** in any Angolan city (Luanda Metro announced 2012, never built).

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 76 plants, 26 operating, ~5.1 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Angola'`

**Operating fuel**: solar 14 + hydropower 6 + oil/gas 4 + bioenergy 1 + wind 1. **Angola has a hydro-dominated grid** — unusual for Africa (most countries are gas or coal dominated). The **Kwanza River cascade provides the backbone**.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Laúca** | **2,070** | hydropower | **Kwanza River, opened 2017** — **one of Africa's largest hydropower plants**, Angola's largest single plant |
| **Cambambe II** | 700 | hydropower | Kwanza River, 2017 modernization |
| **Soyo** | **720** (2× 360) | oil/gas CCGT | Zaire province — Angola's main gas plant, fed by Congo Basin gas (near Angola LNG facility) |
| **Capanda** | 520 | hydropower | Kwanza River, 2004 |
| **Biópio Solar** | 189 | solar | Benguela — **Angola's largest utility solar farm** |
| **Cambambe I** | 260 | hydropower | Kwanza River, **1963 — Angola's oldest major hydro** (4× 65 MW after 2016 rehab) |
| **CFL power station** | 125 | oil/gas | Luanda railway depot |
| **Biocom bioenergy** | 100 | bioenergy | Malanje — sugarcane bagasse cogeneration at Biocom sugar-ethanol complex |
| Benguela Solar | 97 | solar | |
| Baía Farta Solar | 96 | solar | |
| Quileva | 84 | oil/gas | |
| **Gove Dam** | 60 | hydropower | Huambo province |
| **Morro do Ouro Wind** | 50 | wind | Tombwa, Namibe — **Angola's first wind farm** |
| Lomaúm | 50 | hydropower | |

**Total operating: ~5,220 MW**.

**Under construction (not counted)**: **Caculo Cabaça 2,172 MW** — Kwanza River, under construction since 2018. When complete will be **Angola's largest power plant**, overtaking Laúca.

All operating plants map to **NACE 35**.

### Angola does NOT have

- **No INEA AADT** — zero open traffic data
- **No CFB/CFL/CFM GTFS** — all timetables corporate HTML only
- **Sonangol upstream + downstream** all generic OSM industrial (should be NACE 06/19/20):
  - **Offshore oil fields** (~1.1 Mbbl/day — **sub-Saharan Africa's 2nd largest oil producer after Nigeria** (~3rd in Africa behind Nigeria and Libya), OPEC member until its exit took effect January 2024): Kizomba, Plutonio, CLOV, Dalia, Girassol, Pazflor (deep-water Atlantic, Blocks 15/17/18)
  - **Luanda Refinery** (~65k bpd, old)
  - **Lobito Refinery** — under construction, new 200k bpd
  - **Angola LNG Soyo** — opened 2013, Chevron/Sonangol/BP/ENI/TotalEnergies
  - **Cabinda enclave** offshore operations (Malongo terminal, Cabinda Gulf Oil)
- **Catoca Diamond Mine** (Lunda Sul) not NACE 08 — among the world's largest diamond mines by area (Endiama + Oman's Taadeen since Alrosa's 2025 divestment)
- **Iron ore Cassinga** (historic, being reopened) not NACE 07
- **Cement plants not NACE 23**: Nova Cimangola (Luanda), Ciment de Lobito, Empresa de Cimentos de Angola
- **Ports**: Luanda (Africa's busiest lusophone port), **Lobito (Lobito Corridor terminus — fastest-growing port in Africa 2023-2024)**, Namibe, Cabinda
- **Biocom sugar-ethanol** (Malanje) — integrated complex

## Validation

Angola implements environmental protection via:

- **MCTA** (Ministério da Cultura, Turismo e Ambiente) — Ambiente section
- **Lei n.º 5/98** — Lei de Bases do Ambiente (environmental framework law)
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Via Expressa Luanda** + **EN1 Luanda-Viana** — Luanda urban motorway
- **EN100 coastal highway** — Luanda ↔ Lobito ↔ Namibe
- **Luanda Centro + Ilha do Cabo + Maianga + Sambizanga** — dense urban core (extreme density on narrow Atlantic peninsula)
- **CFB Lobito Corridor** (copper/cobalt trans-Africa rail)
- **CFL Luanda commuter + mainline**
- **CFM Namibe-Menongue** (iron ore)
- **Luanda Quatro de Fevereiro (LAD/FNLU)**, **Lubango (SDD/FNUB)**, **Huambo (NOV/FNHU)**, **Catumbela (CBT/FNCT Benguela)**, **Namibe (MSZ/FNMO)**, **Cabinda (CAB/FNCA)**, **Menongue (SPP/FNME)**, **Saurimo (VHC/FNSA)** — covered by global aircraft layer
- **Laúca 2,070 MW** (Kwanza River) — one of Africa's largest hydropower plants
- **Cambambe I+II + Capanda** (Kwanza River hydro cascade = ~1,480 MW)
- **Soyo CCGT 720 MW** + **Angola LNG Soyo** (Zaire province gas complex)
- **Biópio Solar 189 MW** (Benguela)
- **Biocom sugar-ethanol Malanje** (bagasse cogeneration)
- **Luanda Refinery**
- **Catoca Diamond Mine** (Saurimo, Lunda Sul)
- **Morro do Ouro Wind** (Tombwa, Namibe — Angola's first wind farm)
- **Ports**: Luanda, Lobito, Namibe, Cabinda
- **Cabinda enclave**: Malongo oil terminal
