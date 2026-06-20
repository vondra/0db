---
title: Bahrain
intro: Noise mapping data sources for Bahrain.
map: { center: [50.55, 26.05], zoom: 10 }
---

## Road traffic

### Road defaults

Bahrain publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Bahrain's traffic factor **≈ 1.284** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.284 ≈ 38,520 |
| Trunk | 15,000 × 1.284 ≈ 19,260 |
| Primary | 9,000 × 1.284 ≈ 11,556 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Bahrain has NO railway

Bahrain has never had an operating railway. A metro was planned but never built. GCC Railway was planned but cancelled. Railway enrichment is **skipped entirely**.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 33 plants, 25 operating, ~8.6 GW

**HIGHEST power density per km² of ANY enriched country** — 8,605 MW from 778 km² = **11.1 MW/km²** (surpasses Kuwait's ~1.1 and Qatar's ~1.2).

**Operating fuel**: oil/gas **24** + solar 1. **100% gas-fired** (Bahrain has small domestic gas + Saudi Arabia pipeline supply).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **ALBA captive** | **2,848** (5 units) | oil/gas | Captive for **ALBA aluminium smelter** (~1.6 Mtpa — **world's largest single-site aluminium smelter** / largest ex-China) |
| **Al-Dur** | 2,726 (4 units) | oil/gas | **IWPP desal+power** — Bahrain's largest station |
| **Al Hidd** | 987 | oil/gas | Muharraq area desal+power |
| **Al Ezzel** | 942 (2 units) | oil/gas | IWPP |
| **Riffa** | 150 (2 units) | oil/gas | Older |
| **Solar** | ~5 | solar | Pilot |

All operating plants map to **NACE 35**.

### Bahrain does NOT have

- **No open AADT** — MOW publishes nothing
- **No railway** (never built)
- **ALBA aluminium** not NACE 24 — **~1.6 Mtpa** (world's largest single-site aluminium smelter / largest ex-China). Founded 1971, expanded 6 times (Line 6 added 540 ktpa in 2019).
- **BAPCO refinery** (Sitra) not NACE 19 — **267k bpd, Bahrain's oldest industry since 1932** (Gulf's first oil refinery — oil discovered at Jebel Dukhan 1932, before Saudi Arabia/Kuwait)
- **Jebel Dukhan oil field** — **Gulf's first oil discovery (1932)** — modest production now
- **GPIC** (Gulf Petrochemical Industries Company) — ammonia + methanol + urea
- **Bahrain Financial Harbour** + **Bahrain World Trade Center** — financial sector
- **Bahrain F1 Grand Prix** (Sakhir circuit)
- **King Fahd Causeway** — 25 km to Saudi Arabia

## Validation

Bahrain implements environmental protection via:

- **Supreme Council for Environment**
- **Environmental Protection Law No. 21 of 1996**
- Noise standards: WHO-based

Notable noise zones:

- **King Fahd Causeway** (25 km — 65k veh/day)
- **Manama** (entire island is dense urban)
- **ALBA smelter** (2,848 MW captive power + ~1.6 Mtpa aluminium — **dominant industrial noise source on island**)
- **Al-Dur power+desal** (2,726 MW)
- **BAPCO Sitra refinery** (267k bpd)
- **Bahrain International (BAH/OBBI)** — covered by global aircraft layer
- **Sakhir F1 circuit** (Bahrain Grand Prix — periodic extreme noise source)
