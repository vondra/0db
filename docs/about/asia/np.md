---
title: Nepal
intro: Noise mapping data sources for Nepal.
map: { center: [84, 28.5], zoom: 6 }
---

## Road traffic

### Class defaults only

DoR (Department of Roads) publishes no open GIS, and there is no bespoke Nepal road enricher. The engine scales its world-default motorway/trunk/primary AADT by Nepal's country factor (≈1.22×) and applies the world-default vehicle mix. The Kathmandu Valley Tier-1 boost and the motorcycle-heavy vehicle split below are the **intended country-tuning, not yet ingested** — shown as the target profile.

### Nepalese AADT defaults

Nepal is **mountainous and landlocked** between India (south) and China/Tibet (north). Road infrastructure is limited by extreme terrain.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Fast Track u/c) | 25,000 | 50,000 | 35,000 |
| 1 trunk (Prithvi/Mahendra/Tribhuvan Highways) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 500 | 1,000 | 700 |

**Tier-1 metro** (×2.0): **Kathmandu Valley** (~3M — Kathmandu + Lalitpur/Patan + Bhaktapur, **bowl-shaped valley trapping pollution + noise**, extreme congestion in narrow medieval streets).

**Tier-2 cities** (×1.4): **Pokhara** (~450k, Annapurna gateway, tourism), **Biratnagar** (~250k, Terai industry), **Birgunj** (~250k, **main India trade gateway** — Raxaul border crossing), Lalitpur/Patan (Kathmandu satellite), Bharatpur (~300k, Chitwan), Butwal, Dharan, Nepalgunj, Janakpur, Hetauda, Dhangadhi, Itahari.

### Nepalese vehicle split

**EXTREME motorcycle share** (40% in Kathmandu) — motorcycles navigate narrow medieval valley streets better than cars:

| Tier | Light | Medium (microbus/tempo) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Kathmandu Valley) | 30% | 15% | 15% | **40%** |
| Tier-2 | 32% | 12% | 18% | 38% |
| Rural | 25% | 8% | 35% | 32% |
| **Prithvi Highway (KTM↔Pokhara)** | 35% | 8% | **45%** | 12% |

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
