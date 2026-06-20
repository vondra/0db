---
title: Kazakhstan
intro: Noise mapping data sources for Kazakhstan.
map: { center: [67, 48], zoom: 4 }
---

## Road traffic

### Class defaults only

KazAvtoyol/MTRDI publishes no open AADT. Fall back to CNOSSOS class defaults with Almaty + Astana dual Tier-1 boost.

### Kazakh AADT defaults

Kazakhstan is the **world's 9th largest country** (2.72M km²) but only ~20M people (7.4/km²). Very sparse outside the Almaty/Astana/Shymkent corridor.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (M-routes upgrading) | 20,000 | 40,000 | 28,000 |
| 1 trunk | 8,000 | 16,000 | 11,200 |
| 2 primary | 4,000 | 8,000 | 5,600 |
| 3 secondary | 2,000 | 4,000 | 2,800 |
| 4 tertiary | 800 | 1,600 | 1,120 |
| 5 residential | 350 | 700 | 490 |

**Tier-1 metros** (×2.0): **Almaty** (~2M — largest city, former capital, Tien Shan foothills) + **Astana** (~1.3M — capital since 1997, renamed Nur-Sultan 2019-2022 then back, futuristic steppe city).

**Tier-2 cities** (×1.4, 14 cities): **Shymkent** (~1.1M, 3rd city, south), Karaganda (~500k, coal/steel), Aktobe (~500k, west), **Atyrau** (~300k, **Caspian oil capital** — Tengiz/Kashagan gateway), **Aktau** (~190k, Caspian port), Pavlodar (~350k, **Ekibastuz coal corridor**), Kostanay, **Ust-Kamenogorsk/Oskemen** (east, Irtysh River), **Semey** (formerly Semipalatinsk — **adjacent to Soviet nuclear test site**), Taraz, Petropavl, **Turkestan** (holy city, Mausoleum of Khoja Ahmed Yasawi), Kyzylorda, Uralsk.

### Kazakh vehicle split

Kazakhstan has **very LOW motorcycle share** (1-4%) — extreme continental climate (-30°C winters in north). **Russian-influenced car culture** (Russian + Japanese imports dominant).

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Almaty/Astana) | 72% | 6% | 18% | 4% |
| Tier-2 | 68% | 5% | 24% | 3% |
| Rural | 55% | 3% | 40% | 2% |
| **Ekibastuz/Caspian oil freight** | 35% | 2% | **62%** | 1% |

### National route network

- **M-39** — Almaty ↔ Shymkent ↔ Tashkent (Uzbekistan border) — silk road south trunk
- **M-36** — Almaty ↔ Karaganda ↔ Astana (~1,300 km — main N-S backbone, being upgraded to motorway)
- **M-38** — Astana ↔ Pavlodar ↔ Semey ↔ Oskemen (east corridor)
- **M-32** — Astana ↔ Kostanay ↔ Russia border (NW corridor)
- **Western Europe – Western China Highway** — Aktobe ↔ Kyzylorda ↔ Shymkent ↔ Almaty ↔ China (transit corridor, partially motorway-grade)

## Railway

### Kazakh rail context

**KTZ (Kazakhstan Temir Zholy / Қазақстан Темір Жолы)** operates **~16,600 km** of **broad gauge (1,520 mm)** — **one of the world's largest rail networks** by length. Soviet-era infrastructure, massive freight capacity (oil, grain, coal, uranium, **China→Europe transit** is growing).

### Almaty Metro
- **Opened December 2011**, 1 line, ~13 km, 11 stations (extended 2015 + 2022)
- Central Asia's **second** metro, after Tashkent (1977)

### Astana LRT
- **Opened May 2026**, 22.4 km, 18 stations — originally planned for EXPO 2017, then repeatedly delayed; driverless airport ↔ city line

