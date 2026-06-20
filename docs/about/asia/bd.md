---
title: Bangladesh
intro: Noise mapping data sources for Bangladesh.
map: { center: [90, 23.5], zoom: 7 }
---

## Road traffic

### Road defaults

Bangladesh publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Bangladesh's traffic factor **≈ 0.933** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.933 ≈ 27,990 |
| Trunk | 15,000 × 0.933 ≈ 13,995 |
| Primary | 9,000 × 0.933 ≈ 8,397 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **N1** — Dhaka ↔ Comilla ↔ Chittagong (Bangladesh's **main port freight corridor**, 260 km)
- **N2** — Dhaka ↔ Tangail ↔ Mymensingh ↔ Sylhet
- **N3** — Dhaka ↔ Aricha (Jamuna ferry crossing, old route before Bangabandhu Bridge)
- **N4** — Dhaka ↔ Bhanga ↔ Gopalganj (SW, now via **Padma Bridge** 2022)
- **N5** — Dhaka ↔ Bogra ↔ Rangpur (NW)
- **N6** — Dhaka ↔ Jessore ↔ Benapole (India border, Kolkata route)
- **Padma Bridge** (2022, $3.6B, 6.15 km) — **transformed SW Bangladesh connectivity**, largest infrastructure project in Bangladesh history

## Railway

### Bangladesh rail context

**Bangladesh Railway** operates ~2,956 km with a **unique dual-gauge system** — a legacy of East Bengal's position between British Indian broad-gauge and Assam meter-gauge networks:

- **Broad gauge (1,676 mm)** — west of Jamuna/Brahmaputra River (Rajshahi, Khulna divisions)
- **Meter gauge (1,000 mm)** — east of Jamuna (Dhaka, Chittagong, Sylhet)
- **Bangabandhu Bridge** (1998, ~5 km) connects the two networks but requires gauge changeover

### Dhaka Metro Rail Line 6
- **Bangladesh's first metro** — first segment opened December 2022 (Uttara North↔Agargaon); full line Uttara North↔Motijheel (~21 km elevated, 16 stations) completed late 2023
- JICA Japanese-funded, built by Shimizu/Mitsubishi consortium

### Dhaka↔Chittagong Main Line
- **~340 km meter gauge** — Bangladesh's busiest railway corridor
- Named trains: Turna Nishitha, Suborna Express, Mahanagar Express, etc.

### Western Broad Gauge
- **Dhaka ↔ Rajshahi/Khulna** — broad gauge western network via Bangabandhu Bridge
- Also serves India cross-border: Maitree Express (Dhaka ↔ Kolkata)

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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
- **Ship-breaking** (Sitakunda, Chittagong) not NACE 38 — **world's #1 by tonnage** (~43% of global ship-recycling, ahead of India's Alang). Major environmental + occupational hazard concerns
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
