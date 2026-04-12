---
title: Sudan
intro: Noise mapping data sources for Sudan.
map: { center: [30, 16], zoom: 5 }
---

## Road traffic

### Class defaults only

Sudan Ministry of Roads publishes no open AADT. CNOSSOS class defaults with Khartoum Tier-1 boost. Civil war since April 2023 has destroyed much of Khartoum's urban fabric and disrupted data.

### Sudanese AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Khartoum ring roads) | 30,000 | 60,000 | 42,000 |
| 1 trunk (main paved national roads) | 8,000 | 16,000 | 11,200 |
| 2 primary | 3,500 | 7,000 | 4,900 |
| 3 secondary | 1,500 | 3,000 | 2,100 |
| 4 tertiary | 600 | 1,200 | 840 |
| 5 residential | 300 | 600 | 420 |

**Tier-1 metro** (×2.0): **Khartoum** (~6M, 3-city metro — Khartoum + Omdurman + Khartoum North at Blue/White Nile confluence; heavily damaged in 2023+ civil war).

**Tier-2 cities** (×1.4): **Port Sudan** (~400k — Red Sea; main functional port), **Kassala** (~650k — Eritrean border), **El Obeid** (~400k — North Kordofan; gum arabic), **Wad Madani** (~400k — Blue Nile; fell to RSF Jan 2024), **Atbara** (~120k — railway junction), **Gedaref** (~350k — Gedaref State; sorghum), **El Fasher** (~400k — North Darfur capital; besieged since April 2023).

### Sudanese vehicle split

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Khartoum) | 55% | 12% | 18% | 15% |
| Tier-2 | 50% | 10% | 22% | 18% |
| Rural | 40% | 8% | 35% | 17% |
| **Khartoum–Port Sudan corridor** | 35% | 8% | 50% | 7% |

## Railway

### Sudan Railways Corporation (SRC) — 17k segments modelled

**~4,750 km narrow-gauge (1,067 mm)** network — one of Africa's largest historically, now severely degraded. Low operational frequency; class defaults applied.

### trains/day defaults

| Line | pax/day | frt/day |
|---|---:|---:|
| **Khartoum–Port Sudan** (1,169 km — main freight) | 1 | 3 |
| **Khartoum–Atbara–Wadi Halfa** (north, Nile valley) | 1 | 1 |
| **Khartoum–Sennar–El Obeid** (western, gum arabic) | 1 | 2 |
| **Sennar–Kassala–Port Sudan** (eastern) | 0 | 1 |

### Route network
- **Khartoum–Port Sudan** — main export/import artery; partially functional
- **Khartoum–Wadi Halfa** — Nile valley north; tourist Aswan route (largely inoperable)
- **Khartoum–El Obeid** — western Sudan; gum arabic corridor

## Industrial

### GEM — 26 plants, operating, 4,150 MW

**Merowe Dam 1,250 MW** (Nile, north of Khartoum) dominates. Chinese-built (Harbin Electric/CMEC, 2009); 10 Francis turbines × 125 MW each. Sudan's largest power plant.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Merowe Dam** | 1,250 | hydropower | Nile north; Chinese-built (2009) |
| **Khartoum North Thermal** | 1,000+ | gas/HFO | Multiple units; Khartoum North |
| **Roseires Dam** | 280 | hydropower | Blue Nile; raised 2013 (new 355 MW capacity) |
| **Garri CCGT** | 240 | gas | Khartoum North |
| **Burri Thermal** | 200 | gas/HFO | Khartoum |
| **Jebel Aulia** | 30 | hydropower | White Nile, south Khartoum |
| **Sennar Dam** | 17 | hydropower | Blue Nile, historic 1925 |

All operating plants map to **NACE 35**.

### Sudan does NOT have
- **No GERD** — Grand Ethiopian Renaissance Dam is on Ethiopian territory; Sudan is downstream
- **Darfur fields** — oil fields in South Kordofan/Blue Nile/Abyei (disputed with South Sudan); Khartoum North refinery closed since 2023 civil war
- **Gum arabic** — 80% of world supply; not NACE-classified but economically critical
- **No GTFS** — Sudan Railways has no GTFS
