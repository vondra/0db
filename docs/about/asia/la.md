---
title: Laos
intro: Noise mapping data sources for Laos.
map: { center: [104, 18], zoom: 6 }
---

## Road traffic

### Road defaults

Laos publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Laos's traffic factor **≈ 1.299** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.299 ≈ 38,970 |
| Trunk | 15,000 × 1.299 ≈ 19,485 |
| Primary | 9,000 × 1.299 ≈ 11,691 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **Route 13** — Vientiane ↔ Vang Vieng ↔ Luang Prabang (north) + Vientiane ↔ Thakhek ↔ Savannakhet ↔ Pakse (south) — **Laos's backbone**, ~1,400 km along the Mekong
- **VTE-Vang Vieng Expressway** — 113 km (2020, Chinese-built, **Laos's first motorway**)
- **Route 1** — Vientiane ↔ Xam Neua (NE, Vietnamese border)
- **Route 3** — Luang Namtha ↔ Boten ↔ China (parallel to LCR, N trade route)
- **Route 12/8** — Thakhek ↔ Vietnamese border (Lak Sao → Cau Treo)

## Railway

### CNOSSOS class defaults

No Lao rail enricher runs (LCR timetables are published only by the operator, not as GTFS), so rail noise uses the engine's CNOSSOS class defaults by OSM rail type — mainline heavy rail at 80 passenger + 20 freight trains/day. The LCR is documented below as context.

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

The LCR runs roughly 13 passenger train pairs/day plus freight — below the class-default 80 pax/day, so the model overstates LCR rail noise somewhat.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 124 plants, 58 operating, ~11.7 GW

Power-plant points from **GEM Global Integrated Power** (filtered to `Country_area='Laos'`, operating only) are spatial-joined to OSM industrial polygons, overriding the lower-priority global GPPD baseline.

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

### Not captured / context

- **No open AADT** — MPWT is a state ministry with no public GIS; roads use CNOSSOS class defaults
- **No railway GTFS** — LCR timetables are published only by the operator; rail uses CNOSSOS class defaults
- **Phu Bia Mining gold/copper/silver** (Xaysomboun Province) — captured only as OSM `landuse=industrial` (not a power plant)
- **Sepon gold/copper** (Savannakhet) — still operating as LXML after MMG sold its stake to Chifeng Jilong Gold (2019); captured only as OSM `landuse=industrial`
- **Lao Cement** (state) — captured globally only if matched by the GEM Cement tracker above its capacity threshold, else as OSM `landuse=industrial`
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
