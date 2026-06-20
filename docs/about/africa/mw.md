---
title: Malawi
intro: Noise mapping data sources for Malawi.
map: { center: [34, -13.5], zoom: 6 }
---

## Road traffic

### Road defaults

Malawi publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Malawi's traffic factor **≈ 1.286** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.286 ≈ 38,580 |
| Trunk | 15,000 × 1.286 ≈ 19,290 |
| Primary | 9,000 × 1.286 ≈ 11,574 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **M1** — Karonga ↔ Mzuzu ↔ Kasungu ↔ **Lilongwe** ↔ Dedza ↔ Ntcheu ↔ **Blantyre** ↔ Thyolo ↔ Nsanje — **Malawi's trunk highway, the north-south spine** (~1,200 km)
- **M2** — Blantyre ↔ Mulanje ↔ Mozambique border
- **M3** — Mwanza (MZ border) ↔ Blantyre ↔ Zomba ↔ Mangochi
- **M5** — Salima ↔ Nkhotakota ↔ Nkhata Bay ↔ Karonga (**lakeshore road**)
- **M12** — Lilongwe ↔ Mchinji (Zambia border)

## Railway

### Malawian rail context

Malawi's rail network is operated by **CEAR (Central East African Railways)**, private concession since 1999, now owned by **Vulcan International** (Jindal Steel/Power, acquired from Vale Mozambique 2021). All active rail is part of the **Nacala Corridor** system linking Mozambique Nacala port to Moatize coal basin via Malawi.

### Nacala Corridor (main freight line)
- **Nayuchi (MZ border E) ↔ Liwonde ↔ Balaka ↔ Nkaya ↔ Mwanza (MZ re-entry)**
- Part of the **912 km Vale-built 2014-2017 coal corridor** — MW is a transit country
- Reopened 2015 after civil-war-era dormancy
- Carries Moatize coking coal exports to Nacala deep-water port

### Southern branches (reduced)
- **Limbe ↔ Blantyre ↔ Luchenza ↔ Nsanje** — historic Blantyre-to-sea route via Mozambique Sena Line
- **Limbe** is the main Blantyre rail station (suburb)

### Western branch
- **Lilongwe ↔ Mchinji** (Zambia border) — partially operational, freight only

**No passenger rail of significance**, no urban commuter rail. **No metros, no trams**. CEAR is a mostly-freight concession supporting Nacala Corridor Moatize coal exports.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 38 plants, 7 operating, ~453 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Malawi'`

**Operating fuel**: solar 4 + hydropower 3.

**Malawi has one of Africa's smallest power fleets** (~453 MW for 20M people), reflecting the **lowest electrification rate in Africa (~14%)** and ongoing supply crisis since Cyclone Ana 2022.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Kapichira** | **130** | hydropower | **Shire River**, 2000 with extension — Malawi's largest single plant. **Damaged by Cyclone Ana January 2022**, causing severe national supply crisis 2022-2024 (partial repairs ongoing) |
| **Tedzani Falls** | 121 | hydropower | Shire River cascade (4 stages I-IV) |
| **Nkula B** | 100 | hydropower | Shire River — oldest major Malawian hydro |
| **Salima Solar** | 60 | solar | **Malawi's largest solar farm** |
| **Nkhotakota Solar** | 21 | solar | |
| **Golomoti Solar** | 20 | solar | |
| **Lilongwe Solar** | 1.1 | solar | Pilot project |

**Total operating: ~453 MW**.

**Under construction / planned (not counted)**:
- **Kammwamba coal 300 MW** (NW Malawi) — Chinese-financed, delayed
- **Mpatamanga 350 MW hydro** (Shire River) — under development
- **Songwe River hydro 340 MW** — Tanzania border, joint MW-TZ project

**Shire River cascade**: Kapichira + Tedzani + Nkula = **351 MW** on one river, 77% of Malawi's operating capacity. Extreme dependence on a single watercourse — makes Malawi vulnerable to cyclones, droughts, and upstream management (Lake Malawi outflow).

All operating plants map to **NACE 35**.

### Malawi does NOT have

- **No Roads Authority AADT** — zero open traffic data
- **No CEAR GTFS**
- **Kayelekera Uranium Mine** (Karonga N) not NACE 07 — Paladin Energy, **closed 2014** due to low uranium prices. Restart discussions 2023+ with uranium price recovery
- **Emerging lithium**: Mangochi/Liwonde area — Sovereign Metals (rutile+graphite) + Globe Metals (niobium)
- **Tobacco processing**: **Auction Holdings** at Limbe + Kanengo — **Malawi's dominant export sector** (historically 60%+ of export earnings), not NACE 12
- **Tea plantations**: Mulanje + Thyolo — Satemwa, Eastern Produce Malawi, Makandi
- **Sugar**: Illovo Sugar at Dwangwa (central Lake Malawi coast) + Nchalo (Lower Shire)
- **Cement**: Shayona Cement, Cement Products Limited (Lafarge)
- **Lake Malawi fishing** (chambo cichlid) — major domestic sector
- **No oil/gas industry** — Malawi has no hydrocarbons
- **Cyclone Ana 2022 damage** to Kapichira dam — not data gap but major supply impact

## Validation

Malawi implements environmental protection via:

- **EAD** (Environmental Affairs Department, Ministry of Natural Resources)
- **Environment Management Act 2017**
- **Environmental (Air Quality Control) Regulations** — noise regulation
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 75/65

Notable noise zones:

- **M1 North-South Trunk** — Karonga↔Mzuzu↔Lilongwe↔Blantyre↔Nsanje
- **M3 Blantyre↔Mwanza** (Mozambique border, Nacala Corridor parallel)
- **Lilongwe** + **Blantyre** dense urban cores
- **Nacala Corridor rail** (Nayuchi↔Balaka↔Mwanza — Vale/Vulcan coal transit)
- **Lilongwe-Mchinji freight branch**
- **Limbe-Nsanje southern branch** (historic Blantyre-to-sea)
- **Kamuzu International (LLW/FWKI Lilongwe)**, **Chileka International (BLZ/FWCL Blantyre)**, **Mzuzu (ZZU/FWUU)**, **Karonga (KGJ/FWKA)**, **Club Makokola (CMK/FWCM)** — covered by global aircraft layer
- **Kapichira Dam** (Shire River, 130 MW — damaged by Cyclone Ana 2022)
- **Tedzani Falls + Nkula B hydros** (Shire River cascade)
- **Salima Solar Farm** (Malawi's largest solar)
- **Kayelekera Uranium Mine** (closed 2014, potential restart)
- **Auction Holdings Limbe + Kanengo** (tobacco)
- **Illovo Sugar Dwangwa + Nchalo**
- **Mulanje/Thyolo tea plantations**
- **Lake Malawi** — 20% of Malawi's area, 9th largest lake in the world
