---
title: Cambodia
intro: Noise mapping data sources for Cambodia.
map: { center: [105, 12.5], zoom: 7 }
---

## Road traffic

### Road defaults

Cambodia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Cambodia's traffic factor **≈ 0.763** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.763 ≈ 22,890 |
| Trunk | 15,000 × 0.763 ≈ 11,445 |
| Primary | 9,000 × 0.763 ≈ 6,867 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **PP-SHV Expressway** — 190 km (2022, Chinese-built, Cambodia's **first motorway**)
- **NR1** — Phnom Penh ↔ Svay Rieng ↔ Bavet (Vietnam border — Ho Chi Minh route)
- **NR4** — Phnom Penh ↔ Sihanoukville (old road, parallel to expressway)
- **NR5** — Phnom Penh ↔ Battambang ↔ Poipet (Thailand border)
- **NR6** — Phnom Penh ↔ Siem Reap (Angkor Wat tourist route)
- **NR7** — Phnom Penh ↔ Kampong Cham ↔ Stung Treng ↔ Laos border

## Railway

### CNOSSOS class defaults

No Cambodia rail enricher runs and no Royal Railway GTFS exists, so rail noise uses the engine's CNOSSOS class defaults by OSM rail type — mainline heavy rail at 80 passenger + 20 freight trains/day, branch at 30 + 5 (these are the generic worldwide defaults, **not** the actual very-sparse Cambodian service described below). The corridors are documented as context.

### Cambodian rail context

**Royal Railway of Cambodia** operates ~650 km of meter gauge (1,000 mm) — **revived 2016** after total closure in 2009. Very limited service.

### Southern Line (PP ↔ Sihanoukville)
- **264 km**, revived 2016 — **Cambodia's main passenger rail**
- Passenger trains run mainly on **weekends/holidays** (weekdays are largely freight)
- Rehabilitated with ADB funding

### Northern Line (PP ↔ Poipet/Thailand)
- **386 km**, resumed 2018 — **freight only** (connects to Thai rail at Poipet/Aranyaprathet)
- Planned cross-border passenger service to Bangkok (not yet operational)

**No metros, no trams, no urban commuter rail** in any Cambodian city.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 81 plants, 43 operating, ~4.06 GW

Power-plant points from **GEM Global Integrated Power** (filtered to `Country_area='Cambodia'`, operating only) are spatial-joined to OSM industrial polygons, overriding the lower-priority global GPPD baseline.

**Operating fuel**: solar 23 + coal 10 + hydropower 6 + oil/gas 4.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Lower Sesan 2** | 400 | hydropower | Mekong tributary — **controversial** (flooded Stung Treng indigenous villages, displaced ~5,000 people) |
| **Sihanoukville CIIDG** | ~1,105 (CIIDG-2 2×350 + CIIDG-1 3×135) | coal | Chinese-built coal complex — **Cambodia's largest thermal cluster** |
| **Stung Tatay** | 246 | hydropower | Koh Kong, Chinese-built |
| **Russei Chrum** | 338 (206+132) | hydropower | |
| **Kamchay** | 194 | hydropower | Chinese Sinohydro-built — **Cambodia's first modern hydro (2011)** |
| **Sihanoukville CEL** | 150 | coal | |
| **C7 / Phnom Penh / Kandal** | ~800 | oil/gas | Phnom Penh area thermal fleet |
| **23 solar plants** | ~600+ | solar | Recent buildout |

All operating plants map to **NACE 35**.

### Not captured / context

- **No MPWT AADT** — zero open traffic data; roads use CNOSSOS class defaults
- **No Royal Railway GTFS** — rail uses CNOSSOS class defaults
- **Garment factories** (Phnom Penh/Kandal/Kampong Speu) — among the world's top-10 garment exporters (~#8, behind China, Bangladesh, Vietnam, India, Turkey, Indonesia, etc.). Not power plants; captured only where OSM tags `landuse=industrial`
- **Sihanoukville Port** — deep-water, massive Chinese investment zone
- **Phnom Penh Autonomous Port** — Mekong river port
- **Cement**: Chip Mong, Thai Boon Roong — captured globally only if matched by the GEM Cement tracker above its capacity threshold, else only as OSM `landuse=industrial`
- **No oil/gas industry** — Cambodia imports all petroleum
- **Tonle Sap Lake** — world's largest freshwater fishing ground, seasonal flood reversal

## Validation

Cambodia implements environmental protection via:

- **Ministry of Environment**
- **Environmental Protection and Natural Resource Management Law (1996)**
- Noise standards: poorly developed and enforced
- Phnom Penh is ranked among SE Asia's noisiest cities (motorcycles + construction)
