---
title: Pakistan
intro: Noise mapping data sources for Pakistan.
map: { center: [69, 30], zoom: 5 }
---

## Road traffic

### Class defaults only

NHA (National Highway Authority) publishes no open GIS. Fall back to CNOSSOS class defaults with Karachi/Lahore ×2.5 megacity boost.

### Pakistani AADT defaults

Pakistan is the **5th most populous country in the world** (~240M). Extreme traffic density in Punjab and Sindh. **M1/M2 Lahore↔Islamabad Motorway** is Pakistan's flagship toll motorway.

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.6) | Tier-3 (×1.3) |
|---|---:|---:|---:|---:|
| 0 motorway (M1/M2/M9) | 45,000 | 112,500 | 72,000 | 58,500 |
| 1 trunk (N-routes / GT Road) | 18,000 | 45,000 | 28,800 | 23,400 |
| 2 primary | 10,000 | 25,000 | 16,000 | 13,000 |
| 3 secondary | 5,000 | 12,500 | 8,000 | 6,500 |
| 4 tertiary | 2,500 | 6,250 | 4,000 | 3,250 |
| 5 residential | 1,000 | 2,500 | 1,600 | 1,300 |

**Tier-1 megacities** (×2.5): **Karachi** (~16M metro — Pakistan's largest city, Sindh capital, major port) + **Lahore** (~13M metro — Punjab capital, cultural capital, walled city).

**Tier-2 cities** (×1.6): Faisalabad ("Manchester of Pakistan", ~3.5M, textile capital), Rawalpindi (~2.1M, Islamabad twin city), Multan (~2M), Hyderabad Sindh (~2M), Peshawar (~2M, Khyber Pakhtunkhwa capital), Islamabad (~1.2M, federal capital).

**Tier-3 cities** (×1.3): Quetta, Sialkot, Gujranwala, Bahawalpur, Sargodha, Sukkur, Larkana, Mardan, Abbottabad, Dera Ghazi Khan, Sahiwal, Okara, Jhang, Gujrat, Kasur.

### Pakistani vehicle split

Pakistan has **extreme motorcycle + rickshaw dominance**:

- **Motorcycles** — **Pakistan has one of world's highest motorcycle densities** (~30% of urban traffic). Honda CD70/CG125 ubiquitous.
- **Rickshaws (auto-rickshaws)** — Qingqi (Chinese 3-wheelers), classic green rickshaws (Karachi), Chingchi rickshaws (informal). Classified as CNOSSOS "medium".
- **Suzuki Carry / Hiace** — minibuses/vans for urban public transport
- **Heavy trucks** — decorated "jingle trucks" (unique Pakistani aesthetic), **dominant on N5 Grand Trunk Road** (40% heavy share)
- **Buses**: Daewoo Express, Faisal Movers (intercity). BRT: **Islamabad Metrobus**, **Lahore Metrobus**, **Karachi Green Line BRT**

| Tier | Light | Medium (rickshaw) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Karachi/Lahore) | 38% | 15% | 17% | **30%** |
| Tier-2/3 | 45% | 12% | 15% | **28%** |
| Rural | 35% | 8% | 35% | 22% |
| **M1/M2 motorway** | 65% | 5% | **26%** | 4% |
| **N5 Grand Trunk Road** | 40% | 8% | **40%** | 12% |

### National route network

