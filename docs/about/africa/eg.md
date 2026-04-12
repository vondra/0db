---
title: Egypt
intro: Noise mapping data sources for Egypt.
map: { center: [30, 27], zoom: 5 }
---

## Road traffic

### Class defaults only — all gov portals dead

**Every Egyptian government portal is unreachable**: MOT, GARBLT (road authority), NREA, NAT (tunnel authority / Cairo Metro), Ministry of Petroleum, EGAS, ENR (redirects to Vaadin login), CAPMAS, EgyptERA. No authoritative road network exists as open data. No per-segment AADT anywhere.

Fall back to class defaults with **×2.5 Tier-1 multiplier** — unique to Egypt — reflecting Greater Cairo's exceptional density (22M people in the Nile Valley, Cairo Ring Road exceeds 200,000 AADT in peak sections, among the most congested urban highways in the world).

### Egyptian AADT defaults

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.5) |
|---|---:|---:|---:|
| 0 motorway (Ring Road, Desert Road toll) | 40,000 | 100,000 | 60,000 |
| 1 trunk | 15,000 | 37,500 | 22,500 |
| 2 primary | 7,000 | 17,500 | 10,500 |
| 3 secondary | 3,500 | 8,750 | 5,250 |
| 4 tertiary | 1,500 | 3,750 | 2,250 |
| 5 residential | 700 | 1,750 | 1,050 |

