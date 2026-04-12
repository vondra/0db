---
title: Uganda
intro: Noise mapping data sources for Uganda.
map: { center: [32, 1.5], zoom: 6 }
---

## Road traffic

### Class defaults only

UNRA (Uganda National Roads Authority) publishes no open GIS despite having a GIS department. Fall back to CNOSSOS class defaults with Greater Kampala Tier-1 boost.

### Ugandan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Kampala-Entebbe Expressway 2018) | 28,000 | 56,000 | 39,200 |
| 1 trunk (A paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 1 metro): **Greater Kampala** (~3.5M metro — built on seven hills + Wakiso suburbs).

**Tier-2 cities** (×1.4, 20 cities): **Entebbe** (Lake Victoria, international airport), **Jinja** (source of the Nile, industrial hub, Bujagali + Nalubaale hydros), Gulu (Acholi north), Lira (north-central), Mbarara (SW cattle country), Mbale (Mt. Elgon east), **Hoima** (**oil capital**, Lake Albert hub), Soroti (Teso region), Kabale (SW, Rwanda border), Masaka, **Kasese** (**Kilembe copper**, Rwenzori Mountains), Fort Portal (Toro, tea country), **Tororo** (Tororo Cement, Kenya border), Arua (West Nile region), Iganga, Mukono (Kampala east satellite), Wakiso, Kitgum (NE Acholi), Moroto (Karamoja), **Buliisa** (Tilenga oil field).

### Ugandan vehicle split

Uganda's urban transport is **boda-boda dominated**:

