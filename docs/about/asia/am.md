---
title: Armenia
intro: Noise mapping data sources for Armenia.
map: { center: [44.8, 40], zoom: 7 }
---

## Road traffic

### Class defaults only

Armenia Road Department publishes no open AADT. Fall back to class defaults with Yerevan Tier-1 boost.

### Armenian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (M1/M2 Yerevan bypass) | 25,000 | 50,000 | 35,000 |
| 1 trunk | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,400 | 2,800 | 1,960 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Yerevan** (~1.1M — capital, **~37% of ALL Armenians**, iconic Mt. Ararat view. Extreme capital primacy — one of the highest in the world.)

**Tier-2 cities** (×1.4): **Gyumri** (~120k — 2nd city, **devastated by 1988 M6.8 earthquake**, still recovering), **Vanadzor** (~80k — 3rd city, Soviet chemical industry), **Vagharshapat/Echmiadzin** (~50k — **Holy See of the Armenian Apostolic Church**, world's oldest state religion adopted 301 AD), **Kapan** (~35k, Syunik/Zangezur, copper-molybdenum), Hrazdan, Abovyan, Artashat, Armavir, **Goris** (Syunik — scenic, near Tatev).

### Armenian vehicle split

Post-Soviet car culture, low motorcycle:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Yerevan) | 68% | 8% | 18% | 6% |
| Tier-2 | 65% | 6% | 24% | 5% |
| Rural | 55% | 4% | 37% | 4% |
| **M2 corridor** (Yerevan↔Sevan↔Iran) | 55% | 3% | **38%** | 4% |

## Railway

### Class defaults + corridor bbox boosts

### Armenian rail context

**South Caucasus Railway** (RZHD/Russian Railways subsidiary concession) operates **~780 km** of **broad gauge (1,520 mm)**. **Turkey and Azerbaijan borders are CLOSED since 1993** — no cross-border rail except to Georgia.

### Yerevan Metro
- **Opened 1981** — Soviet-era, **1 line, ~12.5 km, 10 stations**, ~50k daily

### Main line
- **Yerevan ↔ Gyumri ↔ Akhuryan ↔ Georgia border** — only international rail connection

### Sevan branch
- **Yerevan ↔ Lake Sevan** — seasonal tourist + limited freight

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Yerevan Metro (1981)** | 80 | 0 |
| **Main line** (Yerevan↔Gyumri↔Georgia) | 4 | 6 |
| **Sevan branch** | 1 | 2 |
| Other | 1 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 73 plants, 50 operating, ~2.61 GW

**Operating fuel**: solar 38 + hydropower 7 + oil/gas 4 + nuclear 1.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Metsamor (Armenian NPP)** | **448** | nuclear | **Soviet VVER-440** — **only nuclear plant in the Caucasus**. Sits in **seismic zone** (1988 earthquake closed it temporarily). Controversial — EU has urged closure. Provides ~30-40% of Armenia's electricity. |
| **Hrazdan** | 631 (431+200) | oil/gas | Soviet-era thermal, Russian gas |
| **Yerevan 1+2** | 496 (242+254) | oil/gas | Capital thermal |
| **Argel (Vorotan)** | 224 | hydropower | **Vorotan cascade** — one of 3 plants |
| **Shamb (Vorotan)** | 171 | hydropower | |
| **Tatev (Vorotan)** | 157 | hydropower | Near Tatev Monastery (world's longest reversible aerial tramway nearby) |
| **Kanaker** | 102 | hydropower | Hrazdan River, Yerevan area |
| **38 solar plants** | ~180 total | solar | All small (<15 MW), recent growth |

All operating plants map to **NACE 35**.

### Armenia does NOT have

- **No open AADT** — Road Department publishes nothing
- **No South Caucasus Railway GTFS**
- **Zangezur copper-molybdenum** (Kajaran/Kapan) not NACE 07 — one of world's largest Cu-Mo deposits
- **Armenian Molybdenum Production** (Yerevan) not NACE 24
- **Ararat Cement** (old + new plant) not NACE 23
- **Nairit rubber** (Yerevan, Soviet-era, **closed** — former chemical weapons component, environmental legacy)
- **ArArAt brandy** — world-famous (Winston Churchill reportedly preferred it to Cognac)
- **No oil/gas production** — Armenia depends entirely on Russian/Iranian gas imports (pipeline via Georgia)
- **Borders with Turkey + Azerbaijan CLOSED since 1993** — geopolitical isolation limits transit

## Validation

Armenia implements environmental protection via:

- **Ministry of Environment**
- **Law on Environmental Impact Assessment (2014)**
- Noise standards: based on Soviet-era GOST + WHO guidelines

Notable noise zones:

- **Yerevan** — capital, ~37% of all Armenians (extreme primacy)
- **M2 Yerevan↔Sevan highway** (Iran transit freight)
- **Yerevan Metro** (1981, Soviet)
- **Zvartnots International (EVN/UDYZ Yerevan)**, **Gyumri Shirak (LWN/UDSG)** — covered by global aircraft layer
- **Metsamor Nuclear** (448 MW — only nuclear in Caucasus, seismic zone)
- **Hrazdan + Yerevan thermal** (Russian gas)
- **Vorotan hydro cascade** (Tatev/Shamb/Argel)
- **Zangezur copper-molybdenum** (Kajaran mines)
