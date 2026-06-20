---
title: Nepal
intro: Noise mapping data sources for Nepal.
map: { center: [84, 28.5], zoom: 6 }
---

## Road traffic

### Road defaults

Nepal publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Nepal's traffic factor **≈ 1.221** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.221 ≈ 36,630 |
| Trunk | 15,000 × 1.221 ≈ 18,315 |
| Primary | 9,000 × 1.221 ≈ 10,989 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **Prithvi Highway** — Kathmandu ↔ Pokhara (~200 km — **Nepal's main corridor**, extremely winding through gorges, heavy truck traffic + tourist buses)
- **Mahendra Highway** — east-west Terai trunk (Mechinagar ↔ Mahendranagar, ~1,000 km along India border plains)
- **Tribhuvan Highway** — Kathmandu ↔ Birgunj/India (oldest highway, 1956)
- **Arniko Highway** — Kathmandu ↔ Kodari/China border (**damaged by 2015 earthquake**, partially reopened)
- **BP Koirala Highway** — Birgunj ↔ Bardibas (Terai connector)
- **Kathmandu-Terai/Madhesh Fast Track** — under construction (76 km, Nepal's first motorway-grade road)

## Railway

### Nepal has NO significant operating railway

Nepal has **never had a meaningful railway network**. The ~51 km **Janakpur-Jaynagar narrow gauge (762 mm)** — built 1937 — was **discontinued**; a rebuilt Indian broad-gauge (1,676 mm) line reopened in stages (Jaynagar↔Kurtha 2022, Kurtha↔Bijalpura 2023) with minimal service. The planned **East-West Electric Railway** (~1,318 km across Terai) and **Nijgadh-Kathmandu** rail are **not built**. Railway enrichment was **skipped entirely** — any OSM rail falls back to CNOSSOS class defaults.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 366 plants, 85 operating, ~2.66 GW

Power-plant points from **GEM Global Integrated Power** (filtered to `Country_area='Nepal'`, operating only) are spatial-joined to OSM industrial polygons, overriding the lower-priority global GPPD baseline.

**Operating fuel**: hydropower **64** + solar 21. **100% RENEWABLE — ZERO fossil fuel** in GEM's operating fleet. **One of the only countries globally with a completely renewable GEM operating fleet**. Nepal has ~83 GW of theoretical hydropower potential (~42 GW economically feasible); the ~2.66 GW captured here is GEM's operating fleet — national installed capacity has since passed 3 GW (~3.4 GW by early 2025), still **one of the world's most under-exploited hydro resources**.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Upper Tamakoshi** | **456** | hydropower | **Nepal's largest**, opened 2022, Dolakha district. Semi-storage run-of-river. |
| **Kali Gandaki A** | 144 | hydropower | Syangja district — Nepal's largest before Upper Tamakoshi |
| **Solu Khola** | 86 | hydropower | |
| **Likhu 1** | 77 | hydropower | |
| **Middle Tamor** | 73 | hydropower | |
| **Madhya Marsyangdi** | 70 | hydropower | |
| **Marsyangdi** | 69 | hydropower | |
| **Khimti I** | 60 | hydropower | Dolakha — Nepal's first private-sector hydro (2000) |
| **Kulekhani I** | 60 | hydropower | Nepal's only reservoir hydro (most others are run-of-river) |
| **Upper Trishuli 3A** | 60 | hydropower | |
| **21 solar plants** | ~80 total | solar | Recent additions |

All operating plants map to **NACE 35**.

### Not captured / context

- **No DoR AADT** — zero open traffic data; roads use CNOSSOS class defaults
- **No railway GTFS** (no operating railway) — any OSM rail uses CNOSSOS class defaults
- **No significant mining or heavy industry** — Nepal's economy is services + remittances + agriculture
- **Cement**: Hongshi-Shivam Nawalparasi (Chinese), Hetauda Cement, Udayapur Cement — captured globally only if matched by the GEM Cement tracker above its capacity threshold, else as OSM `landuse=industrial`
- **Himal Iron & Steel** (Biratnagar) — small; captured globally only if matched by the GEM Iron & Steel tracker above its capacity threshold, else as OSM `landuse=industrial`
- **Carpet/pashmina** (Kathmandu Valley) — traditional handicraft sector
- **No oil/gas industry** — Nepal imports all petroleum from India (Indian Oil Corporation monopoly)
- **No coal power** — one of very few countries with zero coal in operating fleet
- **Tourism infrastructure**: Lukla/Everest, Pokhara/Annapurna, Chitwan — major economic sector, limited industrial noise impact

## Validation

Nepal implements environmental protection via:

- **Ministry of Forests and Environment**
- **Environment Protection Act 2019**
- **Kathmandu Valley noise** is a major quality-of-life issue — frequent complaints about vehicle horns, construction, religious loudspeakers
- Nepal's 2015 earthquake (M7.8) destroyed much infrastructure — rebuilt roads/buildings are generally newer

Notable noise zones:

- **Kathmandu Valley** — bowl-shaped geography traps noise + pollution, medieval narrow streets, extreme motorcycle + microbus density
- **Prithvi Highway** (Kathmandu ↔ Pokhara — winding gorge road, heavy trucks + tourist buses)
- **Mahendra Highway** (east-west Terai trunk, India transit freight)
- **Tribhuvan International (KTM/VNKT Kathmandu — world's most challenging airport approach through Himalayan valley)**, **Pokhara International (PKR/VNPK — new 2023)**, **Gautam Buddha (BWA/VNBW Lumbini)**, **Biratnagar (BIR/VNVT)** — covered by global aircraft layer
- **Upper Tamakoshi** (456 MW — Nepal's largest hydro)
- **Kali Gandaki A** (144 MW)
- **Birgunj-Raxaul India trade crossing** (most of Nepal's imports/exports)
