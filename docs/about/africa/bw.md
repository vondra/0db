---
title: Botswana
intro: Noise mapping data sources for Botswana.
map: { center: [24.5, -22], zoom: 6 }
---

## Road traffic

### Road defaults

Botswana publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Botswana's traffic factor **≈ 1.021** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.021 ≈ 30,630 |
| Trunk | 15,000 × 1.021 ≈ 15,315 |
| Primary | 9,000 × 1.021 ≈ 9,189 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **A1** — Gaborone ↔ Pilanesberg ↔ Palapye ↔ Francistown (main N-S trunk, parallel to rail)
- **A2/A3 Trans-Kalahari Highway** — Namibia border ↔ Ghanzi ↔ Nata ↔ Kasane (E-W transit)
- **A10** — Nata ↔ Kasane ↔ Namibia Caprivi (Chobe corridor)
- **A12** — Gaborone ↔ Jwaneng (diamond mine)
- **A30** — Palapye ↔ Orapa (diamond mine)
- **A33** — Nata ↔ Maun (Okavango gateway)

## Railway

### Botswana rail context

**Botswana Railways (BR)** operates a **single main line** running N-S:

### Main line
- **Ramatlabama (RSA border S) ↔ Gaborone ↔ Pilanesberg ↔ Palapye ↔ Serule ↔ Francistown ↔ Plumtree (Zimbabwe border NE)** — ~600 km, cape gauge
- Built 1897 by Cecil Rhodes (originally Bechuanaland Railway, part of Cape-to-Cairo dream)
- **Mostly freight**: coal (Morupule), soda ash (Sua Pan), cattle, general cargo
- Connects RSA (Transnet) to Zimbabwe (NRZ)
- **Passenger service discontinued 2009**, revived partially 2016

### Sua Pan Branch
- **Serule ↔ Sua Pan** (Makgadikgadi soda ash mine) — ~170 km freight-only spur for Botswana Ash

### Morupule Branch
- **Palapye ↔ Morupule coal mine** (~15 km spur)

**No urban commuter rail, no metros, no trams**. Population too sparse.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 59 plants, 13 operating, ~820 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Botswana'`

**Operating fuel**: coal 8 + solar 4 + oil/gas 1. **Botswana is extremely coal-dependent** and imports a large share of its electricity (~40%+, mostly from South Africa's Eskom, with Namibia and Zambia as secondary sources).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Morupule B** | **600** (4× 150) | coal | Opened 2012, Chinese-built (CNEEC) — **Botswana's largest plant**. **Chronic technical problems** since commissioning; availability often below 50% |
| **Morupule A** | 132 (4× 33) | coal | 1986, refurbished 2016-2018 |
| **Francistown APR** | 70 | oil/gas | Diesel emergency rental (Aggreko) |
| **Kweneng District Solar** | 11.3 | solar | |
| **Central District Solar** | 2.6 | solar | |
| **NW District Solar** | 2.6 | solar | |
| **Gaborone Solar** | 1.8 | solar | |

**Total operating: ~820 MW**.

All operating plants map to **NACE 35**.

### Botswana does NOT have

- **No DRTS AADT** — zero open traffic data
- **No BR GTFS**
- **Jwaneng Diamond Mine** not NACE 08 — **world's richest diamond mine by value** (De Beers/Debswana JV, 50-50 with Government of Botswana). The single economic asset that transformed Botswana from one of Africa's poorest at independence (1966) to one of its wealthiest.
- **Orapa Diamond Mine** not NACE 08 — **world's largest diamond mine by area**
- **Letlhakane Diamond Mine** + **Karowe Diamond Mine** (Lucara — source of the **Lesedi La Rona 1,109 ct**, found 2015, then the world's 2nd largest gem-quality rough diamond) not NACE 08
- **Morupule Coal Mine** not NACE 05 — feeds Morupule A+B plants
- **BCL Selebi-Phikwe** not classified — nickel/copper smelter+mine, **closed 2016** after commodity collapse. Town was purpose-built for this mine (1973-2016, ~45 year lifespan)
- **Botswana Ash Sua Pan** not NACE 08 — **Africa's largest soda ash operation** (Makgadikgadi Pans), mining since 1991
- **BMC** (Botswana Meat Commission, Lobatse) — one of Africa's major livestock export abattoirs (founded 1965, historic EU beef exporter)
- **PPC Botswana cement** (Gaborone) not NACE 23
- **Kgale Glass / glass works** (Gaborone)

## Validation

Botswana implements environmental protection via:

- **DEA** (Department of Environmental Affairs) — under MEWT
- **Environmental Assessment Act 2011**
- **Waste Management Act 1998**
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **A1 Gaborone↔Francistown trunk** — Botswana's main traffic artery
- **A2/A3 Trans-Kalahari Highway** (Namibia↔RSA transit — heavy freight)
- **Gaborone** — Botswana's only significant urban dense zone
- **BR Main Line** (Ramatlabama↔Gaborone↔Francistown↔Plumtree)
- **Sir Seretse Khama International (GBE/FBSK Gaborone)**, **Maun (MUB/FBMN)**, **Francistown (FRW/FBFT)**, **Kasane (BBK/FBKE)** — covered by global aircraft layer
- **Morupule B+A coal complex** (Palapye — Botswana's main thermal plant cluster, 732 MW)
- **Jwaneng Diamond Mine** (world's richest)
- **Orapa Diamond Mine** (world's largest)
- **Karowe Diamond Mine** (Lucara)
- **Botswana Ash Sua Pan** (Africa's largest soda ash operation)
- **BCL Selebi-Phikwe** (closed 2016 — abandoned industrial zone)
- **BMC Lobatse abattoir**
