---
title: Ghana
intro: Noise mapping data sources for Ghana.
map: { center: [-1, 8], zoom: 6 }
---

## Road traffic

### Class defaults only

All Ghanaian road authorities (GHA, DFR, DUR, MRH) publish WordPress sites with no GIS. Ghana's open data portal (data.gov.gh, first in sub-Saharan Africa, 2012) has been dormant since ~2015. Fall back to CNOSSOS class defaults.

### Ghanaian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Accra-Tema Motorway) | 30,000 | 60,000 | 42,000 |
| 1 trunk (N-route paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 2 metros): **Greater Accra** (~4.5M), **Kumasi** (~3.3M).

**Tier-2 cities** (×1.4, 15 cities): Tamale, Sekondi-Takoradi, Tema, Cape Coast, Obuasi, Sunyani, Ho, Koforidua, Bolgatanga, Wa, Nkawkaw, Techiman, Madina, Ashaiman, Nungua.

### Ghanaian vehicle split

**Trotro** minibuses dominate urban transport (CNOSSOS medium, ~12% urban share). Motorcycle share moderate (~15-20%). Heavy share elevated on mineral/cocoa export corridors.

| Tier | Light | Medium (trotro) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 | 58% | 12% | 12% | 18% |
| Tier-2 | 60% | 10% | 14% | 16% |
| Rural | 60% | 10% | 20% | 10% |
| **Mineral/cocoa corridors** | 50% | 10% | **30%** | 10% |

### National route network

- **N1** — Aflao ↔ Accra ↔ Cape Coast ↔ Sekondi-Takoradi ↔ Elubo — coastal spine
- **N6** — Accra ↔ Kumasi ↔ Tamale ↔ Paga (Burkina) — longest (via Kintampo)
- **N8** — Kumasi ↔ Takoradi — mineral freight corridor
- **Accra-Tema Motorway** — Ghana's only motorway (~20 km, 1965, dual carriageway)

## Railway

### Class defaults + corridor bbox boosts

### Ghanaian rail context

- **Tema-Mpakadan SGR** — Ghana's **first standard gauge railway**, 97 km, opened 2024. Tema Port ↔ Mpakadan near Akosombo Dam. Part of planned Accra ↔ Ouagadougou corridor.
- **Western Line** (Takoradi ↔ Kumasi) — colonial narrow gauge, mineral freight (bauxite, manganese, cocoa). Being rehabilitated.
- **Eastern Line** (Accra ↔ Kumasi via Achimota) — degraded passenger service
- **Central Line** (Huni Valley ↔ Kade) — mostly defunct
- **Accra-Tema Urban Railway** — limited commuter service
- **No urban metros**

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Tema-Mpakadan SGR (2024)** | 4 | 12 |
| **Accra-Tema urban commuter** | 10 | 4 |
| **Western Line (minerals)** | 0 | 6 |
| **Eastern Line (degraded)** | 1 | 4 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 98 plants, 33 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Ghana'`

**Operating fuel**: oil/gas 15 + solar 15 + hydropower 3.

### Top operating plants

| Plant | MW | Type | Location |
|---|---:|---|---|
| **Akosombo** | 1,020 | hydropower | Volta River (VRA, 1965) — impounds Lake Volta |
| **Karpowership Osman Khan** | 450 | oil/gas | Floating powership, Tema |
| **Bui** | 400 | hydropower | Black Volta (BPA, 2013) |
| **Aksa Ghana HFO** | 370 | oil/gas (HFO) | Turkish IPP |
| **Sunon Asogli** | 360 + 200 | oil/gas | Shenzhen Energy, Tema |
| **Kpone IPP (KIPP)** | 350 | oil/gas | Tema |
| **Takoradi (TAPCO) 1** | 330 | oil/gas | Aboadze |
| **Takoradi (TICO)** | 320 | oil/gas | Aboadze |
| **Amandi** | 203 | oil/gas | Aboadze |
| **Kpong** | 160 | hydropower | Volta River (VRA, downstream of Akosombo) |

**Akosombo Dam** impounds **Lake Volta** — at 8,502 km², the **world's largest reservoir by surface area** and **Africa's largest artificial lake**. Built 1961-1965 with US/UK/World Bank funding, primarily to power the VALCO aluminum smelter at Tema. One of the defining Pan-African infrastructure projects of the independence era.

All operating plants map to **NACE 35** (Electricity generation).

### Ghana does NOT have

- **No TPDA/AADT** — zero traffic data
- **No GTFS** for any rail system
- **Gold mines not classified**: **Obuasi** (AngloGold Ashanti, world's largest underground gold mine by reserves), Ahafo/Akyem (Newmont), Tarkwa/Damang (Goldfields), Asanko — Ghana is world's #7 gold producer
- **TOR refinery not NACE 19**: Tema Oil Refinery (45k bpd, mostly idle)
- **VALCO not NACE 24**: Tema aluminum smelter (200 ktpa, mostly idle)
- **Cocoa processing not NACE 10**: world's 2nd largest cocoa producer
- **Manganese/bauxite mines**: Nsuta, Awaso rely on OSM only
- **Jubilee/TEN offshore oil**: Tullow FPSO production not classified

## Validation

Ghana implements noise regulation via:

- **EPA Ghana** (Environmental Protection Agency) at epa.gov.gh
- **Environmental Protection Agency Act, 1994 (Act 490)**
- **LI 1652 (2001)** — Environmental Assessment Regulations include noise EIAs
- Typical limits: Residential day/night 55/48 dBA, commercial 60/55 dBA, industrial 70/60 dBA

Notable noise zones:

- **Accra-Tema Motorway** — Ghana's only motorway
- **N1 Accra ↔ Aflao** (Togo border) — coastal traffic
- **N6 Accra ↔ Kumasi ↔ Tamale ↔ Paga** — longest route (Burkina Faso corridor)
- **N8 Kumasi ↔ Takoradi** — mineral freight
- **Liberation Road, Ring Road** Accra arterials
- **Tema-Mpakadan SGR** — Ghana's first standard gauge railway (2024)
- **Western Line Takoradi ↔ Kumasi** — mineral freight corridor
- **Kotoka International (ACC/DGAA Accra)**, **Kumasi (KMS/DGSI)**, **Tamale (TML/DGLE)**, **Takoradi (TKD/DGTK)** — covered by global aircraft layer
- **Akosombo Dam + Lake Volta** (Volta River Authority, 1,020 MW) — one of Africa's largest hydro, world's largest reservoir by surface area (8,502 km²)
- **Bui Dam** (Black Volta, 400 MW, BPA 2013)
- **Kpong Dam** (Volta River, 160 MW, VRA downstream of Akosombo)
- **Aboadze Thermal Complex Takoradi** (TAPCO + TICO + Amandi ~850 MW)
- **Sunon Asogli / Kpone / Karpowership cluster** Tema (~1.5 GW combined)
- **Tema Oil Refinery (TOR)** — mostly non-operational since 2017
- **VALCO Tema** aluminum smelter — mostly idle
- **Obuasi Gold Mine** — world's largest underground gold mine by reserves (AngloGold Ashanti)
- **Tarkwa-Damang gold district** (Goldfields)
- **Ahafo-Akyem gold district** (Newmont)
- **Nsuta manganese mine** + **Awaso bauxite mine**
- **Tema Port + Takoradi Port** — Ghana's two major seaports
- **Jubilee Field FPSO** (Tullow, offshore Western Region)
