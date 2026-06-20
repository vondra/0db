---
title: Uzbekistan
intro: Noise mapping data sources for Uzbekistan.
map: { center: [64, 41.5], zoom: 5 }
---

## Road traffic

### Class defaults only

No open AADT. Fall back to CNOSSOS class defaults with Tashkent Tier-1 boost. **Chevrolet/Daewoo monoculture**: UzAuto (Asaka) produces ~300k Chevrolet cars/year — extreme import tariffs block virtually all other car brands, so nearly 100% of domestic vehicles are Chevrolet Cobalt/Malibu/Spark/Damas.

### Uzbek AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (M-39 Tashkent↔Samarkand upgrade) | 25,000 | 50,000 | 35,000 |
| 1 trunk | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,400 | 2,800 | 1,960 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Tashkent** (~2.9M — **Central Asia's largest city**, Soviet-era wide boulevards, rapidly modernizing).

**Tier-2 cities** (×1.4): **Samarkand** (~550k, UNESCO Silk Road, **Registan**), **Namangan** (~630k, Ferghana Valley), **Andijan** (~450k, Ferghana Valley), **Bukhara** (~280k, UNESCO Silk Road), Fergana (~310k), **Nukus** (~310k, Karakalpakstan, Aral Sea gateway), Karshi (~280k), Jizzakh, **Navoi** (~170k, gold/industrial), Urgench (~130k, Khorezm).

### Uzbek vehicle split

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Tashkent) | 68% | 8% | 18% | 6% |
| Tier-2 | 65% | 6% | 22% | 7% |
| Rural | 55% | 4% | 35% | 6% |
| **M-39 Silk Road corridor** | 55% | 3% | **38%** | 4% |

## Railway

### Uzbek rail context

**UTY (O'zbekiston Temir Yo'llari)** operates ~6,950 km of **broad gauge (1,520 mm)**. Uzbekistan has Central Asia's most developed rail system with both a metro and high-speed rail — unique in the region.

### Tashkent Metro
- **Opened 1977** — **Central Asia's oldest metro** (predates all other Central Asian metros by decades). Soviet-era ornate stations (comparable to Moscow Metro stations in decoration). **4 lines, ~50 stations, ~70 km** (Chilonzor 1977, O'zbekiston 1984, Yunusobod 2001, Circle line 2020).

### Afrosiyob HSR
- **Tashkent ↔ Samarkand** (2011, 344 km, 2 hours) + **Samarkand ↔ Bukhara** (2016, extension). **Central Asia's first and only high-speed rail**. **Spanish Talgo trains at 250 km/h**. Named after Afrasiab, the mythical Turanian king.

### UTY Conventional
- **Tashkent ↔ Samarkand ↔ Bukhara ↔ Navoi** — Silk Road west corridor
- **Tashkent ↔ Ferghana Valley** — via **Kamchik Pass tunnel** (19.2 km, opened 2016 — **bypasses Tajikistan**, connects Tashkent to Ferghana directly for first time)
- **Tashkent ↔ Nukus/Kungrad** — NW Karakalpakstan corridor
- **Angren ↔ Pap** — new line via Kamchik, opened 2016

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Tashkent Metro (1977)** | 250 | 0 |
| **Afrosiyob HSR** (Tashkent↔Samarkand↔Bukhara) | 8 | 0 |
| **UTY conventional main** | 6 | 12 |
| Other/branch | 2 | 5 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 179 plants, 93 operating, ~21.1 GW

**Operating fuel**: oil/gas **56** + solar 13 + coal 12 + hydropower 10 + wind 2. **Gas-dominant** (Uzbekistan's abundant Gazli/Shurtan/Mubarek natural gas). Rapid renewable buildout 2022-2025 (Saudi ACWA, Masdar, French EDF).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **ACWA Power Sirdarya** | **1,500** | oil/gas CCGT | **Saudi-financed, 2023** — Uzbekistan's newest mega-plant |
| **Talimarjan** | ~1,700 | oil/gas | Kashkadarya (CCGT complex) |
| **Turakurgan** | 900 | oil/gas | Namangan (Ferghana Valley) |
| **Navoi** | ~928 | oil/gas | Navoi Region industrial |
| **Charvak** | **666** | hydropower | **Chirchik-Boz Su cascade** — Uzbekistan's largest hydro |
| **Syrdarya** | 325+ | oil/gas | Sirdarya River |
| **Bash Wind** | 500 | wind | New 2024 |
| **Dzhankeldy Wind** | 500 | wind | New 2024 |
| **Karaulbazar Solar** | 500 | solar | Bukhara Region, new |
| **Nishan Solar** | 500 | solar | Kashkadarya, new |
| **Angren coal** | various | coal | Angren lignite belt (near Tashkent) |

All operating plants map to **NACE 35**.

### Uzbekistan does NOT have

- **No open AADT** — state road authority publishes nothing
- **No UTY GTFS** (timetables are state-controlled)
- **Muruntau gold mine** not NACE 07 — **world's largest open-pit gold mine** (Navoi Mining, state-owned, ~2 Moz/year gold production)
- **Almalyk AGMK** not NACE 07 — **Central Asia's largest copper mine** (copper-gold-molybdenum-zinc complex, state-owned)
- **Bukhara/Ferghana refineries** (BNPZ/FNPZ) not NACE 19
- **Shurtan Gas Chemical Complex** not NACE 20 — gas-to-liquids + polyethylene
- **Kungrad soda ash** (Karakalpakstan) not NACE 20
- **Bekabad steel** (UZMK) not NACE 24
- **Chirchik chemical** (nitrogen fertilizer, WWII-era) not NACE 20
- **Cotton processing** — historically Uzbekistan's main export (forced labor reforms post-2017)
- **Aral Sea crisis** — Nukus/Karakalpakstan, one of world's worst environmental disasters (Soviet irrigation diversion)
- **UzAuto Asaka** — Chevrolet production plant, ~300k cars/year. Not NACE 29

## Validation

Uzbekistan implements environmental protection via:

- **State Committee for Ecology and Environmental Protection**
- **Environmental Protection Law (1992, amended)**
- Noise standards: residential 55/45 dBA day/night

Notable noise zones:

- **Tashkent** — Central Asia's largest city (wide Soviet boulevards + modern construction boom)
- **M-39 Silk Road** (Tashkent↔Samarkand↔Bukhara — Uzbekistan's main corridor)
- **Ferghana Valley** (dense population in the Namangan-Andijan-Fergana triangle)
- **Tashkent Metro** (1977, Central Asia's oldest)
- **Afrosiyob HSR** (250 km/h, Central Asia's only)
- **Islam Karimov International (TAS/UTTT Tashkent)**, **Samarkand (SKD/UTSS)**, **Bukhara (BHK/UTSB)**, **Namangan (NMA/UTFN)**, **Nukus (NCU/UTNN)**, **Fergana (FEG/UTFF)**, **Urgench (UGC/UTNU)**, **Navoi (NVI/UTSN)** — covered by global aircraft layer
- **ACWA Sirdarya CCGT** (1,500 MW)
- **Navoi/Talimarjan gas fleet**
- **Charvak hydro** (666 MW)
- **Muruntau gold mine** (world's largest open-pit)
- **Almalyk copper AGMK**
- **Angren coal belt**
- **UzAuto Asaka** (Chevrolet production — ~300k cars/year)