- **N5 / Grand Trunk Road** — Karachi ↔ Hyderabad ↔ Sukkur ↔ Multan ↔ Lahore ↔ Rawalpindi ↔ Peshawar (~1,700 km — **one of Asia's oldest roads**, Maurya Empire 3rd century BC → Sher Shah Suri 1540s → British era → present)
- **M1/M2 Motorway** — Peshawar ↔ Islamabad ↔ Lahore (~365 km, Pakistan's flagship toll motorway)
- **M9 Motorway** — Karachi ↔ Hyderabad (~136 km)
- **N25** — Karachi ↔ Quetta ↔ Chaman (Afghan border via Bolan Pass)
- **N35 Karakoram Highway (KKH)** — Islamabad ↔ Gilgit ↔ Khunjerab Pass (China border) — **world's highest paved international border crossing** (4,693m)

## Railway

### Class defaults + corridor bbox boosts

### Pakistani rail context

**Pakistan Railways** operates ~7,791 km of **broad gauge (1,676 mm)** — one of Asia's oldest railway systems (British colonial, first line Karachi↔Kotri 1861). Heavy passenger usage despite aging infrastructure.

### ML-1 Main Line (backbone)
- **Karachi ↔ Hyderabad ↔ Sukkur ↔ Multan ↔ Lahore ↔ Rawalpindi ↔ Peshawar** — ~1,700 km.
- **Pakistan's most important railway corridor**, parallel to N5 Grand Trunk Road.
- Carries ~100+ trains/day at peak (30+ named express services: Karakoram Express, Tezgam, Green Line, Shalimar Express, etc.)
- **ML-1 upgrade ($6.8B CPEC project)** — planned speed upgrade 120→160 km/h, double-tracking

### Lahore Orange Line Metro
- **Opened October 2020** — **Pakistan's first metro** (27 km, 26 stations, elevated, Chinese-built NORINCO/CRRC, $1.6B CPEC project)
- Lahore's dense urban corridor (Ali Town ↔ Dera Gujran)

### Quetta Branch
- **Sukkur ↔ Sibi ↔ Quetta ↔ Chaman** (Afghan border) — dramatic **Bolan Pass** engineering (1880s British)
- Also: **Quetta ↔ Taftan** (Iran border)

### Other branches
- **Lahore ↔ Faisalabad ↔ Sargodha**
- **Lahore ↔ Sialkot ↔ Narowal**
- **Rawalpindi ↔ Kohat ↔ Bannu** (KP)
- **Hyderabad ↔ Mirpur Khas ↔ Khokhrapar** (India border, Thar Express)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Lahore Orange Line Metro (2020)** | 200 | 0 |
| **ML-1 Main Line** (Karachi↔Lahore↔Peshawar) | 25 | 15 |
| **Quetta branch** (Bolan Pass) | 2 | 5 |
| Other/branch | 2 | 3 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 432 plants, 203 operating, ~46.3 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Pakistan'`

**Operating fuel**: oil/gas 60 + solar 57 + wind 36 + coal 21 + hydropower 18 + nuclear 6 + bioenergy 5.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Tarbela Dam** | **4,888** (3,478+1,410) | hydropower | **Indus River** — **one of world's largest earth-fill dams** (1976 + 4th Extension 2018). Pakistan's single largest power source. |
| **Ghazi Barotha** | 1,450 | hydropower | Indus canal, 2003 |
| **Balloki** | 1,320 | oil/gas RLNG | Punjab — CPEC-era RLNG CCGT |
| **Trimmu** | 1,263 | oil/gas RLNG | Punjab — CPEC |
| **HBS (Haveli Bahadur Shah)** | 1,230 | oil/gas RLNG | Punjab — CPEC |
| **Bhikki** | 1,180 | oil/gas RLNG | Punjab — CPEC. Total Punjab RLNG cluster ~5,000 MW |
| **Karachi Nuclear (KANUPP-2+3)** | **2,200** (2× 1,100) | nuclear | **Hualong One Chinese-built** — Pakistan's largest nuclear units (the four Chashma CNP-300 reactors are the other operating fleet). KANUPP-1 (1972, Canadian CANDU) decommissioned 2021. |
| **Mangla Dam** | 1,070 | hydropower | Jhelum River, 1967 (British-era design, raised 2009) |
| **Neelum-Jhelum** | 969 | hydropower | AJK, opened 2018 — controversial water dispute with India |
| **Suki Kinari** | 884 | hydropower | KP, opened 2024 — CPEC Chinese-built |
| **Karot** | 720 | hydropower | Jhelum, opened 2022 — **China Three Gorges CPEC project** |
| **Hubco coal** | 1,320 (2× 660) | coal | Balochistan coast (Hub) |
| **Port Qasim coal** | 1,980 (3× 660) | coal | Karachi — CPEC Chinese |
| **Sahiwal coal** | 1,320 | coal | Punjab — CPEC |
| **Thar coal** (multiple) | various | coal | Sindh Thar Desert — indigenous lignite |
| **Jhimpir/Gharo Wind** | 36 plants | wind | Sindh coast — **Pakistan's main wind corridor** |
| **57 solar plants** | various | solar | Punjab + Sindh |

All operating plants map to **NACE 35**.

### Pakistan does NOT have

- **No NHA AADT** — zero open traffic data
- **No Pakistan Railways GTFS** — all timetables are PDF/HTML
- **Pakistan Steel Mills** (Karachi) not NACE 24 — **defunct since 2015** (world's largest idle industrial asset, ~1 Mtpa capacity, ~20,000 employees unpaid for years)
- **Textile mills**: **Faisalabad** "Manchester of Pakistan" — world's #4 textile exporter. Not NACE 13
- **Cement**: Lucky Cement, DG Khan Cement, Bestway, Fauji, Maple Leaf — not NACE 23. Pakistan is world's 7th largest cement producer
- **Oil refineries**: PRL Karachi, ARL Rawalpindi, NRL — not NACE 19
- **CPEC special economic zones**: multiple planned but not all operational
- **Gwadar Port** — CPEC flagship deep-water port (Balochistan), Chinese-operated. Not flagged

## Validation

Pakistan implements environmental protection via:

- **Pakistan EPA** (Environmental Protection Agency) — federal + provincial
- **Pakistan Environmental Protection Act 1997**
- **NEQS** (National Environmental Quality Standards) — including noise
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 75/65

Notable noise zones:

- **N5 Grand Trunk Road** — Karachi↔Lahore↔Peshawar (one of Asia's oldest and busiest roads)
- **M1/M2 Motorway** — Peshawar↔Islamabad↔Lahore
- **M9 Motorway** — Karachi↔Hyderabad
- **N35 Karakoram Highway** — Islamabad↔China (world's highest paved intl border crossing)
- **Karachi** + **Lahore** megacity dense cores (×2.5 multiplier)
- **Pakistan Railways ML-1** (Karachi↔Peshawar, ~100 trains/day at peak)
- **Lahore Orange Line Metro** (Pakistan's first metro, 2020)
- **Jinnah International (KHI/OPKC Karachi)**, **Allama Iqbal (LHE/OPLA Lahore)**, **Islamabad (ISB/OPIS)**, **Peshawar (PEW/OPPS)**, **Quetta (UET/OPQT)**, **Faisalabad (LYP/OPFA)**, **Multan (MUX/OPMF)**, **Sialkot (SKT/OPST)** — covered by global aircraft layer
- **Tarbela Dam** (Indus, 4,888 MW — one of world's largest earth-fill dams)
- **Ghazi Barotha** (1,450 MW) + **Mangla** (1,070 MW) + **Neelum-Jhelum** (969 MW)
- **KANUPP Karachi nuclear** (2,200 MW Hualong One)
- **Punjab RLNG cluster** (Balloki/Trimmu/HBS/Bhikki ~5,000 MW)
- **Port Qasim / Hubco / Sahiwal coal** (CPEC projects)
- **Jhimpir/Gharo wind corridor** (Sindh coast)
- **Pakistan Steel Mills** (defunct since 2015)
- **Faisalabad textile mills**
- **Gwadar Port** (CPEC flagship)
