---
title: Ghana
intro: Noise mapping data sources for Ghana.
map: { center: [-1, 8], zoom: 6 }
---

## Road traffic

### Road defaults

Ghana publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Ghana's traffic factor **≈ 1.254** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.254 ≈ 37,620 |
| Trunk | 15,000 × 1.254 ≈ 18,810 |
| Primary | 9,000 × 1.254 ≈ 11,286 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **N1** — Aflao ↔ Accra ↔ Cape Coast ↔ Sekondi-Takoradi ↔ Elubo — coastal spine
- **N6** — Accra ↔ Kumasi ↔ Tamale ↔ Paga (Burkina) — longest (via Kintampo)
- **N8** — Kumasi ↔ Takoradi — mineral freight corridor
- **Accra-Tema Motorway** — Ghana's only motorway (~20 km, 1965, dual carriageway)

## Railway

### Ghanaian rail context

- **Tema-Mpakadan SGR** — Ghana's **first standard gauge railway**, 97 km, opened 2024. Tema Port ↔ Mpakadan near Akosombo Dam. Part of planned Accra ↔ Ouagadougou corridor.
- **Western Line** (Takoradi ↔ Kumasi) — colonial narrow gauge, mineral freight (bauxite, manganese, cocoa). Being rehabilitated.
- **Eastern Line** (Accra ↔ Kumasi via Achimota) — degraded passenger service
- **Central Line** (Huni Valley ↔ Kade) — mostly defunct
- **Accra-Tema Urban Railway** — limited commuter service
- **No urban metros**

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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
- **Gold mines not classified**: **Obuasi** (AngloGold Ashanti, a historic deep underground gold mine — one of Africa's largest), Ahafo/Akyem (Newmont), Tarkwa/Damang (Goldfields), Asanko — Ghana is Africa's #1 gold producer (~world #11)
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
- **Obuasi Gold Mine** — historic deep underground gold mine, one of Africa's largest (AngloGold Ashanti)
- **Tarkwa-Damang gold district** (Goldfields)
- **Ahafo-Akyem gold district** (Newmont)
- **Nsuta manganese mine** + **Awaso bauxite mine**
- **Tema Port + Takoradi Port** — Ghana's two major seaports
- **Jubilee Field FPSO** (Tullow, offshore Western Region)
