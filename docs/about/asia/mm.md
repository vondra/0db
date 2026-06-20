---
title: Myanmar
intro: Noise mapping data sources for Myanmar.
map: { center: [96, 20], zoom: 5 }
---

## Road traffic

### Road defaults

Myanmar publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Myanmar's traffic factor **≈ 1.280** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.280 ≈ 38,400 |
| Trunk | 15,000 × 1.280 ≈ 19,200 |
| Primary | 9,000 × 1.280 ≈ 11,520 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **Yangon ↔ Mandalay Expressway** — 587 km (2010, Myanmar's only motorway, notorious for poor maintenance + accidents)
- **Yangon ↔ Mandalay** old road (via Bago, Meiktila) — the original trunk
- **Mandalay ↔ Myitkyina** (Kachin State, north — affected by civil conflict)
- **Mandalay ↔ Lashio** (Shan State, NE — China trade route)
- **Yangon ↔ Pathein** (Irrawaddy Delta, west)
- **Yangon ↔ Mawlamyine ↔ Myeik** (Mon/Tanintharyi, SE coast)

## Railway

### CNOSSOS class defaults

No Myanmar rail enricher runs and Myanma Railways publishes no GTFS, so rail noise uses the engine's CNOSSOS class defaults by OSM rail type — mainline heavy rail at 80 passenger + 20 freight trains/day, branch at 30 + 5. Myanmar's actual service is slow and sparse, so these generic defaults can overstate rail noise. The corridors are documented as context.

### Myanmar rail context

**Myanma Railways** operates ~6,000 km of meter gauge (1,000 mm) — one of SE Asia's most extensive but **extremely slow and unreliable** (British colonial-era infrastructure, minimal investment since independence 1948).

### Yangon Circular Railway
- **46 km commuter loop around Yangon**, **one of world's slowest urban rail at ~15 km/h** (3 hours for full loop)
- ~100,000 daily riders. **JR East (Japan) upgrading** since 2017 as part of ODA
- 39 stations, ~20 trains/day in each direction

### Yangon ↔ Mandalay Main Line
- **~620 km**, officially 14-16 hours (should be 6 hours but tracks are terrible)
- Myanmar's most important rail corridor

### Other lines
- **Mandalay ↔ Myitkyina** — northern line to Kachin (affected by civil conflict)
- **Mandalay ↔ Lashio** — Shan State (historic Gokteik Viaduct — the **world's largest railway trestle** when completed ~1900, with the tallest piers of its day; not the highest railway bridge)
- **Yangon ↔ Mawlamyine ↔ Ye** — Mon State coast

**No metros, no modern urban rail** (Yangon Circular is classified as suburban/commuter, not metro).

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 203 plants, 55 operating, ~5.66 GW

Power-plant points from **GEM Global Integrated Power** (filtered to `Country_area='Myanmar'`, operating only) are spatial-joined to OSM industrial polygons, overriding the lower-priority global GPPD baseline.

**Operating fuel**: solar 19 + hydropower 17 + oil/gas 15 + coal 3 + wind 1. **Hydro-dominated** with significant gas fleet.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Yeywa** | 790 | hydropower | Myitnge River — Myanmar's largest operating plant |
| **Shweli 1** | 600 | hydropower | Shweli River (Shan/Chinese border — exports to China) |
| **Paung Laung** | 280 | hydropower | |
| **Dapein 1** | 240 | hydropower | Kachin (Chinese-built, exports to Yunnan) |
| **Mawlamyine** | 230 | oil/gas | Mon State |
| **Myingyan** | 225 | oil/gas | Mandalay Region |
| **Kyaukpadaung Wind** | ~200 | wind | Planned Rosatom/NovaWind project (MOU/feasibility stage) — Myanmar has essentially no operating grid wind |
| **Baluchaung 2** | 168 | hydropower | Kayah State — Myanmar's oldest major hydro (1960s, built by Japanese WWII reparations) |
| **Hlawga/Ahlone/Ywama** | ~400+ total | oil/gas | Yangon thermal cluster |
| **19 solar plants** | ~500+ total | solar | Recent additions |

All operating plants map to **NACE 35**.

### Not captured / context

- **No open AADT** — military junta regime restricts all data publication; roads use CNOSSOS class defaults
- **No Myanma Railways GTFS** — rail uses CNOSSOS class defaults
- **Yadana/Yetagun/Shwe offshore gas** — TotalEnergies, PTTEP, POSCO; TotalEnergies **exited 2022** over junta human-rights concerns. Gas pipeline to Thailand (Yadana→Ratchaburi). Offshore extraction is not in the power-plant dataset
- **Hpakant jade mines** (Kachin) — **world's richest jade source**, valued at up to ~$31B/year at the 2014 peak (Global Witness 2015 upper-bound estimate; much trade illegal, fuels conflict). Not in scope
- **Monywa copper** (Wanbao/NORINCO Chinese) — captured only as OSM `landuse=industrial`
- **No.1 Iron & Steel** (Myingyan) — small; captured globally only if matched by the GEM Iron & Steel tracker above its capacity threshold, else as OSM `landuse=industrial`
- **Thilawa SEZ** (Japanese-backed, near Yangon) — manufacturing zone
- **Cement**: Myaing, Max Myanmar — captured globally only if matched by the GEM Cement tracker above its capacity threshold, else as OSM `landuse=industrial`
- **Military junta since February 2021** — civil war affecting data + infrastructure across Shan, Kachin, Kayah, Chin, Sagaing

## Validation

Myanmar has minimal environmental regulation enforcement under the military junta:

- **Environmental Conservation Department** — under military control since 2021
- **Environmental Conservation Law (2012)** — pre-coup framework
- Noise standards: poorly enforced, nominally similar to WHO guidelines
