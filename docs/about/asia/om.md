---
title: Oman
intro: Noise mapping data sources for Oman.
map: { center: [57, 21], zoom: 6 }
---

## Road traffic

### Class defaults only

Oman Ministry of Transport publishes no open AADT. Fall back to class defaults with Muscat Tier-1 boost.

### Omani AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Muscat Expressway, Sultan Qaboos Hwy) | 35,000 | 70,000 | 49,000 |
| 1 trunk | 15,000 | 30,000 | 21,000 |
| 2 primary | 7,500 | 15,000 | 10,500 |
| 3 secondary | 3,500 | 7,000 | 4,900 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Muscat** (~1.4M — capital, stretched along Al Batinah coast, Sultan Qaboos Grand Mosque).

**Tier-2 cities** (×1.4): **Salalah** (~300k, Dhofar — khareef monsoon tourism), **Sohar** (~200k, mega industrial port), **Sur** (~70k, LNG + traditional dhow building), **Nizwa** (~80k, interior fortress city), **Ibri** (~80k, Dhahirah, solar hub), **Duqm** (~30k, new $10B industrial port city), Barka, Saham, Rustaq, **Khasab** (Musandam exclave, Strait of Hormuz).

### Omani vehicle split

High car + 4×4 ownership (desert terrain + wealth), near-zero motorcycle:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Muscat) | 74% | 4% | 18% | 4% |
| Tier-2 | 70% | 3% | 24% | 3% |
| Rural | 58% | 2% | 38% | 2% |
| **Sohar/Duqm industrial** | 40% | 2% | **56%** | 2% |

## Railway

### Oman has NO railway

**Oman Rail** was planned (2,135 km) as part of the GCC Railway but was **never built**. Oman remains one of the largest GCC countries without any rail system. Railway enrichment is **skipped entirely**.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 123 plants, 52 operating, ~15.5 GW

**Operating fuel**: oil/gas **43** + solar 8 + wind 1. Gas-dominant.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Sohar III** | 1,740 (2× 870) | oil/gas | Sohar Industrial Port |
| **Sur** | 1,600 (2× 800) | oil/gas | Near Oman LNG |
| **Ibri** | 1,539 | oil/gas | Largest single IPP |
| **Sohar Aluminium** | 1,000 (2× 500) | oil/gas | Captive for 390 ktpa smelter |
| **Barka III + Sohar II** | 1,532 | oil/gas | |
| **Barka II + Barka I** | 1,144 | oil/gas | |
| **Sohar** | 597 | oil/gas | |
| **Al Mazyunah Solar** | 558 | solar | Southern, one of Gulf's largest |
| **Ibri 2 Solar** | 500 | solar | |
| **Manah Solar** | 500 | solar | |
| **Dhofar Wind** | 50 | wind | **Oman's first wind farm** (Salalah) |

All operating plants map to **NACE 35**.

### Oman does NOT have

- **No open AADT**
- **No railway** (Oman Rail never built)
- **Oman LNG** (Qalhat/Sur — 6.6 Mtpa) not NACE 19
- **PDO** (Petroleum Development Oman — Shell partnership) not NACE 06 — main oil operator
- **Sohar Industrial Port** — mega-port + 390 ktpa aluminium + refinery + petrochemical + OHPC
- **Mina al-Fahal refinery** (Muscat 106k bpd) not NACE 19
- **Duqm** — new $10B industrial port city (central coast) + planned refinery
- **Raysut Cement** (Salalah)
- **Musandam exclave** (Strait of Hormuz — separated from Oman by UAE)

## Validation

Oman implements environmental protection via:

- **Ministry of Environment and Climate Affairs (MECA)**
- **Royal Decree 114/2001 on Conservation of the Environment**
- Noise standards: WHO-based

Notable noise zones:

- **Muscat Expressway + Sultan Qaboos Highway** — main Muscat artery
- **Sohar Industrial Port** (1,740 MW power + 390 ktpa aluminium + refinery)
- **Muscat International (MCT/OOMS)**, **Salalah (SLL/OOSA)**, **Duqm (DQM/OODQ)**, **Khasab (KHS/OOKB Musandam)**, **Sohar (OHS/OOSH)** — covered by global aircraft layer
- **Barka/Sohar/Sur coastal CCGT corridor** (~8 GW total)
- **Al Mazyunah + Ibri 2 + Manah solar** (~1,558 MW)
- **Oman LNG Sur** (6.6 Mtpa)
- **Khasab / Musandam exclave** (Strait of Hormuz strategic chokepoint — separated from mainland Oman by UAE territory; no fixed road link)