### Major rail corridors
- **Almaty ↔ Astana** — ~1,300 km, Kazakhstan's main passenger backbone
- **Trans-Kazakh (east-west)** — Aktau/Atyrau ↔ Aktobe ↔ Astana ↔ Semey ↔ China border. **Critical for China→Europe freight transit** (New Silk Road / BRI rail corridor)
- **Ekibastuz coal corridor** — Pavlodar/Ekibastuz coal trains to all of KZ (Ekibastuz alone handles ~100 Mtpa coal — one of world's heaviest freight corridors)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Almaty Metro (2011)** | 80 | 0 |
| **Astana LRT (2026)** | 50 | 0 |
| **Almaty↔Astana main line** | 8 | 20 |
| **Ekibastuz coal corridor** | 2 | **30** |
| Other (KTZ network, incl. China transit) | 2 | 10 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 356 plants, 201 operating, ~22.6 GW

**Operating fuel**: coal **97** + oil/gas 36 + solar 35 + wind 27 + hydropower 6. **Overwhelmingly coal** — Soviet industrial legacy.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Ekibastuz-1** | **4,000** (8× 500) | coal | **One of the world's largest coal-fired power plants**, Pavlodar Region. Burns Ekibastuz basin coal (low-grade but abundant). Soviet-era, 1980-1981. |
| **Ekibastuz-2** | 1,000 (2× 500) | coal | Same basin, opened 1990 (last unit commissioned in independent KZ) |
| **Aksu (Yermakovskaya)** | ~1,935 | coal | Aksu/Pavlodar — 6 units, large Soviet plant |
| **Shulbi (Upper Irtysh)** | 702 | hydropower | **Irtysh River cascade** — largest hydro in KZ |
| **Bukhtarma** | 675 | hydropower | Irtysh River |
| **Kapshagay** | 364 | hydropower | Ili River near Almaty |
| **Oskemen** | 331 | hydropower | Irtysh River |
| **97 total coal plants** | ~17 GW | coal | Across KZ — coal CHP provides heating for cities in -40°C winters |
| **35 solar + 27 wind** | ~3+ GW | renewable | Recent growth, mostly south/central |

All operating plants map to **NACE 35**.

### Kazakhstan does NOT have

- **No open AADT** — KazAvtoyol publishes nothing
- **No KTZ GTFS**
- **Tengiz oil field** (Chevron/ExxonMobil/KMG/LUKOIL) not NACE 06 — one of world's deepest super-giant fields. CPC pipeline (1,510 km to Novorossiysk, Russia)
- **Kashagan oil field** (NCOC — Shell/TOTAL/ENI/ExxonMobil/KMG/CNPC/Inpex) not NACE 06 — **one of world's largest oil discoveries since 1960s**, $55B development (**world's most expensive oil project**). Caspian Sea offshore.
- **Karachaganak gas** (Shell/ENI) not NACE 06
- **ArcelorMittal Temirtau** (Karaganda) not NACE 24 — Central Asia's largest steelmaker
- **ENRC Kazchrome** (Aktobe) not NACE 24 — **world's largest chromium producer**
- **Kazatomprom uranium** not NACE 07 — **world's #1 uranium producer** (~43% of global, ISL mining in Kyzylkum desert)
- **Ekibastuz coal mine** not NACE 05 — one of world's largest open-pit coal mines (~100 Mtpa)
- **KMGI/PKOP refineries** (Atyrau, Shymkent, Pavlodar) not NACE 19
- **Baikonur Cosmodrome** — world's first + largest spaceport (Russian lease until 2050)

## Validation

Kazakhstan implements environmental protection via:

- **Ministry of Ecology and Natural Resources**
- **Environmental Code of Kazakhstan (2007, updated 2021)**
- Noise standards: residential 55/45 dBA day/night, commercial 65/55, industrial 75/65

Notable noise zones:

- **Almaty** — Tien Shan foothills, traffic noise trapped in valley inversions
- **Astana** — steppe capital, wind-exposed
- **M-36 Almaty↔Astana backbone** (~1,300 km, being upgraded)
- **KTZ main network** (broad gauge, heavy freight)
- **Ekibastuz coal corridor** (30 frt/day — one of world's heaviest)
- **Almaty International (ALA/UAAA)**, **Nursultan Nazarbayev International (TSE/UACC Astana)**, **Shymkent (CIT/UAII)**, **Aktau (SCO/UATE)**, **Atyrau (GUW/UATG)**, **Karaganda (KGF/UAKK)**, **Aktobe (AKX/UATT)** — covered by global aircraft layer
- **Ekibastuz-1 coal** (4,000 MW — one of world's largest)
- **Irtysh River hydro cascade** (Shulbi/Bukhtarma/Oskemen)
- **Tengiz/Kashagan/Karachaganak oil/gas mega-fields**
- **ArcelorMittal Temirtau steel**
- **Baikonur Cosmodrome** (world's first + largest spaceport)
