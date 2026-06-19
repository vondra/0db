---
title: Sri Lanka
intro: Noise mapping data sources for Sri Lanka.
map: { center: [80.7, 7.8], zoom: 7 }
---

## Road traffic

### Class defaults only

RDA (Road Development Authority) publishes no open GIS, and there is no bespoke Sri Lanka road enricher. The engine scales its world-default motorway/trunk/primary AADT by Sri Lanka's country factor (≈1.30×) and applies the world-default vehicle mix. The Colombo Tier-1 boost and the three-wheeler-heavy vehicle split below are the **intended country-tuning, not yet ingested** — shown as the target profile. **Sri Lanka is an island** — no neighbour-country exclusions needed.

### Sri Lankan AADT defaults

Sri Lanka has a **surprisingly developed expressway system** for a 66k km² island (E01 Southern 2011 + E02 Outer Circular + E03 Colombo-Katunayake + E04 Central).

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (E01/E02/E03/E04 expressways) | 35,000 | 70,000 | 49,000 |
| 1 trunk (A-routes) | 15,000 | 30,000 | 21,000 |
| 2 primary | 8,000 | 16,000 | 11,200 |
| 3 secondary | 4,000 | 8,000 | 5,600 |
| 4 tertiary | 2,000 | 4,000 | 2,800 |
| 5 residential | 800 | 1,600 | 1,120 |

**Tier-1 metro** (×2.0): **Greater Colombo** (~5.6M — Colombo + Sri Jayawardenepura Kotte (official capital) + Dehiwala-Mount Lavinia + Moratuwa + Gampaha corridor).

**Tier-2 cities** (×1.4, 12 cities): **Kandy** (~150k, cultural capital, Temple of the Tooth, hill country), **Galle** (~100k, colonial Dutch fort, tourism), **Jaffna** (~90k, Tamil north, post-civil war recovery), Negombo (~150k, airport area), Batticaloa, **Trincomalee** (east coast, natural deepwater harbor — one of world's largest), Kurunegala, Ratnapura (gem city), **Anuradhapura** (ancient capital), Matara, **Nuwara Eliya** (British hill station, tea country at 1,868m), Badulla.

### Sri Lankan vehicle split

Sri Lanka has the **world's highest three-wheeler/tuk-tuk density per capita** — ~1 million registered three-wheelers for 22 million people:

| Tier | Light | Medium (three-wheeler) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Colombo) | 40% | **25%** | 12% | 23% |
| Tier-2 | 35% | **25%** | 15% | 25% |
| Rural | 30% | **20%** | 25% | 25% |
| **E01/E03 Expressway** | 65% | 5% | **28%** | 2% (tuk-tuks banned) |

### National route network

