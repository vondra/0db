---
title: Senegal
intro: Noise mapping data sources for Senegal.
map: { center: [-14.5, 14.5], zoom: 6 }
---

## Road traffic

### Road defaults

Senegal publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Senegal's traffic factor **≈ 1.078** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.078 ≈ 32,340 |
| Trunk | 15,000 × 1.078 ≈ 16,170 |
| Primary | 9,000 × 1.078 ≈ 9,702 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **RN1** — Dakar ↔ Kaolack ↔ Tambacounda ↔ Kidira (Mali border) — primary east-west trunk, ~700 km
- **RN2** — Dakar ↔ Thiès ↔ Louga ↔ Saint-Louis ↔ Rosso (Mauritania border) — coastal north
- **RN4** — Kaolack ↔ Mbour coastal
- **RN5** — Ziguinchor ↔ Kolda (Casamance interior)
- **RN6** — Tambacounda ↔ Kédougou (gold corridor to Mali/Guinea border zone)
- **Autoroute de l'Avenir (A1/A2)** — Dakar ↔ Diamniadio ↔ AIBD airport, Senegal's only motorway (~32 km)

## Railway

### Senegalese rail context

Senegal's rail network is extremely limited:

- **TER (Train Express Régional)** — **Dakar ↔ Diamniadio ↔ AIBD airport** (36 km, **opened Dec 2021** phase 1 + **AIBD extension 2024**). Senegal's **first modern passenger rail**. Chinese+French built (Alstom Coradia Polyvalent EMU), **standard gauge, electrified, 160 km/h**. Revived a century-old Dakar commuter rail tradition.
- **Dakar-Niger Railway** — built 1923 by French colonial Empire, **meter gauge**, 1,286 km Dakar ↔ Kayes ↔ Bamako (Mali). **Passenger service suspended 2018**. Rehabilitation agreement with China 2021 but not operating. Occasional freight only — Mali's only direct rail sea outlet via Dakar port.
- **ICS phosphate freight spur** — Taïba N'Diaye ↔ Thiès ↔ Mbao port. Industries Chimiques du Sénégal phosphate exports, very limited operation.
- **No metros, no trams, no urban commuter rail outside TER**.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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
- **Dakar Port** — one of West Africa's major ports (Mali's main maritime gateway via the Dakar-Niger corridor)

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
- **BRT Dakar** (18.3 km, opened 2024 — first all-electric BRT in sub-Saharan Africa)
- **Blaise Diagne International (DSS/GOBD Dakar-Diass)**, **Saint-Louis (XLS/GOSS)**, **Ziguinchor (ZIG/GOGG)**, **Cap Skirring (CSK/GOGS)**, **Tambacounda (TUD/GOTT)** — covered by global aircraft layer
- **Karpowership Aysegul Sultan** (235 MW floating, Dakar anchorage)
- **Sendou coal plant** (Bargny, 125 MW — Senegal's only coal)
- **Bel-Air + Cap des Biches + Kounoune thermal cluster** Dakar area
- **Taiba N'Diaye Wind Farm** (158 MW, West Africa's largest, Thiès region)
- **SAR refinery Mbao** (27k bpd)
- **ICS phosphate complex** (Taïba/Darou Khoudoss)
- **Ciments du Sahel + SOCOCIM cement plants** (Rufisque/Bargny)
- **Dakar Port** — major West African port
- **CSS sugar mill** (Richard-Toll, Senegal River valley)
