---
title: Belarus
intro: Noise mapping data sources for Belarus.
map: { center: [27.9, 53.7], zoom: 6 }
---

## Road traffic

### Class defaults only

No open AADT from Belarusian road authorities. Fall back to class defaults with Minsk Tier-1 boost.

### Belarusian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (M1/E30 Moscow-Minsk-Brest) | 25,000 | 50,000 | 35,000 |
| 1 trunk | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,400 | 2,800 | 1,960 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Minsk** (~2M — capital, Soviet planned city, wide boulevards, WWII Hero City).

**Tier-2 cities** (×1.4): **Gomel** (~530k — south, **near Chernobyl exclusion zone** — 1986 fallout heavily affected southern Belarus), **Mogilev** (~380k), **Vitebsk** (~370k — NE, Chagall's birthplace), **Grodno** (~370k — west, Polish border), **Brest** (~340k — Polish border, **Brest Fortress** WWII Hero-Fortress).

### Belarusian vehicle split

Post-Soviet, moderate car, very low motorcycle:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Minsk) | 70% | 6% | 20% | 4% |
| Tier-2 | 68% | 5% | 23% | 4% |
| Rural | 58% | 3% | 36% | 3% |
| **M1 transit corridor** | 55% | 3% | **40%** | 2% |

## Railway

### Belarusian Railway ~5,500 km broad gauge 1,520mm — **major Russia↔Europe transit corridor**.

**Minsk Metro** (1984) — 2 lines, ~40 km, 33 stations, ~800k daily.

| Context | pax/day | frt/day |
|---|---:|---:|
| **Minsk Metro (1984)** | 200 | 0 |
| **Main trunk** (Minsk hub, M1/E30 rail parallel) | 15 | 18 |
| Other | 5 | 8 |

## Industrial

### GEM — 105 plants, 93 operating, ~11.9 GW

Gas-dominant (67 oil/gas + 24 solar + 2 nuclear). **Astravets NPP 2,388 MW** (2× VVER-1200 — **Russia-built 2020-2023**, only **50 km from Vilnius**, Lithuania opposition + EU safety concerns). **Lukoml GRES ~2,800 MW** (Novolukoml — Belarus's largest thermal). Minsk CHP-5 720 + CHP-4 250. Bereza 427. 24 solar.

### Key sites not NACE classified
- **Belaruskali potash** (Soligorsk — **world's 2nd largest potash producer** after Nutrien/Saskatchewan)
- **BelAZ** (Zhodino — **world's largest dump trucks**, 450-ton capacity)
- **Mozyr refinery** (240k bpd) + **Naftan refinery** (Novopolotsk, 220k bpd) — Druzhba pipeline Russian crude
- **BMZ steel** (Zhlobin — Byelorussian Steel Works)
- **Grodno Azot** (nitrogen fertilizer — one of Europe's largest)
- **MAZ trucks** (Minsk Automobile Plant)
- **Gomel — near Chernobyl exclusion zone** (1986 nuclear disaster)