- **E01 Southern Expressway** — Kottawa (Colombo) ↔ Galle ↔ Matara (126 km, 2011+2014 — Sri Lanka's first motorway)
- **E03 Colombo-Katunayake Expressway** — Colombo ↔ Airport (26 km, 2013)
- **E02 Outer Circular Expressway** — Colombo ring (ongoing)
- **E04 Central Expressway** — Colombo ↔ Kandy (Mirigama section opened 2021)
- **A1** — Colombo ↔ Kandy (old road, famous mountain hairpins)
- **A2** — Colombo ↔ Galle (coastal, devastated by 2004 tsunami, rebuilt)
- **A9** — Colombo ↔ Jaffna (restored after civil war, Elephant Pass)

## Railway

### CNOSSOS class defaults

No Sri Lanka rail enricher runs and Sri Lanka Railways publishes no GTFS, so rail noise uses the engine's CNOSSOS class defaults by OSM rail type — mainline heavy rail at 80 passenger + 20 freight trains/day, branch at 30 + 5. The lines below are documented as context (the Colombo suburban network carries the heaviest service; the long scenic lines are sparser than the class default assumes).

### Sri Lankan rail context

**Sri Lanka Railways** operates ~1,500 km of **broad gauge (1,676 mm)** — British colonial-era, one of the oldest in Asia (first line 1864).

### Colombo Suburban
- **Colombo Fort ↔ surrounding suburban stations** — commuter service for Greater Colombo

### Main/Hill Country Line
- **Colombo ↔ Peradeniya Junction ↔ Kandy ↔ Nanu Oya ↔ Badulla** — **one of the WORLD'S MOST SCENIC railway journeys** (through tea plantations, mountain passes at 1,800m, Nine Arches Bridge at Ella)
- ~290 km, 7-10 hours

### Northern Line
- **Colombo ↔ Anuradhapura ↔ Jaffna/KKS** — **restored after civil war** (fully reopened 2014 after 1990 closure)

### Coastal Line
- **Colombo ↔ Galle ↔ Matara** — Indian Ocean coast scenic. **Devastated by 2004 Indian Ocean tsunami** (Queen of the Sea train disaster — Guinness World Records lists it as the worst rail disaster, with estimates ranging from ~800 to ~1,700+ passengers killed). Rebuilt.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 136 plants, 40 operating, ~3.72 GW

Power-plant points from **GEM Global Integrated Power** (filtered to `Country_area='Sri Lanka'`, operating only) are spatial-joined to OSM industrial polygons, overriding the lower-priority global GPPD baseline.

**Operating fuel**: hydropower 13 + wind 13 + oil/gas 8 + coal 3 + solar 3. Diverse mix.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Lakvijaya (Norochcholai)** | **900** (3× 300) | coal | Puttalam — **Sri Lanka's ONLY coal plant**, Chinese-built. Controversial — frequent breakdowns + coal import dependency |
| **Yugadanavi** | 300 | oil/gas | Kerawalapitiya, Colombo area |
| **Kerawalapitiya LNG (Sobadhanavi)** | 350 | oil/gas | |
| **Victoria** | 210 | hydropower | **Mahaweli River** — largest hydro in Sri Lanka |
| **Kotmale** | 201 | hydropower | Mahaweli cascade |
| **Kelanitissa CCGT** | 165 | oil/gas | |
| **Upper Kotmale** | 150 | hydropower | |
| **Randenigala** | 122 | hydropower | |
| **Samanalawewa** | 120 | hydropower | |
| **Uma Oya** | 120 | hydropower | Underground, commissioned April 2024 — controversial (caused landslides + groundwater depletion in Uva Province) |
| **Mannar Wind** | 100 | wind | Sri Lanka's largest wind farm |
| **13 wind farms total** | ~450 | wind | Puttalam/Mannar/Hambantota coast |

All operating plants map to **NACE 35**.

### Not captured / context

- **No RDA AADT** — zero open traffic data; roads use CNOSSOS class defaults
- **No Sri Lanka Railways GTFS** — rail uses CNOSSOS class defaults
- **Sapugaskanda refinery** (Kelaniya, near Colombo) — Sri Lanka's only refinery (~50k bpd), operated by state **Ceylon Petroleum Corporation (CPC)** (not Indian Oil; Lanka IOC is a separate fuel-retail subsidiary). Refining is not in the power-plant dataset
- **Cement**: Lanka Cement, Holcim Lanka, Tokyo Cement — captured globally only if matched by the GEM Cement tracker above its capacity threshold, else as OSM `landuse=industrial`
- **Garments/apparel**: Free Trade Zones (Katunayake, Biyagama, Koggala) — Sri Lanka's top export earner; captured only as OSM `landuse=industrial`
- **Tea processing**: **Ceylon tea** — ~300k ton/year, **world's #4 tea producer** (after China, India, Kenya). Captured only as OSM `landuse=industrial`
- **Colombo Port** — **one of world's top-30 busiest container ports** (Indian Ocean transshipment hub between East Asia and Europe/Middle East). Not flagged
- **Hambantota Port** — Chinese-built, controversially leased to China Merchants Port for 99 years (2017 — "debt trap" debate). Not flagged
- **Ratnapura gem mining** — "City of Gems" (sapphires, rubies, topaz — Sri Lanka is one of world's richest gem sources)

## Validation

Sri Lanka implements environmental protection via:

- **CEA** (Central Environmental Authority)
- **National Environmental Act No. 47 of 1980** (amended)
- **Noise Control Regulations 1996** (Gazette Extraordinary No. 924/13)
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60
- **Colombo** is consistently among South Asia's noisiest cities — tuk-tuk + bus horn + construction noise

Notable noise zones:

- **E01 Southern + E03 Airport Expressways** — Sri Lanka's motorway system
- **A1 Colombo↔Kandy** (famous mountain road)
- **A2 Colombo↔Galle coast** (rebuilt post-2004 tsunami)
- **Greater Colombo** metro — extreme tuk-tuk density
- **Sri Lanka Railways Hill Country line** (Colombo↔Kandy↔Badulla — world's most scenic)
- **Colombo Fort railway terminus** (main station, suburban commuter hub)
- **Bandaranaike International (CMB/VCBI Colombo)**, **Mattala Rajapaksa (HRI/VCRI Hambantota — world's emptiest intl airport)**, **Ratmalana (RML/VCCC Colombo domestic)**, **Jaffna (JAF/VCCJ)** — covered by global aircraft layer
- **Lakvijaya coal** (900 MW — only coal, Puttalam)
- **Victoria + Kotmale + Randenigala hydro cascade** (Mahaweli River)
- **Colombo Port** (top-30 globally, Indian Ocean transshipment hub)
- **Hambantota Port** (Chinese 99-year lease)
- **Tea country** (Nuwara Eliya / Ella / Haputale hill belt)
