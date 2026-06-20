---
title: Zambia
intro: Noise mapping data sources for Zambia.
map: { center: [27, -14], zoom: 6 }
---

## Road traffic

### Road defaults

Zambia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Zambia's traffic factor **≈ 0.957** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.957 ≈ 28,710 |
| Trunk | 15,000 × 0.957 ≈ 14,355 |
| Primary | 9,000 × 0.957 ≈ 8,613 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **T1** — Lusaka ↔ Kabwe ↔ Kapiri Mposhi ↔ Ndola ↔ Kitwe ↔ Chingola ↔ Chililabombwe ↔ Kasumbalesa (DRC border)
- **T2 Great North Road** — Lusaka ↔ Kapiri Mposhi ↔ Serenje ↔ Mpika ↔ Kasama ↔ Nakonde (Tanzania border) — parallel to TAZARA, **Zambia's main copper export artery**
- **T3** — Lusaka ↔ Chirundu (Zimbabwe border south)
- **T4** — Lusaka ↔ Chipata ↔ Mchinji (Malawi border east)
- **T5** — Kafue ↔ Livingstone (Vic Falls south)
- **T8** — Kapiri Mposhi ↔ Solwezi ↔ Mwinilunga (NW mining province)
- **M10** — Lusaka ↔ Mongu (west, Barotse Plain)

## Railway

### Zambian rail context

Zambia has **two separate rail networks**:

### Zambia Railways Limited (ZRL) — meter gauge historic
- **Livingstone ↔ Kalomo ↔ Choma ↔ Lusaka ↔ Kabwe ↔ Kapiri Mposhi ↔ Ndola ↔ Kitwe ↔ Chingola ↔ Chililabombwe** (Copperbelt)
- Built 1905-1909 by Rhodesia Railways
- **Copperbelt backbone** — most traffic is copper from KCM/Mopani/FQM
- Cape gauge
- Cross-border: Livingstone ↔ Victoria Falls Bridge ↔ Zimbabwe (NRZ)
- Partial passenger service Lusaka ↔ Livingstone

### TAZARA (Tanzania-Zambia Railway Authority)
- **1,860 km Kapiri Mposhi ↔ Tunduma ↔ Dar es Salaam (Tanzania)**
- **Built 1970-1975 by China** at peak of Cold War diplomacy — **one of Africa's most famous Chinese aid projects** (50,000+ Chinese workers + tens of thousands of Tanzanians/Zambians)
- **Purpose**: export Zambian Copperbelt copper/cobalt to Dar es Salaam port, **avoiding white-ruled Rhodesia/RSA routes during sanctions era**
- **ZM section**: Kapiri Mposhi ↔ Serenje ↔ Mpika ↔ Kasama ↔ Nakonde ↔ Tunduma (Tanzania border)
- Cape gauge
- Still operating, heavily subsidized (declining traffic vs truck competition + parallel Angola Lobito Corridor)

### Njanji Commuter
- Small Lusaka commuter rail, currently defunct

**No metros, no trams** in any Zambian city.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 82 plants, 15 operating, ~4.76 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Zambia'`

**Operating fuel**: hydropower 5 + solar 5 + coal 3 + bioenergy 1 + oil/gas 1.

**Zambia is hydro-dominated** — Kafue River cascade + Kariba North form the backbone (~3.87 GW from hydro, 81% of capacity).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Kariba Dam** | **2,130** | hydropower | **Zambezi at Kariba** (GEM lists whole dam under Zambia — Kariba North Bank Power Station, upgraded 2014 from 720 to 1,080 MW by Sinohydro). **World's largest dam when built 1959**. Shared with Zimbabwe/Kariba South. **Severely drought-constrained 2022-2024** — major load shedding trigger |
| **Kafue Gorge Upper** | 990 | hydropower | Kafue River, 1971 — **Zambia's second-largest hydro**, ZESCO-owned |
| **Kafue Gorge Lower** | **750** | hydropower | Kafue River, **opened 2024** — Zambia's newest major hydro, Sinohydro-built, downstream of Upper |
| **Maamba Coal** | 300 (2× 150) | coal | **Zambia's only coal plant**, SE Zambia at Maamba Collieries (2016) |
| **Itezhi-Tezhi** | 120 | hydropower | Kafue River regulator dam, 2016 |
| **Victoria Falls Power Station** | 108 | hydropower | Colonial-era 3 plants (Vic Falls A+B+C) |
| **Ndola Energy HFO** | 105 | oil/gas | Copperbelt emergency thermal (heavy fuel oil) |
| **Itimpi Solar** | 64 | solar | Copperbelt |
| **Bangweulu Solar** | 54 | solar | |
| **Nakambala** | 40 | bioenergy | **Sugarcane bagasse cogeneration** — Zambia Sugar Mazabuka |
| **Ngonye Solar** | 34 | solar | |
| **Riverside Solar** | 33 | solar | |
| **Ndola Cement Plant** | 30 | coal | Captive for cement |

