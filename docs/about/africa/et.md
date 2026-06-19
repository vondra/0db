---
title: Ethiopia
intro: Noise mapping data sources for Ethiopia.
map: { center: [40, 9], zoom: 5 }
---

## Road traffic

### Class defaults only

Ethiopian Roads Authority (ERA) publishes no open GIS. CNOSSOS class defaults with Addis Ababa Tier-1 boost.

### Ethiopian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Addis-Adama Expressway, Ring Road) | 30,000 | 60,000 | 42,000 |
| 1 trunk (A-route paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0): **Addis Ababa** (~5M, 2,350 m — Africa's highest major capital).

**Tier-2 cities** (×1.4, 18 cities): Dire Dawa, Mekelle, Gondar, Bahir Dar, Hawassa, Adama, Dessie, Jimma, Dilla, Debre Markos, Debre Birhan, Shashamane, Assela, Nekemte, Kombolcha, Harar, Arba Minch, Wukro.

### Ethiopian vehicle split

Distinctive **blue-and-white minibus taxis** (15% urban) + **Bajaj tuktuks** (13% moto). Lower motorcycle share than Kenya/Nigeria.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Addis Ababa) | 60% | 15% | 12% | 13% |
| Tier-2 | 62% | 12% | 14% | 12% |
| Rural | 58% | 10% | 24% | 8% |
| **Addis-Djibouti container corridor** | **40%** | 8% | **45%** | 7% |

### National route network

- **A1** — Addis ↔ Dire Dawa ↔ Djibouti (main sea outlet for landlocked Ethiopia)
- **A2** — Addis ↔ Gondar ↔ Metema (Sudan border)
- **A3** — Addis ↔ Adama ↔ Awassa ↔ Moyale (Kenya border)
- **A4** — Adama ↔ Jimma ↔ South Sudan
- **A5** — Addis ↔ Nekemte ↔ Assosa
- **A6** — Addis ↔ Dessie ↔ Mekelle ↔ Adigrat (Eritrea border)
- **Addis-Adama Expressway** — Ethiopia's first 6-lane expressway (85 km, 2014, Chinese-built)

## Railway

### Class defaults + corridor bbox boosts

### Ethiopian rail context

- **Addis-Djibouti Railway (EDR)** — **752 km electrified standard gauge** (25 kV AC), opened January 2018. **Africa's first fully electrified international cross-border railway.** Built by CCCC + CREC for US$4 billion. Addis ↔ Dire Dawa ↔ Djibouti Port (Doraleh).
- **Awash-Kombolcha-Weldiya Railway (AKR)** — 390 km standard gauge, partially opened 2022+
- **Addis Ababa Light Rail Transit (AALRT)** — **Africa's first light rail metro**, opened September 2015. 2 lines (East-West + North-South), ~32 km
- **No other operational rail** — colonial metre-gauge Ethio-Djibouti dismantled by 2017

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Addis-Djibouti EDR (2018, electrified)** | 4 | 16 |
| **Awash-Weldiya AKR** | 2 | 8 |
| **Addis Ababa LRT (Africa's first)** | 200 | 0 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 90 plants, 25 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Ethiopia'`

**Operating fuel**: hydropower 12 + wind 7 + bioenergy 5 + solar 1.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Gilgel Gibe III** | 1,870 | hydropower | Omo River, 2016. Africa's tallest RCC dam (243 m) |
| **GERD (partial)** | 750 | hydropower | Blue Nile — 2 of 13 turbines operational 2022-23; full 5,700 MW under construction |
| **Beles (Tana-Beles)** | 460 | hydropower | Blue Nile basin |
| **Gilgel Gibe II** | 420 | hydropower | Omo River (2010) |
| **Tekeze** | 300 | hydropower | Tigray, Tekeze River |
| **Adama I+II Wind** | 204 | wind | Adama/Nazret |
| **Gilgel Gibe I** | 184 | hydropower | Omo River (2004) |
| **Melka Wakana** | 153 | hydropower | Wabe Shebelle |
| **Finchaa** | 134 | hydropower | Blue Nile basin |
| **Ashegoda Wind** | 120 | wind | Tigray — Ethiopia's first commercial wind farm (2013) |
| **Aysha Wind** | 120 | wind | Somali Region |

**Grand Ethiopian Renaissance Dam (GERD)** — under construction on the Blue Nile near Sudan border. When complete at **5,700 MW**, GERD will be **Africa's largest power plant by installed capacity**, surpassing Inga DRC, Aswan, and Tanzania's Julius Nyerere. First 2 turbines (375 MW each) commissioned February 2022; full completion expected 2024-2025. Controversial — downstream water-flow concerns from Sudan and Egypt.

**Gilgel Gibe III** — **Africa's tallest RCC dam** at 243 m. Commissioned 2016 with controversial impact on Lake Turkana downstream in Kenya.

All operating plants map to **NACE 35**.

### Ethiopia does NOT have

- **No TPDA/AADT**
- **No rail GTFS**
- **GERD full capacity** — only 750 of 5,700 MW currently operational
- **Cement plants not classified**: Dangote Mugher, Habesha, Messebo, National Cement
- **Sugar factories not classified**: Metahara, Wonji-Shoa, Fincha, Tendaho (EIH)
- **Industrial parks not classified**: Hawassa, Bole Lemi, Bomboloi (Chinese-built textile + leather parks)
- **No oil refinery** — Assab closed 1997 during Eritrean independence

## Validation

Ethiopia implements noise regulation via:

- **EPA Ethiopia** / Ministry of Environment (MoEP/FDRE)
- **Environmental Pollution Control Proclamation No. 300/2002**
- **Environmental Noise Standard (ES 3985:2009)** — residential 55/40, commercial 65/50, industrial 75/65

Notable noise zones:

- **Addis-Adama Expressway** — first 6-lane expressway, 85 km
- **Addis Ababa Ring Road** — 3 phases
- **A1 Addis ↔ Djibouti** — main freight corridor (container traffic to/from Djibouti port)
- **Churchill Avenue, Bole Road, Ras Mekonnen Ave** Addis arterials
- **Addis-Djibouti EDR** — Africa's first electrified international railway
- **Addis Ababa LRT Lines 1+2** — Africa's first light rail metro (2015)
- **Bole International (ADD/HAAB Addis Ababa)**, **Dire Dawa (DIR/HADR)**, **Mekelle (MQX/HAMK)**, **Aksum (AXU/HAAX)**, **Bahir Dar (BJR/HABD)**, **Gondar (GDQ/HAGN)**, **Jimma (JIM/HAJM)**, **Hawassa (AWA/HAAW)** — covered by global aircraft layer
- **GERD Grand Ethiopian Renaissance Dam** (Blue Nile, when complete 5,700 MW = Africa's largest)
- **Gilgel Gibe III Dam** (Omo River, 1,870 MW, Africa's tallest RCC dam)
- **Gilgel Gibe I + II + Beles + Tekeze + Finchaa hydros**
- **Adama + Ashegoda + Aysha wind farms**
- **Hawassa Industrial Park** — Chinese-built textile/apparel zone
- **Bole Lemi Industrial Park + Bomboloi IP** Addis
- **Mugher Cement** (Dangote) + Messebo Cement Tigray
- **Djibouti Port + Doraleh Container Terminal** (Ethiopian imports outlet)
