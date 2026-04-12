---
title: Iraq
intro: Noise mapping data sources for Iraq.
map: { center: [44, 33.5], zoom: 5 }
---

## Road traffic

### Class defaults only

Iraqi MoT publishes no open AADT. Fall back to class defaults with Baghdad ×2.5 megacity boost.

### Iraqi AADT defaults

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.6) | Tier-3 (×1.3) |
|---|---:|---:|---:|---:|
| 0 motorway (Baghdad expressways, Highway 1) | 40,000 | 100,000 | 64,000 | 52,000 |
| 1 trunk | 18,000 | 45,000 | 28,800 | 23,400 |
| 2 primary | 9,000 | 22,500 | 14,400 | 11,700 |
| 3 secondary | 4,500 | 11,250 | 7,200 | 5,850 |
| 4 tertiary | 2,000 | 5,000 | 3,200 | 2,600 |
| 5 residential | 800 | 2,000 | 1,280 | 1,040 |

**Tier-1 megacity** (×2.5): **Baghdad** (~8M — Tigris bisects the city, extreme congestion, one of Middle East's largest cities).

**Tier-2 cities** (×1.6): **Basra** (~2.5M — **Iraq's oil capital + only port**, Shatt al-Arab), **Erbil** (~1.5M — **KRG Kurdistan capital**, booming), **Sulaymaniyah** (~800k — KRG 2nd city).

**Tier-3 cities** (×1.3): **Mosul** (~2M — heavily damaged in ISIS battle 2014-2017, rebuilding), **Najaf** (~1M — **Shia holy city**, Imam Ali Shrine), **Karbala** (~1M — **Shia holy city**, 20M+ pilgrims/year for Arbaeen — **world's largest annual gathering**), **Kirkuk** (~600k — oil, ethnically disputed), Nasiriyah, Hillah, Diwaniyah, Kut, Tikrit, Samarra, Fallujah, Ramadi, Amara.

### Iraqi vehicle split

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Baghdad) | 60% | 10% | 22% | 8% |
| Tier-2 | 58% | 8% | 26% | 8% |
| Rural | 50% | 5% | 38% | 7% |
| **Basra oil corridor** | 35% | 3% | **58%** | 4% |

## Railway

### Class defaults + corridor bbox boosts

### Iraqi rail context

**Iraqi Republic Railways** operates ~2,400 km of standard gauge (1,435 mm) — **mostly non-functional** post-2003 invasion + ISIS destruction 2014-2017. Baghdad-Basra is the only partially restored regular service. **Baghdad has NO metro** (planned but never built).

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Baghdad↔Basra main line** (partially restored) | 3 | 4 |
| Other (near-dead network) | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 388 plants, 246 operating, ~50.5 GW

**Operating fuel**: oil/gas **231** + solar 8 + hydropower 7. **Overwhelmingly gas-fired** — Iraq has **world's 5th largest oil reserves** (~145 Bbbl) but flares **~18 Bcm/year of associated gas** (world's 2nd worst after Russia).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Besmaya** | **4,500** (6× 750) | oil/gas | GE gas turbines, 30 km SE of Baghdad — **Iraq's largest single complex** |
| **Mosul Dam** | **1,052** | hydropower | **Tigris River** — **ONE OF WORLD'S MOST DANGEROUS DAMS** (geological instability, requires 24/7 grouting to prevent catastrophic collapse that could flood Mosul + Baghdad) |
| **Maisan Oil Energy** | 987 | oil/gas | Amarah area |
| **Erbil** | 1,500 (2× 750) | oil/gas | **KRG Kurdistan** |
| **Sulaymaniyah** | 1,500 (2× 750) | oil/gas | KRG |
| **Haditha Dam** | 660 | hydropower | Euphrates |
| **Salahuddin** | 630 | oil/gas | |
| **Al Amarh** | 750 | oil/gas | |
| **231 gas/oil plants total** | ~47+ GW | oil/gas | Massive distributed fleet across Iraq |

All operating plants map to **NACE 35**.

### Iraq does NOT have

- **No open AADT** — all destroyed infrastructure
- **No Iraqi Railways GTFS** (partially restored Baghdad-Basra only)
- **Rumaila oil field** (Basra) not NACE 06 — **world's 6th largest** (~1.5 Mbbl/day, BP/PetroChina/SOMO)
- **West Qurna 1** (ExxonMobil) + **West Qurna 2** (LUKOIL) — super-giant fields
- **Zubair** (ENI) + **Majnoon** (Shell exited 2018) — major fields
- **Basra Gas Company** (Shell-led — captures flared associated gas)
- **~18 Bcm/year gas flaring** — world's 2nd worst (massive noise + pollution source)
- **Baiji refinery** (315k bpd — destroyed by ISIS 2014, partially restored)
- **Doura refinery** (Baghdad) + **Basra refinery** — not NACE 19
- **KRG refineries** (Bazian, Tawke) — autonomous Kurdistan
- **Cement**: Karbala, Samawah, Muthanna
- **Karbala Arbaeen pilgrimage** — 20M+ annual gathering (world's largest — extreme temporary noise)
- **ISIS destruction 2014-2017** — Mosul, Tikrit, Ramadi, Fallujah heavily damaged (rebuilding)

## Validation

Iraq has minimal functioning environmental regulation:

- **Ministry of Environment** (re-established post-2003)
- **Environmental Protection Law No. 27 of 2009**
- Noise standards: minimal enforcement, WHO-based nominally
- **Baghdad is one of the noisiest cities in the Middle East** — diesel generators (12-20h blackouts similar to Lebanon), traffic congestion, security sirens

Notable noise zones:

- **Baghdad** (~8M — Tigris, extreme congestion, generators running during blackouts)
- **Basra oil corridor** (Rumaila + West Qurna + Zubair — 58% heavy)
- **Highway 1 Baghdad ↔ Fallujah ↔ Ramadi**
- **Baghdad-Basra railway** (partially restored)
- **Baghdad International (BGW/ORBI)**, **Basra International (BSR/ORMM)**, **Erbil International (EBL/ORER)**, **Sulaymaniyah International (ISU/ORSU)**, **Najaf Al Ashraf (NJF/ORNI)** — covered by global aircraft layer
- **Besmaya** (4,500 MW — Iraq's largest)
- **Mosul Dam** (1,052 MW — world's most dangerous dam)
- **Basra Gas Company** + **gas flaring** (~18 Bcm/year)
- **Baiji refinery** (partially restored post-ISIS)
- **Karbala Arbaeen** (world's largest annual gathering — extreme temporary)
