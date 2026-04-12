---
title: Zimbabwe
intro: Noise mapping data sources for Zimbabwe.
map: { center: [30, -19], zoom: 6 }
---

## Road traffic

### Class defaults only

ZINARA (Zimbabwe National Road Administration) publishes no open GIS. Fall back to CNOSSOS class defaults with Greater Harare Tier-1 boost.

### Zimbabwean AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A4 Harare-Beitbridge upgrade in progress) | 24,000 | 48,000 | 33,600 |
| 1 trunk (A1-A9) | 9,000 | 18,000 | 12,600 |
| 2 primary | 4,500 | 9,000 | 6,300 |
| 3 secondary | 2,200 | 4,400 | 3,080 |
| 4 tertiary | 1,000 | 2,000 | 1,400 |
| 5 residential | 500 | 1,000 | 700 |

**Tier-1 metros** (×2.0, 1 metro): **Greater Harare** (~2.5M metro — capital, built on the north-central Mashonaland plateau).

**Tier-2 cities** (×1.4, 20 cities): **Bulawayo** (2nd city, Matabeleland capital), Chitungwiza (Harare satellite), **Mutare** (Manicaland, Mozambique border), Gweru (Midlands), **Kwekwe** (**ZISCO Redcliff** site — defunct steel), Kadoma, Masvingo (**Great Zimbabwe ruins**), Chinhoyi, Marondera, Ruwa, Norton, Bindura (nickel mine), Chegutu, **Zvishavane** (**Mimosa platinum mine**), **Victoria Falls** (tourism, Zambia border), **Hwange** (coalfield), **Beitbridge** (RSA border, Limpopo crossing), **Shurugwi** (**Unki platinum mine**), **Bikita** (**world's oldest and largest lithium mine** since 1953), Gwanda (**Blanket gold mine**).

### Zimbabwean vehicle split

Zimbabwe's urban transport centers on **kombis** + ZUPCO buses:

- **Kombis** — white Toyota HiAce / Nissan Urvan minibus taxis (16-seater), dominant urban public transport (similar to matatus but with smaller fleet size than Kenya/Uganda)
- **ZUPCO** — state bus company (Zimbabwe United Passenger Company), revived 2018 post-dollarization. Large blue buses
- **Emergency Taxis / Mushika Shika** — unlicensed sedan taxis
- **Motorcycle taxis** — **lower share than East Africa** (no boda-boda culture, import constraints)
- **Heavy trucks**: Cross-border Botswana/RSA/Mozambique freight, mining haul (Zimplats platinum, Hwange coal, Bikita lithium)

| Tier | Light | Medium (kombi) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Harare) | 60% | **18%** | 13% | 9% |
| Tier-2 | 60% | 13% | 18% | 9% |
| Rural | 55% | 8% | 30% | 7% |
| **A4 Harare↔Beitbridge (RSA freight)** | 50% | 5% | **42%** | 3% |
| **Hwange coal corridor** | 40% | 5% | **52%** | 3% |

### National route network

- **A1** — Harare ↔ Chirundu (Zambia border north)
- **A2** — Harare ↔ Mutare (Mozambique border east, parallel to NRZ Beira Corridor)
- **A3** — Harare ↔ Nyamapanda (Mozambique border NE)
- **A4** — Harare ↔ Masvingo ↔ Beitbridge (South Africa border south — **main RSA freight artery**)
- **A5** — Harare ↔ Kariba (Zambezi)
- **A6** — Bulawayo ↔ Plumtree (Botswana border)
- **A7** — Gweru ↔ Kwekwe ↔ Kadoma ↔ Harare
- **A8** — Bulawayo ↔ Victoria Falls (Zambia border NW)
- **A9** — Bulawayo ↔ Beitbridge (via Gwanda)

## Railway

### Class defaults + corridor bbox boosts

### Zimbabwean rail context

Zimbabwe has one of Southern Africa's better rail networks — **NRZ (National Railways of Zimbabwe) operates ~2,760 km** of cape-gauge (1,067 mm) track, built by Rhodesia Railways 1893-1960 for mining exports. Heavy service decline post-2000 with economic collapse, partial revival 2018+.

### Main trunk
- **Plumtree ↔ Bulawayo ↔ Gweru ↔ Harare ↔ Mutare** — the Zimbabwean rail backbone, built 1897-1902. Connects Botswana (Plumtree) to Mozambique (Mutare ↔ Beira Corridor). Historically a key Rhodesian export corridor during UDI sanctions era.

### Victoria Falls branch (Hwange coal)
- **Bulawayo ↔ Dete ↔ Hwange ↔ Victoria Falls** — **Hwange coal export line**, crosses to Zambia via historic **Victoria Falls Bridge** (1905, Cecil Rhodes).

### Beitbridge branch (South Africa link)
- **Bulawayo ↔ West Nicholson ↔ Beitbridge** (South Africa border). Connects to South Africa via Musina/Transnet. **2nd link to South Africa** after the Plumtree↔Botswana route.

### Harare-Chirundu (Zambia link)
- **Harare ↔ Makuti ↔ Chirundu** — partially operational

### Other branches
- **Harare ↔ Bindura ↔ Shamva** (Bindura nickel mining)
- **Gweru ↔ Masvingo ↔ Chipinge** (SE Lowveld sugar)
- **Kwekwe ↔ Redcliff** (ZISCO iron — historically major)
- **Bikita lithium branch**

### Harare commuter rail
- Limited/irregular service (post-2000 decline)

