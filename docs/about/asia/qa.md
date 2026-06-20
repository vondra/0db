---
title: Qatar
intro: Noise mapping data sources for Qatar.
map: { center: [51.2, 25.3], zoom: 8 }
---

## Road traffic

### Road defaults

Qatar publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Qatar's traffic factor **≈ 1.275** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.275 ≈ 38,250 |
| Trunk | 15,000 × 1.275 ≈ 19,125 |
| Primary | 9,000 × 1.275 ≈ 11,475 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Qatari rail context

Qatar has **no intercity railway** — only urban transit built for FIFA 2022.

### Doha Metro
- **Opened 2019** — built specifically for FIFA 2022 World Cup. **3 lines (Red/Green/Gold), 76 km, 37 stations, driverless (Alstom)** — one of world's newest + most modern metro systems.

### Lusail Tram
- **Opened 2022** — **4 lines, ~19 km**, serves **Lusail City** (new planned city, FIFA 2022 World Cup final at Lusail Stadium).

**No intercity rail** (planned Qatar-Bahrain causeway rail + GCC Railway never built).

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 39 plants, 33 operating, ~13.4 GW

**Operating fuel**: oil/gas **28** + solar 4 + bioenergy 1. **100% gas-fired thermal** — Qatar sits on **North Field** (world's largest non-associated gas field, shared with Iran's South Pars).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Umm Al Houl** | **2,520** (2× 1,260) | oil/gas | **Qatar's newest mega desal+power** (IWPP) |
| **Ras Laffan B** | 1,025 | oil/gas | Ras Laffan Industrial City — tied to North Field LNG operations |
| **Ras Laffan C** | 2,732 (4× 683) | oil/gas | Ras Laffan expansion |
| **Ras Laffan A** | 756 | oil/gas | Total Ras Laffan complex **~4,513 MW** |
| **Qatalum CCGT** | 1,350 (2× 675) | oil/gas | Captive for **Qatalum aluminium smelter** (585 ktpa — one of world's largest single-site) |
| **Mesaieed CCGT** | 2,007 (3× 669) | oil/gas | Mesaieed Industrial City |
| **Al Kharsaah Solar** | **800** (450+350) | solar | **Qatar's first utility solar** (TotalEnergies/Marubeni, 2022 — for FIFA World Cup carbon commitment) |

All operating plants map to **NACE 35**.

### Qatar does NOT have

- **No open AADT** — Ashghal publishes nothing
- **No Doha Metro/Lusail Tram GTFS** (real-time app exists but no open feed)
- **QatarEnergy / North Field** not NACE 06 — **among the world's largest LNG exporters** (~77 Mtpa, North Field expansion to ~142 Mtpa planned by 2030). Shared with Iran's South Pars.
- **Qatargas/RasGas LNG trains** not NACE 19 — 14+ LNG trains at Ras Laffan (world's largest LNG complex)
- **Pearl GTL** (Shell) not NACE 19 — **world's largest gas-to-liquids plant** (140k bpd, $18.5B)
- **Oryx GTL** (Sasol/QatarEnergy) not NACE 19 — 34k bpd GTL
- **QAPCO/QChem/Q-Chem** (Mesaieed petrochemical) not NACE 20 — polyethylene + LDPE
- **Qatalum aluminium** not NACE 24 — **585 ktpa** (Hydro/QatarEnergy JV — one of world's largest single-site aluminium smelters)
- **Laffan Refinery** not NACE 19 — 292k bpd, processes North Field condensate

## Validation

Qatar implements environmental protection via:

- **Ministry of Environment and Climate Change**
- **Environmental Protection Law No. 30 of 2002**
- Noise standards: based on WHO + GCC guidelines
- Typical limits: residential 55/45 dBA day/night

Notable noise zones:

- **Doha expressways** (Lusail Expressway, Al Shamal, Corniche)
- **Doha Metro** (2019, 3 driverless lines) + **Lusail Tram** (2022)
- **Hamad International (DOH/OTHH — FIFA 2022 main hub, one of world's best-rated airports)** — covered by global aircraft layer
- **Ras Laffan Industrial City** (~4,513 MW power + LNG trains — **world's largest LNG complex**)
- **Umm Al Houl** (2,520 MW desal+power — Qatar's newest mega)
- **Mesaieed Industrial City** (2,007 MW + QAPCO/QChem petrochemical)
- **Pearl GTL** (world's largest gas-to-liquids, 140k bpd)
- **Qatalum aluminium** (585 ktpa)
- **Al Kharsaah Solar** (800 MW — Qatar's first utility solar)
- **Lusail City** (new planned city, FIFA 2022 final venue)
