---
title: Mongolia
intro: Noise mapping data sources for Mongolia.
map: { center: [104, 47], zoom: 4 }
---

## Road traffic

### Class defaults only

No open AADT from Mongolia's road authority. Fall back to CNOSSOS class defaults with Ulaanbaatar ×2.5 boost. Mongolia has **one of the world's lowest road densities** — most roads outside UB are unpaved tracks/trails.

### Mongolian AADT defaults

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (New UB Airport road ~50 km) | 15,000 | 37,500 | 21,000 |
| 1 trunk | 5,000 | 12,500 | 7,000 |
| 2 primary | 2,500 | 6,250 | 3,500 |
| 3 secondary | 1,200 | 3,000 | 1,680 |
| 4 tertiary | 500 | 1,250 | 700 |
| 5 residential | 300 | 750 | 420 |

**Tier-1 metro** (×2.5): **Ulaanbaatar** (~1.6M — **46% of all Mongolians live in one city**, extreme capital primacy. **World's coldest national capital** (average -1°C). "Ger district" urban sprawl is unique to Mongolia — vast informal settlements of traditional felt tents with coal-burning stoves.)

**Tier-2 cities** (×1.4): **Erdenet** (~100k — copper mine city, built for the mine 1974), **Darkhan** (~85k — industrial, Soviet-era planned city), Choibalsan (~40k — eastern Mongolia, Dornod Province), Khovd (~30k — western Mongolia).

### Mongolian vehicle split

Mongolia has **very LOW motorcycle share** (3-6%) — extreme continental climate (-30°C winters) makes year-round motorcycling impractical. High SUV/4×4 share due to terrain.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Ulaanbaatar) | 70% | 8% | 16% | **6%** |
| Tier-2 | 65% | 6% | 24% | 5% |
| Rural | 50% | 3% | 44% | 3% |
| **Gobi mining corridor** (OT/TT) | 30% | 2% | **66%** | 2% |

### National route network

- **UB ↔ Darkhan ↔ Altanbulag** (Russian border N) — main N trunk, parallel to Trans-Mongolian Railway
- **UB ↔ Choir ↔ Sainshand ↔ Zamyn-Üüd** (China border S) — main S trunk
- **UB ↔ Arvaikheer ↔ Bayankhongor ↔ Khovd** — western route (largely unpaved)
- **New UB International Airport road** (~50 km, Mongolia's only motorway-grade road)
- **Gobi mining roads** — Oyu Tolgoi/Tavan Tolgoi ↔ Gashuunsukhait (China border) — **extremely heavy truck traffic**

## Railway

### Class defaults + corridor bbox boosts

### Mongolian rail context

**UBTZ (Ulaanbaatar Railway / Mongolian Railways)** operates ~1,815 km of **broad gauge (1,520 mm, Russian gauge)** — Soviet-built, diesel traction only. Part of the Trans-Siberian network.

### Trans-Mongolian Railway
- **Sükhbaatar (Russia border N) ↔ Darkhan ↔ Ulaanbaatar ↔ Choir ↔ Sainshand ↔ Zamyn-Üüd (China border S)** — ~1,110 km
- Part of the **Moscow ↔ Beijing Trans-Siberian route** — one of the world's most famous railway journeys
- Carries both passengers (including iconic Trans-Siberian international trains) and freight (coal, copper, minerals)

### Erdenet Branch
- **Darkhan ↔ Erdenet** — copper mine freight branch

### Choibalsan Line
- **Eastern Mongolia branch to Dornod Province** — limited freight

**No urban metro, no tram** in any Mongolian city (UB once planned a metro but never built).

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Trans-Mongolian main line** | 4 | 8 |
| **Erdenet branch** (copper freight) | 0 | 6 |
| Other/branch | 0 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 81 plants, 25 operating, ~1.41 GW

**Operating fuel**: coal **13** + solar 9 + wind 3. **Overwhelmingly coal-dependent** — CHP (combined heat+power) is essential for extreme cold winters. No hydropower in GEM (some small hydros exist but below threshold).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Ulaanbaatar-4 CHP** | **~889** (7 units) | coal CHP | **Mongolia's largest**, Soviet-era combined heat+power. Provides both electricity AND district heating for UB — essential in world's coldest national capital |
| **Buuruljuut** | 150 | coal | Newer coal, SE Mongolia |
| **Sainshand Wind** | 55 | wind | Gobi |
| **Salkhit Wind** | 50 | wind | **Mongolia's first wind farm** (2013, developed by Newcom) |
| **Tsetsii Wind** | 50 | wind | Gobi |
| **Dornod/Choibalsan** | 86 (50+36) | coal | Eastern Mongolia |
| **Ulaanbaatar-3** | 50 | coal CHP | Older UB plant |
| **Darkhan** | 35 | coal CHP | |
| **Erdenet** | ~35 | coal CHP | Mine-associated |
| **9 solar plants** | ~80 total | solar | Recent |

All operating plants map to **NACE 35**.

### Mongolia does NOT have

- **No open AADT** — road authority publishes nothing
- **No UBTZ GTFS** (Trans-Mongolian timetable available as PDF only)
- **Oyu Tolgoi** (Rio Tinto, South Gobi) not NACE 07 — **one of the world's largest known copper-gold deposits**, underground expansion opened 2023 (one of mining industry's most complex projects)
- **Tavan Tolgoi** (South Gobi) not NACE 05 — **world's largest untapped coking coal deposit**, Mongolian state-owned. ~6.4 Bt reserves. Exports to China via Gashuunsukhait border
- **Erdenet Copper** not NACE 07 — one of the world's largest open-pit copper mines (~25 Mtpa ore), joint Russia/Mongolia (originally Erdenet city was purpose-built 1974)
- **Cashmere processing** — Mongolia produces ~40% of world's cashmere (Gobi Corporation, Goyo, Bodios)
- **No oil refinery** — Mongolia imports all petroleum from Russia (extreme supply chain vulnerability)
- **Darkhan metallurgy** (steel/iron) — small, Soviet-era
- **No cement plants in GEM** (Mongolian cement exists but small)

## Validation

Mongolia implements environmental protection via:

- **Ministry of Environment and Tourism**
- **Environmental Protection Law (1995, amended)**
- Noise standards: minimal, based on WHO guidelines
- **UB ger district coal pollution** is Mongolia's #1 environmental crisis (PM2.5 among world's worst in winter — not noise, but related to the coal CHP plants that dominate the industrial layer)

Notable noise zones:

- **Ulaanbaatar** — extreme capital primacy (46% of population), congested city center + ger district sprawl
- **Trans-Mongolian Railway** — UB ↔ Darkhan ↔ Russia / UB ↔ Zamyn-Üüd ↔ China
- **Gobi mining truck corridor** — Oyu Tolgoi/Tavan Tolgoi ↔ China border (66% heavy share)
- **Chinggis Khaan International (UBN/ZMUB Ulaanbaatar — new airport 2021)**, **Darkhan**, **Choibalsan (COQ/ZMCD)** — covered by global aircraft layer
- **UB-4 CHP** (~889 MW — Mongolia's main power+heat source)
- **Erdenet copper mine**
- **Sainshand/Salkhit/Tsetsii wind farms** (Gobi)
