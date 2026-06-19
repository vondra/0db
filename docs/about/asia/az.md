---
title: Azerbaijan
intro: Noise mapping data sources for Azerbaijan.
map: { center: [49, 40.5], zoom: 7 }
---

## Road traffic

### Class defaults only

AYO publishes no open AADT. Fall back to class defaults with Baku Tier-1 boost.

### Azerbaijani AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (M1 Baku-Guba, M3 upgrading) | 30,000 | 60,000 | 42,000 |
| 1 trunk | 14,000 | 28,000 | 19,600 |
| 2 primary | 7,000 | 14,000 | 9,800 |
| 3 secondary | 3,500 | 7,000 | 4,900 |
| 4 tertiary | 1,600 | 3,200 | 2,240 |
| 5 residential | 700 | 1,400 | 980 |

**Tier-1 metro** (×2.0): **Baku** (~2.3M — capital, Caspian coast, UNESCO old city + futuristic Flame Towers, **COP29 host 2024**).

**Tier-2 cities** (×1.4): **Ganja** (~330k, 2nd city, western AZ), **Sumgayit** (~350k, industrial satellite of Baku — **Soviet-era chemical, one of Caspian's most polluted cities**), **Mingachevir** (~100k, hydro/power hub), Lankaran (~80k, south Caspian, Iran border), Shirvan, Shaki (NW, silk road), **Nakhchivan City** (~90k, exclave capital).

### Azerbaijani vehicle split

Oil-rich country with high car ownership, low motorcycle (Caucasus pattern):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Baku) | 70% | 8% | 16% | 6% |
| Tier-2 | 66% | 6% | 22% | 6% |
| Rural | 58% | 4% | 33% | 5% |
| **M3 Baku↔Ganja** | 60% | 3% | **33%** | 4% |

## Railway

### Class defaults + corridor bbox boosts

### Azerbaijani rail context

**ADY (Azərbaycan Dəmir Yolları)** operates ~2,900 km of **broad gauge (1,520 mm)**.

### Baku Metro
- **Opened 1967** — the Caucasus' second metro (Tbilisi opened a year earlier, 1966). **3 lines, ~40 km, 27 stations**, ~600k daily. Soviet ornate stations.

### BTK Railway (Baku-Tbilisi-Kars)
- **Opened 2017** — connects Azerbaijan → Georgia → Turkey. **Part of "Middle Corridor" (Trans-Caspian International Transport Route)** — China → Central Asia → Caspian ferry → Azerbaijan → Turkey → Europe, **bypassing Russia**.

### Main trunk
- **Baku ↔ Ganja ↔ Georgia border** — ADY main line

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Baku Metro (1967)** | 300 | 0 |
| **BTK / Main Trunk** (Baku↔Ganja↔Georgia) | 6 | 10 |
| Other/branch | 2 | 4 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 68 plants, 44 operating, ~7.42 GW

**Operating fuel**: oil/gas **23** + solar 13 + hydropower 6 + wind 1 + bioenergy 1. **Gas/oil dominant** — Caspian petroleum economy.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Azerbaijan TPS (Mingachevir)** | **~1,800** (6× 300) | oil/gas | Kur/Kura River — Azerbaijan's largest thermal complex (renamed from "Azərbaycan" TPS) |
| **Sumgayit** | 525 | oil/gas | Industrial satellite of Baku |
| **Shimal** | 800 (2× 400) | oil/gas | "North" power station |
| **Janub** | 780 (2× 390) | oil/gas | "South" power station |
| **Mingachevir hydro** | **424** | hydropower | **Kur/Kura River — Azerbaijan's largest hydro** |
| **Shamkir hydro** | 380 | hydropower | Kur River cascade |
| **Gobu** | 384 | oil/gas | Near Baku |
| **Sangachal** | 308 | oil/gas | Near Sangachal oil terminal |
| **Baku Wind Energy** | 240 | wind | Absheron peninsula — Azerbaijan's first significant wind farm |
| **13 solar plants** | ~300 total | solar | Recent growth |

All operating plants map to **NACE 35**.

### Azerbaijan does NOT have

- **No open AADT** — AYO publishes nothing
- **No ADY GTFS**
- **ACG (Azeri-Chirag-Gunashli)** offshore not NACE 06 — **BP-operated, "Contract of the Century" 1994**, Caspian's largest producing oil field
- **Shah Deniz** gas not NACE 06 — BP-operated, world-class (feeds TANAP/TAP to Europe)
- **BTC Pipeline** (1,768 km Baku→Tbilisi→Ceyhan Turkey) not NACE 19
- **SCP/TANAP/TAP** gas pipeline system (Azerbaijan→Georgia→Turkey→Greece→Italy — "Southern Gas Corridor") not NACE 19
- **Heydar Aliyev/SOCAR refinery** (Baku, ~6.5 Mt/yr ≈ 125k bpd) not NACE 19
- **Sumgayit chemical** — Soviet-era, one of Caspian's most polluted cities (aluminum, chlorine, synthetic rubber)
- **ArcelorMittal Baku** — steel, not NACE 24
- **Nakhchivan exclave** — separated from mainland by Armenia (borders with Armenia closed since 1993)
- **SOCAR** — State Oil Company of Azerbaijan, one of Caspian's largest operators

## Validation

Azerbaijan implements environmental protection via:

- **Ministry of Ecology and Natural Resources**
- **Law on Environmental Protection (1999)**
- **COP29 host 2024** — Baku (ironic given oil dependence)
- Noise standards: post-Soviet GOST-based

Notable noise zones:

- **Baku** — Caspian coast, dense urban + construction boom (Flame Towers district)
- **M3 Baku↔Ganja** — main east-west corridor
- **Baku Metro** (1967, Soviet-era, 600k daily)
- **BTK Railway** (2017, Middle Corridor — growing China→Europe transit)
- **Heydar Aliyev International (GYD/UBBB Baku)**, **Ganja (KVD/UBBG)**, **Lankaran (LLK/UBBL)**, **Nakhchivan (NAJ/UBBN)** — covered by global aircraft layer
- **Azerbaijan TPS Mingachevir** (~1,800 MW)
- **Mingachevir hydro** (424 MW)
- **SOCAR refinery** (Baku, ~125k bpd)
- **Sangachal oil terminal** — BP's main Caspian export hub (BTC/SCP origin)
- **Sumgayit industrial zone** (Soviet-era chemical, major pollution legacy)
- **ACG offshore platforms** (Caspian — BP-operated)
