---
title: Georgia
intro: Noise mapping data sources for Georgia.
map: { center: [43.5, 42], zoom: 7 }
---

## Road traffic

### Road defaults

Georgia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Georgia's traffic factor **≈ 1.110** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.110 ≈ 33,300 |
| Trunk | 15,000 × 1.110 ≈ 16,650 |
| Primary | 9,000 × 1.110 ≈ 9,990 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **E60** — Tbilisi ↔ Gori ↔ Khashuri ↔ Kutaisi ↔ Samtredia ↔ Batumi/Poti — **Georgia's east-west backbone** (Rikoti Pass tunnel under reconstruction — $1B project)
- **E70** — Tbilisi ↔ Rustavi ↔ Azerbaijan border (east, Baku connection)
- **Georgian Military Highway** — Tbilisi ↔ Kazbegi ↔ Russia (Dariali Gorge — one of world's most dramatic mountain roads, seasonal closures)
- **S1** — Tbilisi ↔ Batumi via Akhaltsikhe (southern route, bypasses Rikoti)

## Railway

### Georgian rail context

**Georgian Railway** operates ~1,600 km of **broad gauge (1,520 mm)** — Soviet-era infrastructure.

### Tbilisi Metro
- **Opened 1966** — Soviet-era, **2 lines, ~28 km, 23 stations**, ~500k daily riders

### Main east-west line
- **Tbilisi ↔ Gori ↔ Zestaponi ↔ Samtredia ↔ Batumi/Poti** — Georgia's rail backbone. Carries oil/manganese freight to Black Sea ports.

### Other branches
- **Tbilisi ↔ Azerbaijan** (Kakheti east)
- **Samtredia ↔ Zugdidi** (Mingrelia, near Abkhazia)

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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
