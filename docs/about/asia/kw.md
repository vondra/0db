---
title: Kuwait
intro: Noise mapping data sources for Kuwait.
map: { center: [47.6, 29.3], zoom: 8 }
---

## Road traffic

### Class defaults only

MPW publishes no open AADT. Kuwait's road hexes were already enriched from a prior neighboring country run. Kuwait has excellent multi-lane ring motorways (1st through 7th Ring Roads) with **highest motorway AADT defaults of any enriched country** (55,000).

### Kuwaiti AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Ring Roads, expressways) | **55,000** | 110,000 | 77,000 |
| 1 trunk | 25,000 | 50,000 | 35,000 |
| 2 primary | 14,000 | 28,000 | 19,600 |
| 3 secondary | 7,000 | 14,000 | 9,800 |
| 4 tertiary | 3,000 | 6,000 | 4,200 |
| 5 residential | 1,200 | 2,400 | 1,680 |

**Tier-1 metro** (×2.0): **Kuwait City** (~3.5M metro — essentially the **entire country is one metro area**, a city-state).

**Tier-2 cities** (×1.4): **Al Ahmadi** (~100k, oil capital, KNPC refinery hub), **Jahra** (~200k, NW), Sabah Al Ahmad (new satellite city).

### Kuwaiti vehicle split

**EXTREME car dominance** — one of world's highest car ownership rates. **Near-zero motorcycle** due to 50°C+ Gulf summer heat:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Kuwait City) | **78%** | 4% | 16% | **2%** |
| Tier-2 | 76% | 3% | 19% | 2% |
| Rural/oil field | 45% | 2% | **52%** | 1% |

## Railway

### Kuwait has NO railway

Kuwait has **never had an operating railway**. The **Kuwait Metro** and **GCC Railway** (Gulf Cooperation Council transcontinental) were planned but **never built**. Railway enrichment is **skipped entirely**.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 80 plants, 60 operating, ~19.6 GW

**Operating fuel**: oil/gas **56** + solar 3 + wind 1. **100% fossil fuel dominated** — one of world's highest per-capita electricity consumption (extreme AC demand in 50°C+ summers, ~99% from gas/oil). Very high installed power density (~19.6 GW from 17,818 km² ≈ 1.1 MW/km²).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Az-Zour South** | **~4,645** (7 units) | oil/gas | **One of world's largest single-site power+desalination complexes** |
| **Sabiya** | ~3,647 (5 units) | oil/gas | Sabiya area |
| **Az-Zour North** | 1,632 (2 units) | oil/gas | IWPP (independent water+power) |
| **Shuaiba North** | 876 | oil/gas | |
| **Doha East + West** | various | oil/gas | Older units |
| **Shagaya Solar** | ~70 total | solar | Shagaya Renewable Energy Park |

All operating plants map to **NACE 35**.

### Kuwait does NOT have

- **No open AADT** — MPW publishes nothing
- **No railway** (never built)
- **Burgan oil field** not NACE 06 — **world's 2nd largest oil field** (after Ghawar Saudi), ~1.7 Mbbl/day. Discovered 1938.
- **KNPC refineries** not NACE 19 — **Mina Al-Ahmadi** (460k bpd) + **Mina Abdullah** (270k bpd) + **Al-Zour New Refinery** (615k bpd — **one of world's newest mega-refineries**, opened 2022). Total 1,345k bpd = one of world's largest refinery complexes.
- **KPC** (Kuwait Petroleum Corporation) — state oil company, one of world's wealthiest
- **EQUATE** (ethylene glycol + polyethylene — Dow/PIC JV) not NACE 20
- **PIC** (Petrochemical Industries Company) — fertilizer + petrochemicals
- **Kuwait City desalination** — most of Kuwait's fresh water comes from desalination (co-located with power plants)

## Validation

Kuwait implements environmental protection via:

- **EPA Kuwait** (Environment Public Authority)
- **Environmental Protection Law No. 42 of 2014**
- Noise standards: based on GCC + WHO guidelines
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Kuwait City ring roads** (1st-7th Ring, among Gulf's busiest)
- **Fahaheel/Ahmadi oil corridor** (south — massive refinery/industrial)
- **Kuwait International (KWI/OKBK)** — covered by global aircraft layer
- **Az-Zour power+desal complex** (~4,645 MW)
- **Sabiya power complex** (~3,647 MW)
- **KNPC refineries** (Mina Al-Ahmadi + Mina Abdullah + Al-Zour New = 1,345k bpd)
- **Burgan oil field** (world's 2nd largest)
- **Shuwaikh/Salmiya commercial districts** (dense urban)