**Tier-1 metros** (×2.5, 3 metros): **Greater Cairo** (~22M, **world's 6th largest metropolitan area**), **Giza** (~9M, Cairo agglomeration), **Alexandria** (~5M, Mediterranean coast).

**Tier-2 cities** (×1.5, 21 cities): Port Said, Suez, Ismailia, Luxor, Aswan, Hurghada, Sharm El Sheikh, Tanta, Mansoura, Mahalla el-Kubra, Asyut, Sohag, Damanhur, Zagazig, Faiyum, Minya, Beni Suef, Qena, Kafr el-Sheikh, New Cairo, 6th of October City.

### Egyptian vehicle split

Cairo has **high motorcycle + tuktuk share** (~25-30% — tuktuks dominate in informal settlements and Delta towns).

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 | 55% | 8% | 10% | **27%** |
| Tier-2 | 60% | 8% | 12% | 20% |
| Rural Delta | 58% | 8% | 20% | 14% |
| **Suez / Desert Roads** | **52%** | 8% | **30%** | 10% |
| Upper Egypt | 55% | 10% | 20% | 15% |

### National route network

Egypt's road network is essentially the Nile Valley + Delta + a handful of desert corridors:

- **Desert Road** — Cairo ↔ Alexandria (220 km, partially tolled)
- **Agricultural Road** — Cairo ↔ Alexandria via Delta cities
- **Ring Road (El Tareeq El Da'ery)** — Cairo bypass, ~100 km, >200k AADT peak
- **26th July Corridor** — Cairo urban expressway
- **Suez Road** — Cairo ↔ Ismailia ↔ Suez
- **Sokhna / Red Sea Road** — Cairo ↔ Hurghada ↔ Marsa Alam
- **Upper Egypt Road** — Cairo ↔ Minya ↔ Asyut ↔ Luxor ↔ Aswan (Nile Valley spine)
- **Western Desert Road** — Cairo ↔ Faiyum ↔ Bahariya ↔ Farafra ↔ Dakhla ↔ Kharga (oasis route)
- **Sinai North** Suez ↔ Arish ↔ Rafah · **Sinai South** Suez ↔ Sharm El Sheikh ↔ Taba

## Railway

### Class defaults — no open ENR/Metro/HSR geometry

Egyptian National Railways (`enr.gov.eg`) and Cairo Metro (NAT) publish no open geometry. Use OSM rail + corridor bbox boosts.

### Egyptian rail context

- **Egyptian National Railways (ENR)** — **Africa's oldest railway** (Alexandria↔Cairo opened 1854, 9 years before London Underground). ~5,500 km total.
- **Cairo Metro** — **Africa's first metro** (Line 1 opened 1987):
  - **Line 1** Helwan ↔ New El Marg (44 km, red)
  - **Line 2** Shubra El Kheima ↔ El Mounib (21 km, blue)
  - **Line 3** Adly Mansour ↔ Kit Kat ↔ Rod El Farag (green, still extending)
  - Line 4/5/6 under construction/planned
- **Alexandria Tram** — **oldest operational tram in Africa** (1863 horse-drawn, 1902 electrified). Ramleh + City lines, ~32 km.
- **HSR (High Speed Rail)** — new 2,000+ km Siemens network under construction (2022 contract, one of the largest rail contracts in history):
  - Line 1: Ain Sokhna ↔ Alexandria ↔ Marsa Matrouh (660 km)
  - Line 2: Cairo ↔ Luxor ↔ Aswan (1,100 km)
  - Line 3: Luxor ↔ Hurghada ↔ Safaga
  - Phased opening 2025-2028

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Cairo ↔ Alexandria (busiest ENR)** | 100 | 30 |
| **Cairo ↔ Upper Egypt (Luxor/Aswan)** | 40 | 15 |
| **Cairo ↔ Suez Canal (Port Said/Suez/Ismailia)** | 20 | 15 |
| **Alexandria Tram** | 250 | 0 |
| **Cairo Metro Lines 1-3 (light_rail)** | 400 | 0 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 309 plants, 200 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Egypt'`

**Operating fuel**: oil/gas 109 + solar 68 + wind 14 + hydro 6.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Aswan High Dam** | 2,100 | hydropower | Iconic, opened 1970 |
| **Beni Suef** | 4 × 1,200 | oil/gas CCGT | Siemens 2018 |
| **Burullus** | 4 × 1,200 | oil/gas CCGT | Siemens 2018 |
| **New Capital** | 4 × 1,200 | oil/gas CCGT | Siemens 2018 |
| **6 October** | 919 | oil/gas | 6th of October City |
| **Banha** | 750 | oil/gas | Qaliubiya |
| Nubaria | 1,500 | oil/gas CCGT | |
| El-Kureimat | 2,250 | oil/gas CCGT | Beni Suef |
| Dairut | 2,250 | oil/gas CCGT | Asyut |

The **Siemens 2018 CCGT trio (Beni Suef + Burullus + New Capital)** represents **14,400 MW built in 27 months** — Guinness World Record for fastest power plant fleet construction.

**Renewables**:
- **Benban Solar Park** (Aswan, 1.8 GW PV) — **Africa's largest solar farm**
- **Gabal El-Zeit** (Red Sea, 580 MW wind) — **Africa's largest wind farm**
- **Zafarana** + **Gulf El-Zeit** + **Ras Ghareb** wind farms

### Egypt does NOT have

- **No TPDA/AADT** — zero traffic data publicly available
- **No open SANRAL/ENR/Metro GTFS**
- **No refinery NACE classification** — MIDOR Alexandria, ANRPC El Mex/Amriya/ASORC/Mostorod/Tanta, Suez Oil Processing rely on OSM only
- **No steel/aluminum/cement classification** — Ezz Steel (Ain Sokhna), Egyptalum (Nag Hammadi 320 ktpa), Suez Cement, El Arish Cement etc. rely on OSM

## Validation

Egypt implements noise regulation via:

- **EEAA** (Egyptian Environmental Affairs Agency) at [eeaa.gov.eg](https://www.eeaa.gov.eg/)
- **Law 4/1994** — Egyptian Environmental Protection Law (amended 2020)
  - Residential: 45 dBA (day) / 35 dBA (night)
  - Mixed: 50/40 dBA
  - Commercial: 55/45 dBA
  - Industrial: 60/50 dBA (some of the strictest in MENA on paper)
- **Executive Regulations Decree 338/1995** — noise emission standards

Notable noise zones:

- **Cairo Ring Road** — ~200,000+ AADT, extreme congestion
- **26th July Corridor / Mehwar Elmo'asasa / Autostrad** Cairo urban highways
- **Desert Road / Agricultural Road** Cairo ↔ Alexandria (dual parallel corridors)
- **Cairo ↔ Suez / Sokhna Road**
- **Red Sea Road** Cairo ↔ Hurghada (tourism + freight)
- **Upper Egypt Road** Cairo ↔ Luxor ↔ Aswan (Nile Valley spine)
- **Cairo Metro Lines 1-3** — Africa's first metro system
- **Alexandria Tram** — Africa's oldest operational tram (since 1863)
- **ENR Cairo ↔ Alexandria mainline** — busiest ENR corridor
- **Cairo International (CAI/HECA)**, **Borg El Arab (HBE/HEBA Alexandria)**, **Hurghada (HRG/HEGN)**, **Sharm El Sheikh (SSH/HESH)**, **Luxor (LXR/HELX)**, **Aswan (ASW/HESN)**, **Sphinx International (SPX Cairo West)** — covered by global aircraft layer
- **Aswan High Dam** — iconic 2.1 GW hydroelectric, world's 8th largest dam by reservoir volume
- **Siemens CCGT trio**: Beni Suef + Burullus + New Capital (14,400 MW combined)
- **Benban Solar Park** (Aswan, 1.8 GW) — Africa's largest solar farm
- **Gabal El-Zeit** (Red Sea, 580 MW) — Africa's largest wind farm
- **Zohr gas field** (offshore Mediterranean, Eni) — world's largest Mediterranean gas find
- **MIDOR + Alexandria refinery complex** (El Mex, Amriya, El Mex) — ~300k bpd combined
- **Suez Canal Zone (SCZone)** industrial + petrochemical complex
- **Ezz Steel** Ain Sokhna — Egypt's largest steel producer
- **Egyptalum** (Nag Hammadi) — 320 ktpa aluminum smelter
- **Suez Canal** maritime traffic — noise from ~50 ships/day transit
