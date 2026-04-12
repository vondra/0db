---
title: Kenya
intro: Noise mapping data sources for Kenya.
map: { center: [38, 0], zoom: 6 }
---

## Road traffic

### Class defaults only — no open AADT

KeNHA/KURA/KeRRA publish GIS viewer dashboards (via MangoGIS) with road class/condition/surface but **no traffic volumes**. Kenya Open Data Initiative (opendata.go.ke) has been dormant since ~2015. Fall back to CNOSSOS class defaults.

### Kenyan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Nairobi Expressway) | 30,000 | 60,000 | 42,000 |
| 1 trunk (Class A/B) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 2 metros): **Nairobi** (~4.9M, East Africa's financial hub), **Mombasa** (~1.2M, Indian Ocean port).

**Tier-2 cities** (×1.4, 18 cities): Nakuru, Eldoret, Kisumu, Thika, Ruiru, Kiambu, Machakos, Naivasha, Kitale, Malindi, Kakamega, Kisii, Embu, Meru, Nyeri, Garissa, Lamu, Kilifi.

### Kenyan vehicle split

**Matatus** (shared minibuses) and **boda-bodas** (motorcycle taxis) dominate urban transport. Matatus classified as CNOSSOS "medium" due to bus-like acoustic profile.

| Tier | Light | Medium (matatus) | Heavy | Motorcycle (boda-boda) |
|---|---:|---:|---:|---:|
| Tier-1 (Nairobi/Mombasa) | 50% | **15%** | 10% | **25%** |
| Tier-2 | 52% | 15% | 10% | 23% |
| Rural | 55% | 10% | 20% | 15% |
| **Mombasa-Nairobi container corridor** | 45% | 8% | **35%** | 12% |

### National route network

- **A1** — Lodwar ↔ Kitale ↔ Eldoret ↔ Kisumu ↔ Tanzania border
- **A2** — Nairobi ↔ Nakuru ↔ Eldoret ↔ Uganda (Malaba)
- **A3** — Thika ↔ Embu ↔ Meru ↔ Ethiopia border (Moyale)
- **A8** — Nairobi ↔ Naivasha ↔ Nakuru ↔ Uganda (Northern Corridor)
- **A10** — Nairobi ↔ Machakos ↔ Mombasa (parallel to SGR)
- **A104** — Nairobi ↔ Namanga ↔ Tanzania
- **Nairobi Expressway** — toll road (27 km, JKIA ↔ Westlands, opened 2022)
- **Thika Superhighway** (A2) — 8-lane from Nairobi (2012)

## Railway

### Class defaults + corridor bbox boosts

KR publishes no GIS/GTFS. Use OSM + bbox defaults.

### Kenyan rail context

- **SGR (Madaraka Express)**:
  - Phase 1: **Mombasa ↔ Nairobi**, 472 km, opened June 2017. ~2.7M passengers/year + heavy freight.
  - Phase 2A: Nairobi ↔ Suswa/Naivasha, 120 km, opened October 2019
  - Phase 2B/3: Suswa ↔ Kisumu (planned/delayed)
- **Old metre gauge** — colonial (1895-1970s), mostly defunct
- **Nairobi Commuter Rail** — 4 lines (Syokimau, Embakasi, Ruiru, Kikuyu), limited service
- **No urban metros or LRT** — Kenya has no light rail systems

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **SGR Mombasa↔Nairobi Phase 1** | 8 | 20 |
| **SGR Nairobi↔Naivasha Phase 2A** | 4 | 8 |
| **Nairobi commuter rail** | 20 | 4 |
| Old metre gauge rural (defunct) | 1 | 4 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 129 plants, 45 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Kenya'`

**Operating fuel** (in KE bbox): **geothermal 12** + solar 6 + oil/gas 5 + hydropower 5 + wind 3.

### Top operating plants

| Plant | MW | Type | Location |
|---|---:|---|---|
| **Lake Turkana Wind** | 260 | wind | Turkana — **Africa's largest wind farm** |
| **Gitaru hydro** | 225 | hydropower | Tana River (Seven Forks cascade) |
| **Kiambere hydro** | 168 | hydropower | Tana River |
| **Kipevu III** | 117 | oil/gas | Mombasa |
| **Turkwel hydro** | 103 | hydropower | Turkwel Gorge |
| **Kipeto wind** | 100 | wind | Kajiado |

**Olkaria Geothermal Complex** — the **world's largest geothermal power complex**, ~780 MW across Olkaria I/I-AU/II/III/IV/V + wellhead generators. Kenya is #9 globally in geothermal generation, exploiting the East African Rift Valley. Appears as 12 separate entries in GEM.

**Tana River / Seven Forks hydro cascade**: Masinga (40 MW) + Kamburu (94 MW) + Gitaru (225 MW) + Kindaruma (72 MW) + Kiambere (168 MW) = ~600 MW total.

All operating plants map to **NACE 35** (Electricity generation).

### Kenya does NOT have

- **No TPDA/AADT** — zero traffic data
- **No rail GTFS** — even for SGR
- **Mombasa Refinery closed 2013** — Kipevu Oil Terminal still operates as tank farm
- **Cement plants not classified**: Bamburi, EAPCC, Mombasa Cement, Savannah Cement rely on OSM only

## Validation

Kenya implements noise regulation via:

- **NEMA** (National Environment Management Authority) at nema.go.ke
- **Environmental Management and Coordination (Noise and Excessive Vibration Pollution) Regulations, 2009**
- Typical limits: Residential day/night 55/45 dBA, commercial 65/55 dBA, industrial 75/65 dBA

Notable noise zones:

- **Mombasa-Nairobi A10 corridor** — container freight from Mombasa port
- **Thika Superhighway** — Nairobi northeast exit (8-lane)
- **Nairobi Expressway** — toll road JKIA ↔ Westlands
- **A104 Nairobi ↔ Namanga** — Tanzania border
- **Uhuru Highway / Waiyaki Way / Mombasa Road** — Nairobi arterials
- **Moi Avenue / Digo Road** — Mombasa arterials
- **SGR Phase 1 Mombasa ↔ Nairobi** — 472 km standard gauge
- **SGR Phase 2A Nairobi ↔ Naivasha**
- **Nairobi commuter rail** — 4 lines
- **Jomo Kenyatta International (NBO/HKJK Nairobi)**, **Moi International (MBA/HKMO Mombasa)**, **Wilson (WIL Nairobi GA)**, **Eldoret International (EDL/HKEL)**, **Kisumu (KIS/HKKI)**, **Malindi (MYD/HKML)** — covered by global aircraft layer
- **Olkaria Geothermal Complex** — world's largest geothermal complex, 780 MW across the Rift Valley
- **Lake Turkana Wind Power** (260 MW — Africa's largest wind farm)
- **Tana River / Seven Forks hydro cascade** (600 MW total)
- **Kipevu power complex** Mombasa (oil/gas emergency backup)
- **Kipevu Oil Terminal** (former Mombasa Refinery site, closed 2013)
- **KPC Mombasa-Nairobi-Eldoret oil pipeline**
- **Bamburi Cement Mombasa** (Africa's largest cement factory by capacity)
- **EABL Nairobi** (East African Breweries)
- **EAPCC Athi River cement** (East African Portland Cement)