**No metros, no trams** in any Zimbabwean city.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Harare commuter rail** (irregular) | 4 | 0 |
| **Main trunk** (Plumtree↔Bulawayo↔Harare↔Mutare) | 1 | 8 |
| **Vic Falls branch** (Hwange coal + Vic Falls border) | 0 | 10 |
| **Beitbridge branch** (Bulawayo↔RSA) | 0 | 6 |
| **Chirundu branch** (Harare↔Zambia) | 0 | 3 |
| Other/branch | 0 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 188 plants, 34 operating, ~2.96 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Zimbabwe'` (supplemented with **Kariba South** — GEM lists Kariba Dam under Zambia only)

**Operating fuel**: solar 18 + coal 10 + bioenergy 2 + hydropower 1.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Kariba South Power Station** | **1,050** | hydropower | **Zambezi River at Kariba Dam** — Zimbabwe's largest, shared with Zambia/Kariba North on opposite bank. **Kariba was world's largest dam when built 1959**. Combined Kariba Dam capacity = 2,130 MW. Supply severely constrained by drought 2022-2024 — major load shedding trigger. |
| **Hwange Thermal** | **1,590 total** | coal | 8 units (2×335 + 2×220 + 4×120 MW) — **Zimbabwe's main coal plant**, Hwange coalfield. Sinohydro Units 7+8 added 600 MW 2023 |
| **ZhongXin** | 50 | coal | Hwange IPP |
| **Hippo Valley Estate** | 39 | bioenergy | **Sugarcane bagasse cogeneration**, Lowveld |
| **Triangle** | 35 | bioenergy | **Sugarcane bagasse cogeneration**, Lowveld |
| **Harare Thermal** | 30 | coal | Small urban plant |
| **Vungu Solar + Nyabira Solar** | 55 | solar | |
| **16× small solar plants** | ~140 total | solar | 5-30 MW each |

**Total operating: ~2,956 MW**.

**Kariba drought crisis**: The Kariba Dam reservoir level has been critically low since 2022 due to sustained drought in the Zambezi catchment, reducing both Kariba North (Zambia) and Kariba South (Zimbabwe) output. This has triggered severe load shedding across Zimbabwe 2022-2024.

All operating plants map to **NACE 35**.

### Zimbabwe does NOT have

- **No ZINARA AADT** — zero open traffic data
- **No NRZ GTFS**
- **Zimplats platinum mine** (Ngezi/Selous) not NACE 07 — **world's #3 platinum reserves area** (Great Dyke, Implats subsidiary)
- **Unki Mine** (Shurugwi, Anglo American Platinum) + **Mimosa Mine** (Zvishavane, Sibanye-Stillwater + Implats JV) not NACE 07
- **Bikita Minerals** (Bikita) not NACE 08 — **world's oldest and largest lithium mine**, operating since 1953, being expanded by Sinomine post-2022 lithium boom
- **Arcadia Lithium** (Goromonzi, Harare area) — Prospect Resources → Huayou Cobalt 2022
- **ZISCO (Zimbabwe Iron and Steel Company)** (Redcliff, Kwekwe) not NACE 24 — historically Africa's largest integrated steel mill, **defunct since ~2008 economic collapse**, revival under discussion
- **Hwange Colliery** not NACE 05 — Zimbabwe's only major coal mine
- **Gold mines**: Freda Rebecca (Bindura), Blanket (Gwanda), How Mine (Bulawayo), Mazowe
- **Marange Diamonds** (controversial, MMCZ/ZCDC)
- **Chisumbanje Bio-ethanol** (Green Fuel, sugarcane) — Lowveld
- **Tobacco processing**: Kutsaga + numerous Mashonaland tobacco belt
- **Hippo Valley + Triangle sugar estates** (only power stations captured)

## Validation

Zimbabwe implements environmental protection via:

- **EMA Zimbabwe** (Environmental Management Agency)
- **Environmental Management Act [Chapter 20:27]** — framework
- **Statutory Instrument 6 of 2007** — Environmental Management (Control of Noise) Regulations
- Typical limits: residential 60/45 dBA day/night, commercial 70/55, industrial 80/65

Notable noise zones:

- **A4 Harare↔Masvingo↔Beitbridge** — main RSA freight artery
- **A8 Bulawayo↔Victoria Falls** + **Hwange coal corridor** (NRZ freight parallel)
- **Greater Harare** + **Bulawayo** dense urban cores
- **NRZ main trunk** (Plumtree↔Bulawayo↔Harare↔Mutare)
- **Harare commuter rail** (limited)
- **Robert Gabriel Mugabe International (HRE/FVHA Harare)**, **Joshua Mqabuko Nkomo International (BUQ/FVBU Bulawayo)**, **Victoria Falls (VFA/FVFA)**, **Kariba (KAB/FVKB)**, **Hwange (HWN/FVWN)**, **Masvingo (MVZ/FVMV)**, **Mutare-Grand Reef (UTA/FVMU)** — covered by global aircraft layer
- **Kariba South Power Station** (1,050 MW hydro, Zambezi)
- **Hwange Thermal Complex** (1,590 MW coal — Zimbabwe's main power plant)
- **Hippo Valley + Triangle sugar bagasse cogen** (Lowveld)
- **ZISCO Redcliff** (defunct since ~2008)
- **Zimplats Ngezi** + **Unki Shurugwi** + **Mimosa Zvishavane** (Great Dyke platinum)
- **Bikita Lithium Mine** (world's oldest and largest lithium mine)
- **Hwange Colliery**
- **Marange diamond fields** (controversial)
- **Harare + Bulawayo + Mutare industrial districts**
- **Chisumbanje Bio-ethanol** (Lowveld)
