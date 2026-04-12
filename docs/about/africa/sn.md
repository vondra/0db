---
title: Senegal
intro: Noise mapping data sources for Senegal.
map: { center: [-14.5, 14.5], zoom: 6 }
---

## Road traffic

### Class defaults only

AGEROUTE (Agence des Travaux et de Gestion des Routes) and ANSD publish no open AADT. Fall back to CNOSSOS class defaults with Dakar Tier-1 boost.

### Senegalese AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Autoroute de l'Avenir A1/A2) | 28,000 | 56,000 | 39,200 |
| 1 trunk (RN1 Dakar-Kidira, RN2 Dakar-Saint-Louis) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 1 metro): **Dakar** (~3.5M, far western Atlantic peninsula — Africa's westernmost metropolis, Cap-Vert peninsula has extreme population density on a very confined landform).

**Tier-2 cities** (×1.4, 17 cities): **Touba** (Mouride religious capital, ~800k), Thiès, Kaolack, Saint-Louis (colonial capital), Mbour, Ziguinchor (Casamance), Diourbel, Louga, Tambacounda (eastern gateway), Kolda, Fatick, **Kédougou** (gold-mining region, border with Guinea/Mali), Matam, Sédhiou, Kaffrine, **Richard-Toll** (CSS sugar mill), **Diamniadio** (new administrative capital).

### Senegalese vehicle split

Senegal's urban transport is **dominated by minibuses**, less by motorcycles than Nigeria/Kenya:

- **Cars rapides** — iconic **blue-and-yellow Renault Saviem minibuses** (1960s-70s vintage, classic Dakar icon), being phased out for AFTU modern minibuses
- **Ndiaga Ndiaye** — white Mercedes minibus taxis (larger than cars rapides)
- **Dakar Dem Dikk** — official bus company (Tata/Ashok Leyland)
- **Taxis urbains** — yellow-and-black car taxis, very common in Dakar
- **BRT Dakar** — Bus Rapid Transit, **opened 2024**, 18.3 km corridor (first in West Africa)
- **Motorcycles (Jakarta/Jakartacom)** — moderate share, less than Nigeria/Kenya
- **Charrettes** — horse/donkey carts still common in rural areas

| Tier | Light | Medium (cars rapides/Ndiaga) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Dakar) | 55% | **18%** | 12% | 15% |
| Tier-2 | 58% | 14% | 14% | 14% |
| Rural | 56% | 10% | 24% | 10% |
| **Autoroute de l'Avenir (Dakar↔AIBD)** | 68% | 8% | **18%** | 6% |

### National route network

- **RN1** — Dakar ↔ Kaolack ↔ Tambacounda ↔ Kidira (Mali border) — primary east-west trunk, ~700 km
- **RN2** — Dakar ↔ Thiès ↔ Louga ↔ Saint-Louis ↔ Rosso (Mauritania border) — coastal north
- **RN4** — Kaolack ↔ Mbour coastal
- **RN5** — Ziguinchor ↔ Kolda (Casamance interior)
- **RN6** — Tambacounda ↔ Kédougou (gold corridor to Mali/Guinea border zone)
- **Autoroute de l'Avenir (A1/A2)** — Dakar ↔ Diamniadio ↔ AIBD airport, Senegal's only motorway (~32 km)

## Railway

### Class defaults + corridor bbox boosts

### Senegalese rail context

Senegal's rail network is extremely limited:

- **TER (Train Express Régional)** — **Dakar ↔ Diamniadio ↔ AIBD airport** (36 km, **opened Dec 2021** phase 1 + **AIBD extension 2024**). Senegal's **first modern passenger rail**. Chinese+French built (Alstom Coradia Polyvalent EMU), **standard gauge, electrified, 160 km/h**. Revived a century-old Dakar commuter rail tradition.
- **Dakar-Niger Railway** — built 1923 by French colonial Empire, **meter gauge**, 1,286 km Dakar ↔ Kayes ↔ Bamako (Mali). **Passenger service suspended 2018**. Rehabilitation agreement with China 2021 but not operating. Occasional freight only — Mali's only direct rail sea outlet via Dakar port.
- **ICS phosphate freight spur** — Taïba N'Diaye ↔ Thiès ↔ Mbao port. Industries Chimiques du Sénégal phosphate exports, very limited operation.
- **No metros, no trams, no urban commuter rail outside TER**.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **TER Dakar↔AIBD (2021/2024)** | 30 | 0 |
| **Dakar-Niger main line (defunct)** | 0 | 2 |
| **ICS phosphate spur** | 0 | 3 |
| Other | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 40 plants, 25 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Senegal'`

