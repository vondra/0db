---
title: Rwanda
intro: Noise mapping data sources for Rwanda.
map: { center: [29.8, -2], zoom: 8 }
---

## Road traffic

### Road defaults

Rwanda publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Rwanda's traffic factor **≈ 1.268** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.268 ≈ 38,040 |
| Trunk | 15,000 × 1.268 ≈ 19,020 |
| Primary | 9,000 × 1.268 ≈ 11,412 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **NR1** — Kigali ↔ Huye ↔ Cyangugu/Rusizi (Lake Kivu south, DRC/Burundi border)
- **NR2** — Kigali ↔ Kayonza ↔ Nyagatare ↔ Uganda border (NE)
- **NR3** — Kigali ↔ Rwamagana ↔ Rusumo (Tanzania border, freight transit)
- **NR4** — Kigali ↔ Gatuna (Uganda border, main Kampala route)
- **NR5** — Kigali ↔ Musanze (Volcanoes NP, gorilla tourism)
- **NR7** — Kigali ↔ Muhanga ↔ Kibuye/Karongi (Lake Kivu)

## Railway

### Rwanda has NO railway

Rwanda has **never had a railway** — one of the few African countries without one. The planned **Isaka (Tanzania) ↔ Kigali SGR** is not built (funding uncertain). All freight arrives by road trucking from Kenya (Mombasa ↔ Nairobi ↔ Kampala ↔ Kigali ~1,700 km) or Tanzania (Dar es Salaam ↔ Isaka ↔ Rusumo ↔ Kigali).

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 6 plants, 4 operating, ~68 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Rwanda'`

**GEM severely under-represents Rwanda** — only 4 operating plants in GEM (~68 MW) vs actual ~220 MW installed fleet. Most Rwandan capacity is in **many small hydros (2-20 MW each)** below GEM's reporting threshold.

### Top operating plants (from GEM)

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **KivuWatt / Lake Kivu** | 56 | oil/gas (actually **methane**) | **World's only operational lake methane power plant**. Lake Kivu contains ~65 km³ dissolved CO₂ + methane at depth — a **limnic eruption risk** if not managed. Contour Global extracts and burns methane in gas engines. GEM classifies as oil/gas but it's actually biogenic dissolved methane. |
| **Agahozo Solar** | 7 | solar | Rwamagana — one of East Africa's first utility solar farms (2014) |
| **Nasho Solar** | 3.3 | solar | |
| **Bugesera District Solar** | 1.8 | solar | |

### NOT in GEM but significant

- **Nyabarongo I 28 MW** (Muhanga, 2014) — Rwanda's largest single hydro
- **Rusumo Falls 80 MW** (Akagera River, shared Rwanda/Tanzania/Burundi, opened 2023 — binational Nile Basin)
- **Ntaruka 11 MW** (Lake Burera → Ruhondo)
- **Mukungwa I+II ~16 MW** (Musanze)
- **Numerous 2-10 MW micro-hydros** (Rugezi, Gihira, Keya, etc.)
- **Jabana diesel/HFO** (Kigali, emergency thermal)

### Rwanda does NOT have

- **No RTDA AADT** — zero open traffic data
- **No railway** — never built
- **CIMERWA cement** (LafargeHolcim, Rusizi) not NACE 23 — Rwanda's only cement plant
- **3T minerals** (tin/tantalum/tungsten) — Rwanda processes Central African conflict minerals (DRC origin) at Piran, LuNa, MSA smelters. Regulated under Dodd-Frank/EU Conflict Minerals
- **Coffee + tea processing** — Rwanda specialty washed arabica, high-premium sector
- **Kigali Special Economic Zone** — IT hub (Carnegie Mellon Africa, Andela, VW mobility)
- **Bugesera International Airport** — under construction since 2017

## Validation

Rwanda implements environmental protection via:

- **REMA** (Rwanda Environment Management Authority) — primary authority
- **Organic Law n° 04/2005** — environmental protection framework
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60
- **Kigali is Africa's cleanest city** — monthly Umuganda community service + plastic bag ban since 2008

Notable noise zones:

- **Kigali** — hilly urban core, extreme moto-taxi density
- **NR1 Kigali↔Huye↔Cyangugu** — main south corridor
- **NR4 Kigali↔Gatuna** — main Uganda/Kampala import corridor
- **NR3 Kigali↔Rusumo** — Tanzania import corridor
- **NR5 Kigali↔Musanze** — Volcanoes NP gorilla tourism
- **Kigali International (KGL/HRYR)**, **Kamembe (KME/HRZA)** — covered by global aircraft layer
- **KivuWatt/Lake Kivu methane** (world's only lake methane plant)
- **KBS bus depot Kigali** — city bus operations
- **Kigali Special Economic Zone** (IT + light manufacturing)
- **CIMERWA cement** (Rusizi)
