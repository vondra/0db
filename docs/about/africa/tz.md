---
title: Tanzania
intro: Noise mapping data sources for Tanzania.
map: { center: [35, -6], zoom: 5 }
---

## Road traffic

### Class defaults only

TANROADS/TARURA publish no open AADT. Fall back to CNOSSOS class defaults with Dar es Salaam Tier-1 boost.

### Tanzanian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (TANZAM, Mbezi Beach Expressway) | 25,000 | 50,000 | 35,000 |
| 1 trunk (T-route paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 1 metro): **Dar es Salaam** (~7M, Tanzania's largest by far — economic capital, though Dodoma is political capital since 1996).

**Tier-2 cities** (×1.4, 19 cities): Dodoma, Mwanza, Arusha, Mbeya, Morogoro, Tanga, Kahama, Tabora, Zanzibar City, Kigoma, Sumbawanga, Kasulu, Songea, Musoma, Iringa, Singida, Shinyanga, Moshi, Bukoba.

### Tanzanian vehicle split

**Daladala** (minibus) + **boda-boda** (motorcycle taxi) dominate urban transport — similar to Kenya.

| Tier | Light | Medium (daladalas) | Heavy | Motorcycle (boda-boda) |
|---|---:|---:|---:|---:|
| Tier-1 (Dar es Salaam) | 50% | **15%** | 10% | **25%** |
| Tier-2 | 52% | 13% | 12% | 23% |
| Rural | 55% | 10% | 20% | 15% |
| **TANZAM corridor (copper freight)** | 42% | 8% | **40%** | 10% |

### National route network

- **T1/T2** — Dar es Salaam ↔ Chalinze ↔ Morogoro ↔ Dodoma ↔ Singida ↔ Tabora ↔ Kigoma
- **T3** — Chalinze ↔ Arusha ↔ Namanga (Kenya)
- **T4** — Arusha ↔ Moshi ↔ Tanga ↔ Dar es Salaam (Uhuru Highway)
- **T5 (TANZAM Highway)** — Dar es Salaam ↔ Mbeya ↔ Tunduma (Zambia) — parallel to TAZARA railway
- **T7** — Mbeya ↔ Songea ↔ Mtwara

## Railway

### Class defaults + corridor bbox boosts

### Tanzanian rail context

- **TAZARA** — **1,860 km Chinese-built (1970-1975)**, Dar es Salaam ↔ Kapiri Mposhi (Zambia). Carries copper/cobalt from Zambian Copperbelt to Dar es Salaam port. Cape gauge.
- **TRL/TRC Central Line** — colonial meter-gauge legacy. Dar es Salaam ↔ Tabora ↔ Kigoma (Lake Tanganyika) + Tabora ↔ Mwanza (Lake Victoria). Partially defunct.
- **SGR (Standard Gauge Railway)** — 5 phases:
  - Phase 1 Dar es Salaam ↔ Morogoro (300 km, **opened 2021**)
  - Phase 2 Morogoro ↔ Makutupora/Dodoma (422 km, **opened 2024**)
  - Phase 3-5 Makutupora ↔ Tabora ↔ Isaka ↔ Mwanza + Kigoma/Rusumo (ongoing)
- **No urban metros**; Dar es Salaam has **DART** BRT (bus rapid transit)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **SGR Phase 1+2 (Dar↔Dodoma, 2021/2024)** | 10 | 20 |
| **TAZARA (Dar↔Zambia)** | 3 | 12 |
| **Central Line (old meter gauge)** | 2 | 6 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 87 plants, 14 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Tanzania'`

**Operating fuel**: hydropower 6 + oil/gas 4 + solar 4.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Julius Nyerere Hydroelectric** | **2,115** | hydropower | **Opened 2024** — Rufiji River at Stiegler's Gorge, Nyerere National Park. One of Africa's newest mega-dams. |
| **Kinyerezi II** | 240 | oil/gas | Dar es Salaam (2016) |
| **Kidatu** | 200 | hydropower | Great Ruaha River |
| **Kihansi** | 180 | hydropower | Kihansi Gorge, Iringa |
| Tegeta (Diesel) | 100 | oil | Dar es Salaam |
| Kishapu Solar | 100 | solar | |
| **Mtera** | 80 | hydropower | Great Ruaha (upstream of Kidatu) |
| **Rusumo** | 80 | hydropower | Akagera R. — binational with Rwanda/Burundi |
| **Pangani Falls** | 68 | hydropower | Pangani River |
| **Dodoma** | 55 | oil/gas | Capital backup |

**Julius Nyerere Hydroelectric Plant** — one of Africa's newest and largest hydropower projects, built 2019-2024 by Arab Contractors and Elsewedy Electric (Egyptian consortium) for US$3.6 billion. Located on the Rufiji River at Stiegler's Gorge inside the former Selous Game Reserve / new Nyerere National Park. Controversial due to impact on UNESCO World Heritage site but **doubles Tanzania's installed electricity capacity**.

All operating plants map to **NACE 35**.

### Tanzania does NOT have

- **No TPDA/AADT** — zero traffic data
- **No rail GTFS** (SGR, TAZARA, Central Line)
- **Gold mines not classified**: Geita (AngloGold Ashanti), Bulyanhulu/Buzwagi/North Mara (Barrick) — Tanzania is #4 African gold producer
- **Williamson Diamond Mine** (Mwadui) — world's oldest continuously operating diamond mine (since 1940)
- **Mererani Tanzanite** — only source of tanzanite in the world
- **Songo Songo gas field + pipelines** not classified
- **Cement plants not NACE 23**: Tanga, Dangote TZ, Twiga, Mbeya
- **Dar es Salaam port** — East Africa's 2nd largest port after Mombasa

## Validation

Tanzania implements noise regulation via:

- **NEMC** (National Environment Management Council) at nemc.or.tz
- **Environmental Management Act (2004)** — Noise and Vibration Pollution (Control) Regulations, 2011
- Typical limits: Residential 60/50 dBA day/night, commercial 70/60 dBA, industrial 75/65 dBA

Notable noise zones:

- **Morogoro Road / Nyerere Road / Kilwa Road** Dar es Salaam — major arterials
- **TANZAM Highway (T5)** Dar ↔ Mbeya ↔ Zambia — copper freight corridor
- **T3 Chalinze ↔ Arusha ↔ Namanga** — Kenya border corridor
- **Uhuru Highway (T4)** — Dar ↔ Tanga
- **SGR Phase 1+2** (Dar es Salaam ↔ Morogoro ↔ Dodoma, opened 2021-2024)
- **TAZARA Railway** — 1,860 km copper corridor
- **Julius Nyerere International (DAR/HTDA Dar es Salaam)**, **Kilimanjaro International (JRO/HTKJ)**, **Abeid Amani Karume International (ZNZ/HTZA Zanzibar)**, **Mwanza (MWZ/HTMW)**, **Arusha (ARK/HTAR)**, **Dodoma (DOD/HTDO)** — covered by global aircraft layer
- **Julius Nyerere Hydroelectric Dam** (Rufiji River, 2,115 MW, 2024) — one of Africa's largest new mega-dams
- **Kinyerezi II + Tegeta thermal cluster** Dar es Salaam
- **Kidatu + Kihansi + Mtera + Pangani hydros** — Tanzania's established hydro fleet
- **Dar es Salaam Port** — East Africa's 2nd largest container port
- **Geita Gold Mine** (AngloGold Ashanti) + **Bulyanhulu** (Barrick) — gold mining belt around Lake Victoria
- **Williamson Diamond Mine Mwadui** (Shinyanga) — world's oldest diamond mine
- **Mererani Tanzanite Mines** (Manyara) — only source of tanzanite
- **Songo Songo gas field + Mtwara-Dar pipeline**
- **TIPER Dar refinery** (closed 1999)
