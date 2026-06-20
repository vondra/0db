---
title: Serbia
intro: Noise mapping data sources for Serbia.
map: { center: [20.9, 44.2], zoom: 7 }
---

## Road traffic

### Road defaults

Serbia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Serbia's traffic factor **≈ 0.920** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.920 ≈ 27,600 |
| Trunk | 15,000 × 0.920 ≈ 13,800 |
| Primary | 9,000 × 0.920 ≈ 8,280 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Serbian rail context

**Železnice Srbije** operates ~3,800 km of **standard gauge (1,435 mm)**. Belgrade is a **major Balkan rail hub** (Corridor X crossroads).

### BeoVoz (Belgrade commuter rail)
- **2 lines, 41 km, ~55k daily** — revived 2010 after 1999 NATO bombing damage to central station. **Belgrade Metro Line 1** under construction (~2028) — NOT yet operating.

### Main trunk (Corridor X)
- **Belgrade ↔ Novi Sad ↔ Subotica ↔ Budapest** (north — **Chinese-financed HSR upgrade 200 km/h under construction**, Belgrade-Budapest Chinese railway)
- **Belgrade ↔ Niš ↔ Vranje ↔ North Macedonia/Bulgaria** (south — Corridor X)

### Bar branch
- **Belgrade ↔ Čačak ↔ Bar (Montenegro)** — one of **Europe's most scenic railway lines** (476 tunnels, 435 bridges, Mala Rijeka Viaduct — one of world's highest railway bridges)

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 148 plants, 44 operating, ~7.3 GW

**Operating fuel**: coal **18** + solar 8 + wind 7 + hydropower 6 + oil/gas 4 + bioenergy 1. **Coal-dominant** — lignite from Kolubara/Kostolac basins.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **TENT Nikola Tesla** | **~2,837** (7 units) | coal (lignite) | **Obrenovac** — Serbia's backbone, **50%+ of national generation**. Fed by Kolubara lignite basin. One of Europe's largest coal plants. |
| **Kostolac B** | 1,260 (4 units) | coal | Kostolac/Viminacium |
| **Bajina Basta pumped** | 614 | hydropower | **Drina River** — pumped storage |
| **Bajina Basta** | 420 | hydropower | Drina conventional |
| **Čibuk 1 Wind** | 158 | wind | **Serbia's first large wind farm** (Masdar/EDF, 2019) |
| **Pančevo** | 189 | oil/gas | NIS refinery captive |
| **Various wind + solar** | ~700+ | renewable | Growing post-2019 |

**NOTE**: **Đerdap/Iron Gates I+II (~1,160 MW Serbia's half)** is listed under Romania in GEM (border dam on Danube — one of Europe's largest hydropower).

All operating plants map to **NACE 35**.

### Serbia does NOT have

- **No open AADT** — Putevi Srbije publishes nothing (despite EU candidate status)
- **No Železnice Srbije GTFS**
- **NIS refinery Pančevo** not NACE 19 — **Gazprom Neft-controlled** (100k bpd, Russian ownership since 2008)
- **HBIS Smederevo** not NACE 24 — former US Steel (sold to Chinese HBIS 2016 — politically controversial)
- **RTB Bor copper** not NACE 07 — one of Europe's largest copper mines (state-owned, ZIJIN Mining since 2018)
- **Kolubara lignite basin** not NACE 05 — feeds TENT (20+ Mtpa, one of Europe's largest open-pit lignite operations)
- **Stellantis/Fiat Kragujevac** not NACE 29 — Fiat 500L production (Serbia's largest single FDI)
- **Cement**: CRH (Kosjerić), Lafarge (Beočin) — not NACE 23
- **Kosovo** — disputed territory (not included in Serbia bbox per current borders, separate ISO 3166 XK)

## Validation

Serbia implements environmental protection via:

- **Ministry of Environmental Protection**
- **Environmental Protection Law (2004, amended)**
- **Environmental Noise Law (2009)** — EU-harmonized (as EU candidate), strategic noise maps required for Belgrade
- Typical limits: residential 55/45 dBA Lden/Lnight (EU-aligned)
- Serbia is required to prepare END-style strategic noise maps for Belgrade agglomeration under EU accession

Notable noise zones:

- **E75 Corridor X** (Belgrade↔Niš↔North Macedonia/Bulgaria + Belgrade↔Novi Sad↔Hungary)
- **Belgrade** (Danube+Sava, Gazela/Ada bridges, heavy congestion)
- **BeoVoz commuter** + **Belgrade-Bar scenic railway**
- **Belgrade Nikola Tesla International (BEG/LYBE)**, **Niš Constantine the Great (INI/LYNI)** — covered by global aircraft layer
- **TENT Nikola Tesla** (~2,837 MW lignite — Europe's one of largest remaining coal plants, environmental concerns)
- **Kostolac** (1,260 MW coal)
- **NIS Pančevo refinery** (Gazprom Neft, 100k bpd)
- **HBIS Smederevo steel** (Chinese-owned)
- **RTB Bor copper** (ZIJIN Mining)
- **Kolubara lignite mines** (Obrenovac open-pit — 20+ Mtpa)
