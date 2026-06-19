---
title: Georgia
intro: Noise mapping data sources for Georgia.
map: { center: [43.5, 42], zoom: 7 }
---

## Road traffic

### Class defaults only

Roads Department of Georgia publishes no open AADT. Fall back to class defaults with Tbilisi Tier-1 boost.

### Georgian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (E60 Tbilisi bypass) | 28,000 | 56,000 | 39,200 |
| 1 trunk (E60/E70) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,400 | 2,800 | 1,960 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Tbilisi** (~1.2M — capital, Mtkvari/Kura River valley, unique old town with sulfur baths, rapidly modernizing).

**Tier-2 cities** (×1.4): **Batumi** (~170k, Black Sea resort + port — major tourism + casino hub), **Kutaisi** (~140k, Georgia's 2nd city, Rioni Valley, low-cost Wizz Air hub), **Rustavi** (~130k, Tbilisi industrial satellite, Soviet-era steel), **Zugdidi** (~70k, Mingrelia, Abkhazia/Enguri Dam gateway), **Gori** (~50k, Stalin's birthplace), **Poti** (~40k, Black Sea port + free industrial zone), Telavi, Ozurgeti, Akhaltsikhe.

### Georgian vehicle split

Moderate, European-influenced (EU candidate):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Tbilisi) | 65% | 10% | 18% | 7% |
| Tier-2 | 62% | 8% | 24% | 6% |
| Rural | 55% | 5% | 35% | 5% |
| **E60 corridor** (Tbilisi↔Kutaisi↔Batumi) | 60% | 4% | **32%** | 4% |

### National route network

- **E60** — Tbilisi ↔ Gori ↔ Khashuri ↔ Kutaisi ↔ Samtredia ↔ Batumi/Poti — **Georgia's east-west backbone** (Rikoti Pass tunnel under reconstruction — $1B project)
- **E70** — Tbilisi ↔ Rustavi ↔ Azerbaijan border (east, Baku connection)
- **Georgian Military Highway** — Tbilisi ↔ Kazbegi ↔ Russia (Dariali Gorge — one of world's most dramatic mountain roads, seasonal closures)
- **S1** — Tbilisi ↔ Batumi via Akhaltsikhe (southern route, bypasses Rikoti)

## Railway

### Class defaults + corridor bbox boosts

### Georgian rail context

**Georgian Railway** operates ~1,600 km of **broad gauge (1,520 mm)** — Soviet-era infrastructure.

### Tbilisi Metro
- **Opened 1966** — Soviet-era, **2 lines, ~28 km, 23 stations**, ~500k daily riders

### Main east-west line
- **Tbilisi ↔ Gori ↔ Zestaponi ↔ Samtredia ↔ Batumi/Poti** — Georgia's rail backbone. Carries oil/manganese freight to Black Sea ports.

### Other branches
- **Tbilisi ↔ Azerbaijan** (Kakheti east)
- **Samtredia ↔ Zugdidi** (Mingrelia, near Abkhazia)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Tbilisi Metro (1966)** | 150 | 0 |
| **Main line** (Tbilisi↔Kutaisi↔Batumi/Poti) | 6 | 10 |
| Other/branch | 2 | 3 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 60 plants, 27 operating, ~4.06 GW

**Operating fuel**: hydropower 19 + oil/gas 7 + wind 1. **~80% hydro generation**.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Enguri** | **1,300** | hydropower | **One of world's tallest arch dams (272m)**, on de facto Abkhazia border. Georgia's largest plant. |
| **Tbilsresi** | 572 (300+142+130) | oil/gas | Tbilisi thermal — Azerbaijan piped gas |
| **Gardabani CCGT** | 485 (255+230) | oil/gas | Near Azerbaijan border, CCGT |
| **Vardnili-1** | 220 | hydropower | Enguri cascade lower |
| **Shuakhevi** | 179 | hydropower | Adjara (Batumi hinterland) |
| **Zhinvali** | 130 | hydropower | North of Tbilisi, Aragvi River |
| **Khrami I + II** | 224 | hydropower | South of Tbilisi |
| **Lajanuri** | 112 | hydropower | |
| **Dariali** | 108 | hydropower | Near Georgian Military Highway |

All operating plants map to **NACE 35**.

### Georgia does NOT have

- **No open AADT** — Roads Department publishes nothing
- **No Georgian Railway GTFS**
- **Rustavi Metallurgical Plant** not NACE 24 — Soviet-era steel, declining
- **Zestaponi Ferroalloy** (Georgian Manganese/Eurasian Resources Group) not NACE 24
- **Chiatura manganese** not NACE 07 — one of world's oldest deposits (since 1879)
- **Batumi oil terminal** — BP Caspian pipeline endpoint (Baku-Supsa, SCP), not flagged
- **Kaspi cement** (HeidelbergCement) not NACE 23
- **Wine country** — world's oldest wine-making tradition (~8,000 years, UNESCO qvevri winemaking)
- **Abkhazia + South Ossetia** — Russian-occupied territories, limited data/access (Enguri Dam straddles this line)

## Validation

Georgia implements environmental protection via:

- **Ministry of Environmental Protection and Agriculture**
- **Environmental Assessment Code (2017)** — EU-aligned as part of EU Association Agreement
- Noise standards: EU-harmonized targets (as EU candidate)

Notable noise zones:

- **E60 Tbilisi↔Kutaisi↔Batumi** — Georgia's backbone
- **Tbilisi** — Kura Valley, old town + modern construction
- **Tbilisi Metro** (1966, Soviet)
- **Georgian Military Highway** (Tbilisi↔Kazbegi — dramatic mountain road, seasonal)
- **Tbilisi International (TBS/UGTB)**, **Kutaisi International (KUT/UGKO — Wizz Air hub)**, **Batumi (BUS/UGSB)** — covered by global aircraft layer
- **Enguri Dam** (1,300 MW — one of world's tallest arch dams)
- **Tbilsresi/Gardabani thermal** (Tbilisi area gas fleet)
- **Batumi oil terminal** (BP Caspian pipeline)
- **Chiatura manganese mines**
