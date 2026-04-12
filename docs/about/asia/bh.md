---
title: Bahrain
intro: Noise mapping data sources for Bahrain.
map: { center: [50.55, 26.05], zoom: 10 }
---

## Road traffic

### Class defaults only

Bahrain's road hexes were pre-enriched from prior SA overlap (**entire country fits in 1 H3R4 hex**). Motorway AADT 55,000 (King Fahd Causeway approach + Shaikh Isa bin Salman Highway).

**Tier-1 metro** (×2.0): **Manama** (~400k — capital, but entire island is essentially one metro area with ~1.5M).

**Tier-2 cities** (×1.4): **Muharraq** (airport island, former capital), **Riffa** (residential, **Bahrain F1 Grand Prix** circuit), **Sitra** (industrial, BAPCO refinery), Hamad Town, Isa Town.

### Bahraini vehicle split

Ultra-high car ownership, near-zero motorcycle (Gulf heat):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Manama) | **78%** | 4% | 16% | **2%** |
| Tier-2 | 76% | 3% | 19% | 2% |
| King Fahd Causeway | **80%** | 2% | 16% | 2% |

**King Fahd Causeway** — 25 km sea bridge to Saudi Arabia (~65,000 vehicles/day, mostly Saudi weekend traffic + commuters). One of world's longest sea bridges.

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
| **ALBA captive** | **2,848** (5 units) | oil/gas | Captive for **ALBA aluminium smelter** (1.56 Mtpa — **5th largest globally**, one of world's largest single-site smelters) |
| **Al-Dur** | 2,726 (4 units) | oil/gas | **IWPP desal+power** — Bahrain's largest station |
| **Al Hidd** | 987 | oil/gas | Muharraq area desal+power |
| **Al Ezzel** | 942 (2 units) | oil/gas | IWPP |
| **Riffa** | 150 (2 units) | oil/gas | Older |
| **Solar** | ~5 | solar | Pilot |

All operating plants map to **NACE 35**.

### Bahrain does NOT have

- **No open AADT** — MOW publishes nothing
- **No railway** (never built)
- **ALBA aluminium** not NACE 24 — **1.56 Mtpa** (5th largest smelter globally, one of world's largest single-site). Founded 1971, expanded 6 times.
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
- **ALBA smelter** (2,848 MW captive power + 1.56 Mtpa aluminium — **dominant industrial noise source on island**)
- **Al-Dur power+desal** (2,726 MW)
- **BAPCO Sitra refinery** (267k bpd)
- **Bahrain International (BAH/OBBI)** — covered by global aircraft layer
- **Sakhir F1 circuit** (Bahrain Grand Prix — periodic extreme noise source)
