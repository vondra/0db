---
title: Bangladesh
intro: Noise mapping data sources for Bangladesh.
map: { center: [90, 23.5], zoom: 7 }
---

## Road traffic

### Class defaults only

RHD (Roads and Highways Department) publishes no open GIS. Fall back to CNOSSOS class defaults with Dhaka ×2.5 megacity boost.

### Bangladesh AADT defaults

Bangladesh is the **world's most densely populated large country** (~175M in 148k km² = 1,182/km²). Traffic density is extreme in Dhaka division.

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.6) |
|---|---:|---:|---:|
| 0 motorway (Dhaka-Chittagong Expressway u/c) | 40,000 | 100,000 | 64,000 |
| 1 trunk (N-routes) | 20,000 | 50,000 | 32,000 |
| 2 primary | 12,000 | 30,000 | 19,200 |
| 3 secondary | 6,000 | 15,000 | 9,600 |
| 4 tertiary | 3,000 | 7,500 | 4,800 |
| 5 residential | 1,200 | 3,000 | 1,920 |

**Tier-1 megacity** (×2.5): **Dhaka** (~22M metro — **one of world's densest cities**, mega-traffic congestion).

**Tier-2 cities** (×1.6): **Chittagong/Chattogram** (~5M, port city, ship-breaking), Khulna (~1M), Rajshahi (~800k), Sylhet (~500k), Rangpur (~350k), Comilla, **Gazipur** (garment hub adjacent to Dhaka), **Narayanganj** (garment hub, "Dundee of the East"), Mymensingh.

### Bangladesh vehicle split

Bangladesh has **extreme CNG rickshaw + motorcycle dominance**:

- **CNG auto-rickshaws (green)** — Dhaka converted to CNG post-2002 (**world's largest CNG auto-rickshaw fleet**). 3-wheelers classified as CNOSSOS "medium"
- **Bicycle rickshaws** — **Dhaka has ~400,000 bicycle rickshaws** (world's largest fleet) — but these are **non-motorized and do not contribute to CNOSSOS noise**
- **Motorcycles** — extremely high share (~32% in Dhaka), growing rapidly
- **Buses**: BRTC (state, limited), **Dhaka Metrobus BRT** planned, private buses (chaotic)
- **Heavy trucks**: N1 Dhaka↔Chittagong Highway (port freight) — decorated trucks similar to Pakistan
- **Tempo / Leguna** — small 3-wheeled shared vehicles, being phased out

| Tier | Light | Medium (CNG/rickshaw) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Dhaka) | 32% | **22%** | 14% | **32%** |
| Tier-2 | 40% | 18% | 16% | 26% |
| Rural | 35% | 10% | 30% | 25% |
| **N1 Dhaka↔Chittagong Highway** | 42% | 6% | **45%** | 7% |

### National route network

- **N1** — Dhaka ↔ Comilla ↔ Chittagong (Bangladesh's **main port freight corridor**, 260 km)
- **N2** — Dhaka ↔ Tangail ↔ Mymensingh ↔ Sylhet
- **N3** — Dhaka ↔ Aricha (Jamuna ferry crossing, old route before Bangabandhu Bridge)
- **N4** — Dhaka ↔ Bhanga ↔ Gopalganj (SW, now via **Padma Bridge** 2022)
- **N5** — Dhaka ↔ Bogra ↔ Rangpur (NW)
- **N6** — Dhaka ↔ Jessore ↔ Benapole (India border, Kolkata route)
- **Padma Bridge** (2022, $3.6B, 6.15 km) — **transformed SW Bangladesh connectivity**, largest infrastructure project in Bangladesh history

## Railway

### Class defaults + corridor bbox boosts

### Bangladesh rail context

**Bangladesh Railway** operates ~2,956 km with a **unique dual-gauge system** — a legacy of East Bengal's position between British Indian broad-gauge and Assam meter-gauge networks:

- **Broad gauge (1,676 mm)** — west of Jamuna/Brahmaputra River (Rajshahi, Khulna divisions)
- **Meter gauge (1,000 mm)** — east of Jamuna (Dhaka, Chittagong, Sylhet)
- **Bangabandhu Bridge** (1998, ~5 km) connects the two networks but requires gauge changeover

### Dhaka Metro Rail Line 6
- **Opened December 2022** — **Bangladesh's first metro**, 21 km elevated, 16 stations
- JICA Japanese-funded, built by Shimizu/Mitsubishi consortium
- Uttara North ↔ Motijheel (Dhaka central)

### Dhaka↔Chittagong Main Line
- **~340 km meter gauge** — Bangladesh's busiest railway corridor
- Named trains: Turna Nishitha, Suborna Express, Mahanagar Express, etc.

### Western Broad Gauge
- **Dhaka ↔ Rajshahi/Khulna** — broad gauge western network via Bangabandhu Bridge
- Also serves India cross-border: Maitree Express (Dhaka ↔ Kolkata)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Dhaka Metro Line 6 (2022)** | 200 | 0 |
| **Dhaka↔Chittagong main line** (meter gauge) | 15 | 10 |
| **Western broad gauge** (Dhaka↔Rajshahi/Khulna) | 8 | 5 |
| Other/branch | 3 | 3 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 360 plants, 152 operating, ~27.4 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Bangladesh'`

**Operating fuel**: oil/gas 120 (overwhelmingly domestic natural gas) + solar 17 + coal 12 + hydropower 1 + wind 1 + bioenergy 1. **Bangladesh is one of the world's most gas-dependent power systems** — domestic gas from Sylhet/Comilla/Bakhrabad fields.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Banshkhali (S Alam)** | 1,320 (2× 660) | coal | Chittagong coast |
| **Payra (BCPCL)** | 1,320 (2× 660) | coal | Patuakhali coast |
| **Rampal** | 1,320 (2× 660) | coal | Bagerhat — controversial (near Sundarbans mangrove, Indo-Bangladesh JV) |
| **Matarbari** | 1,200 (2× 600) | coal | Cox's Bazar — JICA Japanese-funded ultra-supercritical |
| **Meghnaghat-II** | 590 | oil/gas | Narayanganj |
| **Unique Meghnaghat** | 584 | oil/gas | Narayanganj |
| **Ashuganj** | 1,320 (3× 450+420) | oil/gas | Brahmanbaria — one of BD's oldest major plant complexes |
| **Sirajganj** | 414 | oil/gas | |
| **Kaptai** | 230 | hydropower | **Bangladesh's only hydro** (Karnaphuli River, Rangamati Hills, 1962) |
| **120+ smaller gas plants** | ~18,000 total | oil/gas | Scattered across BD — gas-turbine fleet |

**Under construction**: **Rooppur Nuclear 2,400 MW** (Russian VVER-1200 × 2 — Bangladesh's first nuclear, Pabna district, opens ~2026)

All operating plants map to **NACE 35**.

### Bangladesh does NOT have

- **No RHD AADT** — zero open traffic data
- **No Bangladesh Railway GTFS**
- **RMG garment factories** (Dhaka/Gazipur/Narayanganj) not NACE 13/14 — **world's #2 garment exporter after China** (~$45B/year). Millions employed. Rana Plaza collapse 2013 was the deadliest garment industry disaster.
- **Ship-breaking** (Sitakunda, Chittagong) not NACE 38 — **world's #2 after Alang India**. Major environmental + occupational hazard concerns
- **Eastern Refinery** (Chittagong) not NACE 19 — Bangladesh's only oil refinery
- **Cement**: Shah Cement, Bashundhara, LafargeHolcim — not NACE 23
- **Chittagong Port** — Bangladesh's main container port
- **Mongla Port** (Khulna) — 2nd port
- **Sylhet/Comilla gas fields** — domestic gas production
- **Padma Fertilizer** (Ashuganj), **Shahjalal Fertilizer** — urea producers

## Validation

Bangladesh implements environmental protection via:

- **DoE** (Department of Environment) — under MoEFCC
- **Bangladesh Environment Conservation Act 1995** (amended 2010)
- **Environment Conservation Rules 1997** — includes noise standards
- Typical limits: residential 50/40 dBA day/night, commercial 70/60, industrial 75/70
- **Dhaka is consistently ranked among the world's noisiest cities** — horn honking is culturally pervasive

Notable noise zones:

- **Dhaka mega-city** — one of world's densest, extreme traffic congestion, CNG + motorcycle dominant
- **N1 Dhaka↔Chittagong Highway** — main port freight corridor
- **Padma Bridge corridor** (2022 — transforming SW connectivity)
- **Bangladesh Railway Dhaka↔Chittagong** main line
- **Dhaka Metro Rail Line 6** (2022, JICA Japanese-built)
- **Hazrat Shahjalal International (DAC/VGHS Dhaka)**, **Shah Amanat International (CGP/VGEG Chittagong)**, **Shah Makhdum (RJH/VGRJ Rajshahi)**, **Osmani International (ZYL/VGSY Sylhet)**, **Cox's Bazar (CXB/VGCB)** — covered by global aircraft layer
- **Ashuganj + Meghnaghat gas thermal cluster** (Narayanganj/Brahmanbaria)
- **Rampal coal** (Bagerhat — near Sundarbans, controversial)
- **Payra + Matarbari coal** (coast, new mega-plants)
- **Kaptai hydro** (230 MW — Bangladesh's only hydro)
- **Ship-breaking Sitakunda** (Chittagong coast)
- **Chittagong Port** container operations
- **Gazipur/Narayanganj garment district** (millions of workers, factory cluster noise)
