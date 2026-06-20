---
title: Oman
intro: Noise mapping data sources for Oman.
map: { center: [57, 21], zoom: 6 }
---

## Road traffic

### Road defaults

Oman publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Oman's traffic factor **≈ 0.711** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.711 ≈ 21,330 |
| Trunk | 15,000 × 0.711 ≈ 10,665 |
| Primary | 9,000 × 0.711 ≈ 6,399 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

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
