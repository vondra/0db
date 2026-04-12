---
title: Laos
intro: Noise mapping data sources for Laos.
map: { center: [104, 18], zoom: 6 }
---

## Road traffic

### Class defaults only

MPWT publishes no open GIS. Fall back to CNOSSOS class defaults with Vientiane Tier-1 boost.

### Lao AADT defaults

Laos is **landlocked and mountainous** with a sparse road network. Very low traffic baseline outside Vientiane and Route 13.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (VTE-Vang Vieng Expressway 2020) | 20,000 | 40,000 | 28,000 |
| 1 trunk (Route 13 backbone) | 8,000 | 16,000 | 11,200 |
| 2 primary | 4,000 | 8,000 | 5,600 |
| 3 secondary | 2,000 | 4,000 | 2,800 |
| 4 tertiary | 1,000 | 2,000 | 1,400 |
| 5 residential | 400 | 800 | 560 |

**Tier-1 metro** (×2.0): **Vientiane** (~800k — **one of SE Asia's smallest capitals**, low traffic by regional standards, relaxed pace).

**Tier-2 cities** (×1.4): **Luang Prabang** (~90k, UNESCO World Heritage, tourism + **LCR stop** — tourism boom post-2021 railway), **Savannakhet** (~120k, central Mekong, largest city), **Pakse** (~90k, Champasak southern hub), Thakhek, **Vang Vieng** (tourism boom post-LCR), **Boten** (China border, LCR terminus — transformed by Chinese investment), Luang Namtha, Phonsavan, Xam Neua.

### Lao vehicle split

High motorcycle share (40-47%) — similar to Cambodia:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Vientiane) | 38% | 10% | 12% | **40%** |
| Tier-2 | 30% | 8% | 15% | **47%** |
| Rural | 25% | 5% | 25% | **45%** |
| **VTE-VV Expressway (2020)** | 55% | 5% | **35%** | 5% |

### National route network

- **Route 13** — Vientiane ↔ Vang Vieng ↔ Luang Prabang (north) + Vientiane ↔ Thakhek ↔ Savannakhet ↔ Pakse (south) — **Laos's backbone**, ~1,400 km along the Mekong
- **VTE-Vang Vieng Expressway** — 113 km (2020, Chinese-built, **Laos's first motorway**)
- **Route 1** — Vientiane ↔ Xam Neua (NE, Vietnamese border)
- **Route 3** — Luang Namtha ↔ Boten ↔ China (parallel to LCR, N trade route)
- **Route 12/8** — Thakhek ↔ Vietnamese border (Lak Sao → Cau Treo)

## Railway

### Class defaults + corridor bbox boosts

### Lao rail context

**Before December 2021, Laos had effectively NO railway** — just a tiny 3.5 km stub connecting Thailand's Nong Khai to Tha Naleng (built 2009, mainly symbolic).

### Laos-China Railway (LCR) — Belt and Road flagship
- **Opened December 2021** — **422 km Vientiane ↔ Luang Prabang ↔ Boten (China border)**
- **Standard gauge (1,435 mm), 160 km/h, $6 billion** — Chinese-built by CREC, financed by China Exim Bank
- Continues into China as **Kunming ↔ Mohan** (Yunnan, connects to Chinese HSR network)
- **Belt and Road's FLAGSHIP completed rail project** — transforms landlocked Laos from "landlocked to land-linked"
- **20+ million passengers in first 2 years** (2022-2023)
- Vientiane ↔ Luang Prabang in 2 hours (vs 10+ hours by road before)
- **13 passenger train pairs per day** (2024 schedule)
- Key stations: Vientiane, Vang Vieng, Luang Prabang, Luang Namtha, Boten

**No metros, no trams, no urban rail**.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Laos-China Railway (LCR, 2021)** | 20 | 10 |
| Other (Tha Naleng 3.5 km stub) | 0 | 0 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 124 plants, 58 operating, ~11.7 GW

**Operating fuel**: hydropower **44** + solar 11 + coal 3. **Laos is the "Battery of Southeast Asia"** — massive hydro cascade, mostly exporting electricity to Thailand, Vietnam, and Cambodia.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Xayaburi** | **1,285** | hydropower | **First lower Mekong mainstream dam** (2019) — controversial, changes downstream flow for Cambodia/Vietnam |
| **Nam Theun 2** | 1,070 | hydropower | World Bank flagship (2010), Nakai Plateau. Exports 95% to Thailand |
| **Nam Theun 1** | 650 | hydropower | |
| **Hongsa** | **1,878** (3× 626) | coal (lignite) | **One of SE Asia's largest coal plants** — Thai-backed (Ratchaburi/BANPU/LHSE), exports all power to Thailand |
| **Nam Ngum 2** | 615 | hydropower | |
| **Theun Hinboun** | 440 | hydropower | |
| **Xe Pian Xe Namnoy** | 410 | hydropower | **Saddle dam collapsed July 2018** killing 71+ people — one of the worst dam disasters in SE Asia |
| **Don Sahong** | 260 | hydropower | 2nd Mekong mainstream dam (controversial — blocks critical fish migration at Khone Falls) |
| **Xekaman 1** | 322 | hydropower | |
| **Nam Ngiep 1** | 290 | hydropower | |
| **Nam Ngum 1** | 275 | hydropower | Laos's oldest major dam (1971) |
| **11 solar plants** | ~400+ total | solar | Recent |

All operating plants map to **NACE 35**.

### Laos does NOT have

- **No open AADT** — MPWT is a state ministry with no public GIS
- **No railway GTFS** (LCR timetables published by Laos-China Railway Company)
- **Phu Bia Mining gold/copper/silver** (Xaysomboun Province) — not NACE 07
- **Sepon gold/copper** (Savannakhet, MMG Chinese-owned — **closed 2024** after resource depletion)
- **Lao Cement** (state) — not NACE 23
- **No oil/gas industry** — Laos is landlocked and has no hydrocarbons
- **Beerlao** (Lao Brewery, Carlsberg JV) — Laos's most famous brand
- **Garment factories** (Vientiane) — small-scale compared to Cambodia/Bangladesh

## Validation

Laos implements environmental protection via:

- **MONRE** (Ministry of Natural Resources and Environment)
- **Environmental Protection Law (2012)**
- Noise standards: minimal, poorly enforced
- **Mekong River Commission** monitors transboundary impacts of Lao dams

Notable noise zones:

- **Route 13** (Laos's north-south backbone along Mekong)
- **VTE-Vang Vieng Expressway** (2020, Laos's first motorway)
- **Vientiane** — capital core along Mekong
- **Laos-China Railway (2021)** — Vientiane↔Luang Prabang↔Boten
- **Wattay International (VTE/VLVT Vientiane)**, **Luang Prabang (LPQ/VLLB)**, **Pakse (PKZ/VLPS)**, **Savannakhet (ZVK/VLSK)** — covered by global aircraft layer
- **Hongsa coal** (1,878 MW — one of SE Asia's largest)
- **Xayaburi hydro** (1,285 MW — first lower Mekong mainstream)
- **Nam Theun 2** (1,070 MW — World Bank flagship)
- **Boten border zone** (China trade/LCR terminus)