- **Boda-boda** — motorcycle taxis, **dominant in Kampala and most Ugandan towns**. **Estimated 200,000+ registered in Kampala alone** — one of the highest per-capita motorcycle taxi rates in Africa
- **Matatu** — white minibus taxis (Toyota HiAce), shared intercity and urban transport (similar to Kenyan matatus)
- **Kamunye** — 14-seat city matatus specifically in Kampala
- **Special Hires** — shared sedan taxis
- **Pioneer Easy Bus** — official Kampala bus service (**discontinued 2022** — city has no functioning public bus network since)
- **Heavy trucks**: Kampala ↔ Mombasa freight corridor (Uganda's only sea outlet), EACOP construction, Kilembe copper

| Tier | Light | Medium (matatu) | Heavy | Motorcycle (boda-boda) |
|---|---:|---:|---:|---:|
| Tier-1 (Kampala) | 45% | 15% | 12% | **28%** |
| Tier-2 | 48% | 13% | 15% | 24% |
| Rural | 50% | 10% | 25% | 15% |
| **Kampala↔Mombasa highway (A109)** | 45% | 7% | **40%** | 8% |
| **Hoima/Lake Albert oil corridor** | 40% | 6% | **48%** | 6% |

### National route network

- **A109** — Malaba ↔ Tororo ↔ Jinja ↔ Kampala (**Kampala ↔ Mombasa corridor**, Uganda's trade artery via Kenya)
- **A103** — Kampala ↔ Masaka ↔ Mutukula (Tanzania border)
- **A104** — Kampala ↔ Mbarara ↔ Kabale ↔ Katuna (Rwanda border)
- **A106** — Kampala ↔ Fort Portal ↔ Kasese (SW corridor)
- **A108** — Kampala ↔ Hoima ↔ Buliisa (oil corridor)
- **A2** — Kampala ↔ Gulu ↔ Juba (South Sudan)
- **Kampala-Entebbe Expressway** — **Uganda's first motorway, opened 2018** (Chinese-built, 51 km toll road)
- **Kampala-Jinja Expressway** — under construction

## Railway

### Class defaults + corridor bbox boosts

### Ugandan rail context

Uganda has a **very limited operating rail network** — a legacy of the Ugandan Railways Corporation (URC) and the broader historic meter-gauge Uganda Railway (Mombasa ↔ Nairobi ↔ Kampala ↔ Kasese, 1896-1931) that is **largely defunct west of Kampala**.

### URC Uganda Railway (meter gauge, active sections)
- **Eastern main line**: Malaba ↔ Tororo ↔ Mbale ↔ Jinja ↔ Kampala — connects to Kenya Railways at Malaba border post. **Only regular operating line**. Critical for Kenya transit freight.
- **Northern line**: Tororo ↔ Soroti ↔ Gulu ↔ Pakwach — rehabilitated, freight only
- **Western line**: Kampala ↔ Kasese — **mostly defunct**, no regular service

### Kampala Metropolitan Commuter Rail
- **Opened 2015**, short operational sections from Kampala to Namanve industrial area + suburbs
- Service has been interrupted multiple times

### SGR (Standard Gauge Railway) — planned but stalled
- **273 km Malaba ↔ Kampala ↔ Mirama Hills** (Rwanda border). Designed to connect to Kenya SGR Madaraka Express.
- **Chinese funding fell through 2019**, alternative financing uncertain
- **NOT OPERATIONAL**

**Uganda is critically dependent on the Kenya route** for imports/exports (Mombasa ↔ Nairobi ↔ Malaba ↔ Kampala, via Kenya SGR + Uganda meter gauge).

**No metros, no trams** in any Ugandan city.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Kampala commuter rail (2015)** | 20 | 0 |
| **Eastern main line** (Malaba↔Kampala, Kenya freight transit) | 1 | 10 |
| **Northern line** (Tororo↔Gulu↔Pakwach) | 0 | 3 |
| **Western line** (Kampala↔Kasese, mostly defunct) | 0 | 1 |
| Other/branch | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 49 plants, 19 operating, ~1.75 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Uganda'`

**Operating fuel**: solar 10 + hydropower 5 + oil/gas 3 + bioenergy 1.

**Uganda is almost entirely hydro-powered from the White Nile cascade** — Nile hydro alone = ~1,413 MW = **81% of national capacity**. The cascade runs from the Lake Victoria outlet (Owen Falls at Jinja) downstream through Bujagali/Isimba/Karuma.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Karuma** | **600** | hydropower | **Nile River, opened 2024** — Uganda's largest, built by Sinohydro. Delayed from 2018 due to technical disputes |
| **Bujagali** | 250 | hydropower | Nile (Bujagali Falls below Jinja), 2012 — private IPP (SG Bujagali Holdings) |
| **Kiira** | 200 | hydropower | **Nile at Owen Falls Dam extension**, 2000 — twin station sharing dam with Nalubaale |
| **Isimba** | 183 | hydropower | Nile, 2019 |
| **Nalubaale (formerly Owen Falls)** | 180 | hydropower | **Nile at Jinja, 1954** — **Uganda's oldest major hydro**, at the source of the White Nile (first hydro project in Uganda) |
| **Tororo** | 89 | oil/gas | East — emergency thermal (Aggreko-era) |
| **Mutundwe** | 50 | oil/gas | Kampala area |
| **Namanve Thermal** | 50 | oil/gas | Kampala industrial park |
| **Kakira Sugar** | 30 | bioenergy | **Sugarcane bagasse cogeneration** — Madhvani Group's Kakira sugar estate |
| **10× small solar plants** | ~120 total | solar | Kabulasoke/Nkonge/Tororo/Rakai/Bufulubi/Soroti/etc. (4-24 MW each) |

**Total operating: ~1,746 MW**.

All operating plants map to **NACE 35**.

### Uganda does NOT have

- **No UNRA AADT** — zero open traffic data despite having internal GIS capacity
- **No URC GTFS** — all timetables corporate HTML only
- **Lake Albert oil fields** not NACE 06: **Tilenga** (TotalEnergies) + **Kingfisher** (CNOOC), ~6.5 Bbbl resources, **first oil production target ~2025/2026**
- **EACOP (East African Crude Oil Pipeline)** not NACE 19 — **1,443 km**, Hoima ↔ Tanga (Tanzania), **under construction 2023-2026**. **World's longest heated crude oil pipeline**. Major controversy over climate, environment, and community displacement
- **Uganda Refinery Hoima** — planned 60k bpd, not yet built
- **Roofings Group** (Kampala, Namanve industrial park) not NACE 24 — **East Africa's largest steel manufacturer**, integrated steel mill + galvanizing
- **Cement plants not NACE 23**: Hima Cement (Holcim→Bamburi, near Kasese), Tororo Cement, Simba Cement
- **Sugar plants not NACE 10**: Kakira (Madhvani Group), Kinyara, SCOUL Lugazi
- **Coffee processing** — **Uganda is Africa's #2 coffee producer** after Ethiopia (~5 Mbags/year), no NACE 10
- **Kilembe copper + cobalt mine** (Kasese) — historically major, rehabilitation under discussion since 2013
- **Lake Victoria Nile perch fishing/processing** — major sector

## Validation

Uganda implements environmental protection via:

- **NEMA** (National Environment Management Authority) — environmental protection
- **National Environment Act 2019** — framework law
- **Environmental Impact Assessment Regulations** (for EACOP, oil fields, etc.)
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Kampala-Entebbe Expressway** — Uganda's first motorway
- **A109 Kampala↔Mombasa corridor** (via Jinja, Tororo, Malaba — Uganda's trade artery)
- **A108 Kampala↔Hoima↔Buliisa** — oil corridor (EACOP construction traffic)
- **Greater Kampala** — seven hills dense urban core with extreme boda-boda density
- **Kampala commuter rail** (limited suburban service)
- **URC Eastern main line** (Malaba↔Kampala via Jinja)
- **Entebbe International (EBB/HUEN)**, **Kajjansi (KJJ)**, **Gulu (ULU/HUGU)**, **Arua (RUA/HUAR)**, **Kasese (KSE/HUKS)**, **Soroti (SRT/HUSO)**, **Kabalega Falls (no IATA)**, **Hoima International under construction** — covered by global aircraft layer
- **Nile River hydro cascade** — **Karuma 600 + Bujagali 250 + Kiira 200 + Isimba 183 + Nalubaale 180** = 1,413 MW (81% of national capacity)
- **Kakira Sugar bagasse cogen** (Madhvani Group)
- **Tororo thermal + Mutundwe + Namanve thermal** (Kampala area)
- **Roofings Group steel** (Namanve industrial park — East Africa's largest steel manufacturer)
- **Tororo Cement + Hima Cement + Simba Cement**
- **Kilembe copper/cobalt mine** (Kasese, Rwenzori foothills)
- **Lake Albert oil fields** — Tilenga + Kingfisher (production starting ~2025/2026)
- **EACOP pipeline** (under construction 2023-2026 — world's longest heated crude oil pipeline)
- **Jinja** — industrial hub at source of the Nile (Owen Falls area)
