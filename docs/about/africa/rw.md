---
title: Rwanda
intro: Noise mapping data sources for Rwanda.
map: { center: [29.8, -2], zoom: 8 }
---

## Road traffic

### Class defaults only

RTDA (Rwanda Transport Development Agency) publishes no open GIS. Fall back to CNOSSOS class defaults with Kigali Tier-1 boost. **Rwanda has NO railway** — all freight arrives by road.

### Rwandan AADT defaults

Rwanda is **Africa's most densely populated mainland country** (~14M in 26k km² = 525/km²). Extreme population density means roads have **disproportionately high noise significance** — even rural roads carry meaningful traffic.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Kigali Convention Centre dual carriageway) | 25,000 | 50,000 | 35,000 |
| 1 trunk (NR paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 1 metro): **Kigali** (~1.3M, built on rolling hills, **"Africa's cleanest city"** — monthly Umuganda community service + plastic bag ban since 2008).

**Tier-2 cities** (×1.4, 11 cities): Butare/Huye (university city), Gitarama/Muhanga, **Ruhengeri/Musanze** (Volcanoes NP gorilla tourism gateway), **Gisenyi/Rubavu** (Lake Kivu north, DRC border), **Cyangugu/Rusizi** (Lake Kivu south, DRC/Burundi border), Kibungo/Ngoma, Byumba/Gicumbi, Kibuye/Karongi (Lake Kivu), Rwamagana, Nyanza, Nyagatare (NE).

### Rwandan vehicle split

Rwanda is **moto-taxi (moto) dominated** — similar to Kenya/Uganda but with **Africa's highest urban moto share** (~30% in Kigali). Kigali's hilly terrain makes cycling impractical and minibuses slow.

- **Motos** — motorcycle taxis (green/orange high-vis vest), **extremely dominant in Kigali** (~40,000+ registered). Regulated with helmets/vests since 2010.
- **Twegerane** — white minibus taxis (Kigali Urban Minibus)
- **KBS (Kigali Bus Services)** — privatized public bus company
- **ONATRACOM / Royal Express / Volcano Express** — intercity coaches
- **Heavy trucks**: **All imports via road trucking** — Rwanda is landlocked. Transit from Kenya via Kampala (NR1/NR4) or Tanzania via Rusumo (NR3). **50% heavy share on freight corridors**.

| Tier | Light | Medium | Heavy | Motorcycle (moto) |
|---|---:|---:|---:|---:|
| Tier-1 (Kigali) | 42% | 14% | 14% | **30%** |
| Tier-2 | 44% | 12% | 18% | 26% |
| Rural | 42% | 8% | 30% | 20% |
| **NR1/NR4 freight corridors** (Kampala/Rusumo transit) | 38% | 5% | **50%** | 7% |

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
