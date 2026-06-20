---
title: Namibia
intro: Noise mapping data sources for Namibia.
map: { center: [17, -22], zoom: 5 }
---

## Road traffic

### Road defaults

Namibia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Namibia's traffic factor **≈ 0.700** (population density). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.700 ≈ 21,000 |
| Trunk | 15,000 × 0.700 ≈ 10,500 |
| Primary | 9,000 × 0.700 ≈ 6,300 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **B1** — Windhoek ↔ Otjiwarongo ↔ Tsumeb ↔ Ondangwa ↔ Oshikango (Angola border) — main N-S trunk
- **B2** — Windhoek ↔ Okahandja ↔ Karibib ↔ Swakopmund ↔ Walvis Bay — port-capital link
- **B3** — Windhoek ↔ Rehoboth ↔ Keetmanshoop ↔ Ariamsvlei (RSA border) — south trunk
- **B6** — Trans-Kalahari (Botswana border ↔ Windhoek)
- **B8** — Trans-Caprivi (Rundu ↔ Katima Mulilo ↔ Zambia/Botswana)

## Railway

### Namibian rail context

**TransNamib** operates ~2,382 km of rail — built by German South-West Africa colonial administration (1897-1914) + South African mandate era (1915-1990). Cape gauge (1,067 mm); the original German lines were built as 600 mm narrow gauge and later regauged.

### Walvis Bay ↔ Windhoek
- ~380 km port-capital link — **main freight artery** for uranium exports (Rössing/Husab → Walvis Bay) and imports

### North trunk
- **Windhoek ↔ Otjiwarongo ↔ Tsumeb** — ~680 km, serving copper/lead/vanadium mines

### South trunk
- **Windhoek ↔ Keetmanshoop ↔ Ariamsvlei (RSA border)** — ~800 km, connecting to South African Transnet

### Other branches
- **Keetmanshoop ↔ Lüderitz** — historic port branch (reduced freight)
- **Otavi ↔ Grootfontein ↔ Tsumeb** — copper mining belt
- **Desert Express + Shongololo** tourist trains (seasonal)

**No passenger commuter rail, no metros, no trams**. TransNamib passenger services were discontinued except sporadic seasonal.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 77 plants, 28 operating, ~672 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Namibia'`

**Operating fuel**: solar 22 + coal 4 + wind 1 + hydropower 1. **Namibia imports ~60% of its electricity** via the Southern African Power Pool (SAPP) — South Africa's Eskom is the largest single supplier, with Zambia and Zimbabwe also significant.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Ruacana** | **332** | hydropower | **Kunene River, Angola border** — Namibia's largest plant, 49% of capacity. Flow depends on upstream storage at Gove/Calueque dams |
| **Van Eck** | 120 (4× 30) | coal | Windhoek — **Namibia's only coal plant**, obsolete, being decommissioned |
| **Mariental Solar** | 46 | solar | Largest solar IPP |
| **Omburu Solar** | 20 | solar | |
| **22 smaller solar plants** | ~120 total | solar | 8-16 MW each — rapid solar rollout post-2018 |
| **Diaz Wind Farm** | — | wind | Lüderitz area |

**Total operating: ~672 MW**.

All operating plants map to **NACE 35**.

### Namibia does NOT have

- **No RA AADT** — zero open traffic data
- **No TransNamib GTFS**
- **Rössing Uranium Mine** (Erongo) not NACE 07 — **world's longest-running open-pit uranium mine** (1976-present, Rio Tinto → CGN 2019)
- **Husab Uranium Mine** (Erongo) not NACE 07 — **one of world's largest uranium mines**, Swakop Uranium/CGN, opened 2017. Together Rössing + Husab make Namibia **world's #3 uranium producer**
- **Langer Heinrich Uranium** (Erongo) not NACE 07 — Paladin Energy, **reopened 2024** after 6-year closure (uranium price recovery)
- **Skorpion Zinc + Refinery** (Rosh Pinah) not NACE 07/24 — Vedanta, **closed 2020** (Africa's only integrated zinc mine+refinery)
- **Tsumeb Smelter** not NACE 24 — processes complex copper/lead/arsenic concentrates (one of world's few high-arsenic smelters). Sold by Dundee Precious Metals to China's Sinomine in 2024; smelting paused 2025 on concentrate shortage
- **B2Gold Otjikoto** + **Navachab Gold** (Karibib, QKR Corp) not NACE 07
- **Rosh Pinah Zinc** (Trevali) not NACE 07
- **Namdeb Diamonds** (De Beers/Namibia 50-50) not NACE 08 — marine + alluvial along the southern Atlantic coast (Sperrgebiet, around Oranjemund at the Orange River mouth)
- **Walvis Bay Salt Works** not NACE 08 — one of Africa's largest salt operations
- **Fishing + fish processing** (Walvis Bay, Lüderitz) — Benguela Current cold upwelling creates one of Africa's richest fishing grounds
- **Cement**: Ohorongo (Otavi, Schwenk), Cheetah (Otjiwarongo)

## Validation

Namibia implements environmental protection via:

- **MEFT** (Ministry of Environment, Forestry and Tourism) — primary environmental authority
- **Environmental Management Act 2007** — EIA framework
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **B1 Windhoek↔Oshikango** (Angola) — main N-S trunk
- **B2 Windhoek↔Walvis Bay** — port-capital link, uranium transport
- **B3 Windhoek↔Keetmanshoop↔RSA border** — south trunk
- **B8 Trans-Caprivi** (Rundu↔Katima Mulilo)
- **Windhoek** — Namibia's only significant dense urban zone
- **TransNamib rail** (Walvis Bay↔Windhoek, North+South trunks)
- **Hosea Kutako International (WDH/FYWH Windhoek)**, **Walvis Bay (WVB/FYWB)**, **Ondangwa (OND/FYOA)**, **Katima Mulilo (MPA/FYKM)**, **Lüderitz (LUD/FYLZ)**, **Rundu (NDU/FYRU)** — covered by global aircraft layer
- **Ruacana Hydroelectric** (Kunene River, 332 MW)
- **Van Eck Coal** (Windhoek, 120 MW — being decommissioned)
- **Rössing + Husab uranium mines** (Erongo — world's #3 uranium producer)
- **Langer Heinrich uranium** (reopened 2024)
- **Tsumeb copper smelter** (Sinomine since 2024; smelting paused 2025)
- **Walvis Bay port + fish processing + salt**
- **Namdeb diamond operations** (southern coast / Sperrgebiet around Oranjemund, marine mining)
- **Diaz Wind Farm** (Lüderitz)
