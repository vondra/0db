---
title: Botswana
intro: Noise mapping data sources for Botswana.
map: { center: [24.5, -22], zoom: 6 }
---

## Road traffic

### Class defaults only

DRTS (Department of Road Transport and Safety) and Roads Department publish no open AADT. Fall back to CNOSSOS class defaults with Gaborone Tier-1 boost.

### Botswana AADT defaults

Botswana is **very sparsely populated** (~2.6M in 582k km² = 4.5/km², mostly Kalahari Desert). Population concentrated in the SE corridor.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A1 Gaborone bypass) | 22,000 | 44,000 | 30,800 |
| 1 trunk (A-routes paved) | 8,000 | 16,000 | 11,200 |
| 2 primary | 4,000 | 8,000 | 5,600 |
| 3 secondary | 2,000 | 4,000 | 2,800 |
| 4 tertiary | 1,000 | 2,000 | 1,400 |
| 5 residential | 500 | 1,000 | 700 |

**Tier-1 metros** (×2.0, 1 metro): **Gaborone** (~250k city / ~400k metro — Africa's one of smallest capital metros by population, but highest per-capita income in sub-Saharan Africa).

**Tier-2 cities** (×1.4, 16 cities): **Francistown** (2nd city, north hub), Molepolole, **Maun** (Okavango Delta tourism gateway), Mogoditshane (Gaborone satellite), Serowe, **Selebi-Phikwe** (BCL mine closed 2016, purpose-built mining town), **Palapye** (Morupule coal + BIH), Kanye, Mahalapye, Lobatse (BMC abattoir), **Kasane** (Chobe tourism), Nata (Makgadikgadi gateway), **Jwaneng** (diamond mine town), **Orapa** (diamond mine town), **Ghanzi** (Trans-Kalahari stop), Letlhakane (diamond).

### Botswana vehicle split

Botswana is **one of Africa's most car-dependent countries** — high per-capita vehicle ownership (close to South Africa level), minimal minibus/moto-taxi culture.

- **Private cars** — dominant (Toyota Land Cruiser ubiquitous due to Kalahari conditions)
- **Combis** — white minibuses, but less dominant than ZW/ZM/MW
- **Motorcycles** — **very low share (~2-4%)**, no moto-taxi culture at all
- **Heavy trucks**: Trans-Kalahari Highway (Namibia↔RSA transit), coal from Morupule, diamond freight, cattle transport (Botswana's traditional economy)

| Tier | Light | Medium (combi) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Gaborone) | 68% | 12% | 16% | 4% |
| Tier-2 | 66% | 10% | 20% | 4% |
| Rural | 58% | 6% | 33% | 3% |
| **Trans-Kalahari Highway (Namibia↔RSA)** | 50% | 4% | **44%** | 2% |

### National route network

- **A1** — Gaborone ↔ Pilanesberg ↔ Palapye ↔ Francistown (main N-S trunk, parallel to rail)
- **A2/A3 Trans-Kalahari Highway** — Namibia border ↔ Ghanzi ↔ Nata ↔ Kasane (E-W transit)
- **A10** — Nata ↔ Kasane ↔ Namibia Caprivi (Chobe corridor)
- **A12** — Gaborone ↔ Jwaneng (diamond mine)
- **A30** — Palapye ↔ Orapa (diamond mine)
- **A33** — Nata ↔ Maun (Okavango gateway)

## Railway

### Class defaults + corridor bbox boosts

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

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Main line** (Gaborone↔Francistown↔Plumtree/Ramatlabama) | 1 | 8 |
| **Sua Pan Branch** (soda ash freight) | 0 | 4 |
| Other/branch | 0 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 59 plants, 13 operating, ~820 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Botswana'`

**Operating fuel**: coal 8 + solar 4 + oil/gas 1. **Botswana is extremely coal-dependent** and imports ~40% of electricity from South Africa (Eskom) and Mozambique.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Morupule B** | **600** (4× 150) | coal | Opened 2012, Chinese-built (CNEEC) — **Botswana's largest plant**. **Chronic technical problems** since commissioning; availability often below 50% |
| **Morupule A** | 132 (4× 33) | coal | 1986, upgraded 2008 |
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
- **Orapa Diamond Mine** not NACE 08 — **world's largest diamond mine by area** (world's 2nd largest open pit)
- **Letlhakane Diamond Mine** + **Karowe Diamond Mine** (Lucara — world's 2nd largest gem diamond **Lesedi La Rona 1,109 ct** found here 2015) not NACE 08
- **Morupule Coal Mine** not NACE 05 — feeds Morupule A+B plants
- **BCL Selebi-Phikwe** not classified — nickel/copper smelter+mine, **closed 2016** after commodity collapse. Town was purpose-built for this mine (1973-2016, ~45 year lifespan)
- **Botswana Ash Sua Pan** not NACE 08 — **world's largest soda ash deposit by area** (Makgadikgadi Pans), mining since 1991
- **BMC** (Botswana Meat Commission, Lobatse) — Africa's oldest and largest livestock export abattoir
- **PPC Botswana cement** (Gaborone) not NACE 23
- **Kgale Glass** (Gaborone) — Southern Africa's only glass manufacturer outside RSA

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
- **Botswana Ash Sua Pan** (soda ash)
- **BCL Selebi-Phikwe** (closed 2016 — abandoned industrial zone)
- **BMC Lobatse abattoir**
