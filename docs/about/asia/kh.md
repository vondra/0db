---
title: Cambodia
intro: Noise mapping data sources for Cambodia.
map: { center: [105, 12.5], zoom: 7 }
---

## Road traffic

### Class defaults only

MPWT (Ministry of Public Works and Transport) publishes no open GIS. Fall back to CNOSSOS class defaults with Phnom Penh Tier-1 boost.

### Cambodian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (PP-SHV Expressway, 190 km, 2022 Chinese-built) | 30,000 | 60,000 | 42,000 |
| 1 trunk (NR routes) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metro** (×2.0): **Phnom Penh** (~2.3M — capital, at Mekong/Tonle Sap/Bassac confluence, "Pearl of Asia").

**Tier-2 cities** (×1.4): **Siem Reap** (~250k, **Angkor Wat** tourism), **Sihanoukville** (~200k, beach resort + **massive Chinese investment boom 2017-2023** transforming city), Battambang (~200k, rice capital), Kampong Cham, **Poipet** (Thailand border town, casinos), Kampong Speu, Takeo, Svay Rieng, Prey Veng, Kampot, Koh Kong.

### Cambodian vehicle split

Cambodia has **extreme motorcycle dominance** — ~70% of households own a motorcycle, highest in SE Asia after Vietnam:

| Tier | Light | Medium (tuk-tuk) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Phnom Penh) | 30% | 12% | 12% | **46%** |
| Tier-2 | 25% | 10% | 15% | **50%** |
| Rural | 20% | 5% | 25% | **50%** |
| **PP-SHV Expressway (2022)** | 60% | 5% | **30%** | 5% (motos banned) |

### National route network

- **PP-SHV Expressway** — 190 km (2022, Chinese-built, Cambodia's **first motorway**)
- **NR1** — Phnom Penh ↔ Svay Rieng ↔ Bavet (Vietnam border — Ho Chi Minh route)
- **NR4** — Phnom Penh ↔ Sihanoukville (old road, parallel to expressway)
- **NR5** — Phnom Penh ↔ Battambang ↔ Poipet (Thailand border)
- **NR6** — Phnom Penh ↔ Siem Reap (Angkor Wat tourist route)
- **NR7** — Phnom Penh ↔ Kampong Cham ↔ Stung Treng ↔ Laos border

## Railway

### Class defaults + corridor bbox boosts

### Cambodian rail context

**Royal Railway of Cambodia** operates ~650 km of meter gauge (1,000 mm) — **revived 2016** after total closure in 2009. Very limited service.

### Southern Line (PP ↔ Sihanoukville)
- **264 km**, revived 2016 — **Cambodia's main passenger rail**
- **Only 1 train per day each way** (PP 7:00 → SHV 14:00)
- Rehabilitated with ADB funding

### Northern Line (PP ↔ Poipet/Thailand)
- **386 km**, resumed 2018 — **freight only** (connects to Thai rail at Poipet/Aranyaprathet)
- Planned cross-border passenger service to Bangkok (not yet operational)

**No metros, no trams, no urban commuter rail** in any Cambodian city.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **PP↔Sihanoukville** (southern, revived 2016) | 1 | 2 |
| **PP↔Poipet/Thailand** (northern, freight only) | 0 | 3 |
| Other/branch | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 81 plants, 43 operating, ~4.06 GW

**Operating fuel**: solar 23 + coal 10 + hydropower 6 + oil/gas 4.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Lower Sesan 2** | 400 | hydropower | Mekong tributary — **controversial** (flooded Stung Treng indigenous villages, displaced ~5,000 people) |
| **Sihanoukville CIIDG** | 970 (350+350+135+135) | coal | Chinese-built coal complex — **Cambodia's largest thermal cluster** |
| **Stung Tatay** | 246 | hydropower | Koh Kong, Chinese-built |
| **Russei Chrum** | 338 (206+132) | hydropower | |
| **Kamchay** | 194 | hydropower | Chinese Sinohydro-built — **Cambodia's first modern hydro (2011)** |
| **Sihanoukville CEL** | 150 | coal | |
| **C7 / Phnom Penh / Kandal** | ~800 | oil/gas | Phnom Penh area thermal fleet |
| **23 solar plants** | ~600+ | solar | Recent buildout |

All operating plants map to **NACE 35**.

### Cambodia does NOT have

- **No MPWT AADT** — zero open traffic data
- **No Royal Railway GTFS**
- **Garment factories** (Phnom Penh/Kandal/Kampong Speu) not NACE 13/14 — **world's #7 garment exporter** (after China, Bangladesh, Vietnam, India, Turkey, Indonesia)
- **Sihanoukville Port** — deep-water, massive Chinese investment zone
- **Phnom Penh Autonomous Port** — Mekong river port
- **Cement**: Chip Mong, Thai Boon Roong — not NACE 23
- **No oil/gas industry** — Cambodia imports all petroleum
- **Tonle Sap Lake** — world's largest freshwater fishing ground, seasonal flood reversal

## Validation

Cambodia implements environmental protection via:

- **Ministry of Environment**
- **Environmental Protection and Natural Resource Management Law (1996)**
- Noise standards: poorly developed and enforced
- Phnom Penh is ranked among SE Asia's noisiest cities (motorcycles + construction)