**Total operating: ~4,759 MW**.

**Kariba drought crisis**: The Kariba Dam reservoir level has been critically low since 2022, reducing both Kariba North (Zambia) and Kariba South (Zimbabwe) output. This has triggered severe load shedding across Zambia 2022-2024.

All operating plants map to **NACE 35**.

### Zambia does NOT have

- **No RDA AADT** — zero open traffic data
- **No ZRL or TAZARA GTFS**
- **Copperbelt mines** all generic OSM industrial (should be NACE 07):
  - **Konkola Copper Mines (KCM)** — Chingola/Chililabombwe, Vedanta (struggling, state dispute 2019+)
  - **Mopani Copper Mines** — Mufulira/Kitwe (formerly Glencore, now ZCCM-IH majority state after 2021 sale)
  - **First Quantum Minerals (FQM)** — **Kansanshi (Solwezi)** + **Sentinel (Kalumbila)**. **Kansanshi is Africa's largest copper mine by production**
  - **Barrick Lumwana** — Solwezi NW open-pit copper
- **Copper refineries**: Nkana (Kitwe), Ndola Copper, Mufulira Smelter (Mopani), Nchanga Smelter (KCM) — not NACE 24
- **Kagem Emerald Mine** (Lufwanyama) — **world's largest emerald mine**, Gemfields operated (75% state), not NACE 08
- **Kafue Steel** not NACE 24
- **Cement plants not NACE 23**: Lafarge Zambia (Chilanga), Dangote Cement (Masaiti), Mpande
- **INDENI Petroleum Refinery** (Ndola) — **closed 2019**, converted to fuel storage
- **Manganese** (Serenje), **Kabwe lead/zinc mine** (historic, closed, major pollution legacy)

## Validation

Zambia implements environmental protection via:

- **ZEMA** (Zambia Environmental Management Agency)
- **Environmental Management Act 2011**
- **Environmental Protection and Pollution Control (Air Pollution Control) Regulations 1996**
- Typical limits: residential 60/50 dBA day/night, commercial 70/60, industrial 75/65

Notable noise zones:

- **T2 Great North Road** (Lusaka↔Kapiri Mposhi↔Copperbelt↔Tunduma) — main copper export artery
- **T1 Copperbelt corridor** (Lusaka↔Kitwe↔Chililabombwe↔DRC)
- **T3 Lusaka↔Chirundu** (Zimbabwe freight)
- **Lusaka + Kitwe + Ndola** dense urban cores
- **Copperbelt mines** cluster (Chingola/Mufulira/Chililabombwe/Luanshya/Kitwe)
- **ZRL Copperbelt mainline**
- **TAZARA ZM section** (Kapiri Mposhi ↔ Nakonde/Tunduma)
- **Kenneth Kaunda International (LUN/FLKK Lusaka)**, **Simon Mwansa Kapwepwe (NLA/FLSK Ndola)**, **Harry Mwanga Nkumbula (LVI/FLLI Livingstone)**, **Kasama (ZKP/FLKS)**, **Solwezi (SLI/FLSW)**, **Mfuwe (MFU/FLMF — South Luangwa)** — covered by global aircraft layer
- **Kariba North Bank Power Station** (1,080 MW upgraded, Zambezi)
- **Kafue Gorge Upper + Lower + Itezhi-Tezhi** (Kafue River cascade = ~1,860 MW)
- **Maamba Coal Power Plant** (Zambia's only coal, 300 MW)
- **Victoria Falls Power Station** (colonial, 108 MW)
- **Ndola Energy HFO thermal**
- **Konkola Copper Mines** + **Mopani** + **FQM Kansanshi + Sentinel** + **Barrick Lumwana** (Copperbelt cluster)
- **Kagem Emerald Mine** (Lufwanyama — world's largest)
- **Nakambala Sugar** (Mazabuka, bagasse cogen)
- **INDENI Refinery Ndola** (closed 2019, now storage)
- **Kabwe historic mine** (major lead pollution legacy)
