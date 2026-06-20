---
title: Azerbaijan
intro: Noise mapping data sources for Azerbaijan.
map: { center: [49, 40.5], zoom: 7 }
---

## Road traffic

### Road defaults

Azerbaijan publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Azerbaijan's traffic factor **≈ 1.118** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.118 ≈ 33,540 |
| Trunk | 15,000 × 1.118 ≈ 16,770 |
| Primary | 9,000 × 1.118 ≈ 10,062 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Azerbaijani rail context

**ADY (Azərbaycan Dəmir Yolları)** operates ~2,900 km of **broad gauge (1,520 mm)**.

### Baku Metro
- **Opened 1967** — the Caucasus' second metro (Tbilisi opened a year earlier, 1966). **3 lines, ~40 km, 27 stations**, ~600k daily. Soviet ornate stations.

### BTK Railway (Baku-Tbilisi-Kars)
- **Opened 2017** — connects Azerbaijan → Georgia → Turkey. **Part of "Middle Corridor" (Trans-Caspian International Transport Route)** — China → Central Asia → Caspian ferry → Azerbaijan → Turkey → Europe, **bypassing Russia**.

### Main trunk
- **Baku ↔ Ganja ↔ Georgia border** — ADY main line

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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