**Operating fuel** (23 in-bbox after filter): solar 11 + oil/gas 6 + wind 4 + coal 2.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Karpowership Aysegul Sultan** | 235 | oil/gas | **Turkish floating powership** anchored off Dakar — largest single unit in Senegal, emergency power |
| **Sendou** | 125 | coal | Bargny — **Senegal's only coal plant**, controversial community opposition |
| **Malicounda** | 120 | oil/gas | Near Mbour |
| **Tobène** | 115 | oil/gas | Tobène, Thiès region |
| **Bel-Air C6** | 90 | oil/gas | Senelec thermal, Dakar port district |
| **Cap des Biches** | 86 | oil/gas | Senelec diesel, Rufisque |
| **Kounoune** | 68 | oil/gas | IPP, Kounoune |
| **Taiba N'Diaye Wind Farm** | **158** (55+55+48) | wind | **West Africa's largest wind farm** — opened 2020, Lekela, 46× Vestas V126 turbines. Split across 3 GEM entries |
| Léona Wind | 50 | wind | |
| Santhiou Mékhé Solar | 30 | solar | |
| Senergy Solar | 30 | solar | |
| Malicounda Solar | 22 | solar | |

**Taiba N'Diaye Wind Farm** — Senegal's showcase renewable, operational since early 2020. Located in Thiès Region, ~75 km north-east of Dakar. 46 Vestas V126-3.45 MW turbines (3.45 MW × 46 = 158 MW). Lekela Power operated (now Infinity Power), covers ~15% of Senegal's electricity peak demand. **The largest wind farm in West Africa**.

All operating plants map to **NACE 35**.

### Senegal does NOT have

- **No AGEROUTE traffic data** — zero AADT anywhere
- **No TER GTFS** (TER, Dakar-Niger, ICS phosphate)
- **SAR refinery not NACE 19**: Société Africaine de Raffinage, Mbao/Dakar, **27,000 bpd**, Senegal's only oil refinery
- **ICS phosphate complex not NACE 20**: Industries Chimiques du Sénégal, Taïba/Darou Khoudoss — **world-class phosphate reserves**
- **Cement plants not NACE 23**: Ciments du Sahel, SOCOCIM (LafargeHolcim)
- **GTA offshore gas field** (Grand Tortue Ahmeyim) — shared with Mauritania, Eni/BP/Kosmos, **first LNG production 2024**; offshore infrastructure not captured
- **CSS sugar mill** not classified (Compagnie Sucrière Sénégalaise, Richard-Toll)
- **Peanut processing** (Senegal's traditional dominant crop — cargo rail historically transported peanut from the groundnut basin to Dakar)
- **Dakar Port** — West Africa's busiest port after Lagos and Abidjan

## Validation

Senegal implements environmental protection via:

- **DEEC** (Direction de l'Environnement et des Établissements Classés) — EIA and environmental permitting
- **Environmental Code (2001)** — Loi n°2001-01 portant Code de l'Environnement
- Noise standards: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Autoroute de l'Avenir (A1/A2)** Dakar ↔ Diamniadio ↔ AIBD — Senegal's only motorway
- **RN1 Dakar ↔ Tambacounda ↔ Kidira** — primary east-west trunk to Mali
- **RN2 Dakar ↔ Saint-Louis ↔ Rosso** — coastal north to Mauritania
- **Dakar Plateau + Médina + Yoff** — dense urban core of Cap-Vert peninsula
- **TER corridor** (Dakar ↔ Diamniadio ↔ AIBD, opened 2021+2024)
- **BRT Dakar** (18.3 km, opened 2024 — first BRT in West Africa)
- **Blaise Diagne International (DSS/GOBD Dakar-Diass)**, **Saint-Louis (XLS/GOSS)**, **Ziguinchor (ZIG/GOGG)**, **Cap Skirring (CSK/GOGS)**, **Tambacounda (TUD/GOTT)** — covered by global aircraft layer
- **Karpowership Aysegul Sultan** (235 MW floating, Dakar anchorage)
- **Sendou coal plant** (Bargny, 125 MW — Senegal's only coal)
- **Bel-Air + Cap des Biches + Kounoune thermal cluster** Dakar area
- **Taiba N'Diaye Wind Farm** (158 MW, West Africa's largest, Thiès region)
- **SAR refinery Mbao** (27k bpd)
- **ICS phosphate complex** (Taïba/Darou Khoudoss)
- **Ciments du Sahel + SOCOCIM cement plants** (Rufisque/Bargny)
- **Dakar Port** — West Africa's 3rd busiest port
- **CSS sugar mill** (Richard-Toll, Senegal River valley)
