---
title: Zimbabwe
intro: Noise mapping data sources for Zimbabwe.
map: { center: [30, -19], zoom: 6 }
---

## Road traffic

### Road defaults

Zimbabwe publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Zimbabwe's traffic factor **≈ 1.093** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.093 ≈ 32,790 |
| Trunk | 15,000 × 1.093 ≈ 16,395 |
| Primary | 9,000 × 1.093 ≈ 9,837 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

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

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 188 plants, 34 operating, ~2.96 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Zimbabwe'` (supplemented with **Kariba South** — GEM lists Kariba Dam under Zambia only)

**Operating fuel**: solar 21 + coal 10 + bioenergy 2 + hydropower 1.

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
| **19× small solar plants** | ~140 total | solar | 5-30 MW each |

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
