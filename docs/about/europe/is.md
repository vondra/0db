---
title: Iceland
intro: Noise mapping data sources for Iceland.
map: { center: [-19.0, 65.0], zoom: 6 }
---

## Road traffic

### Road defaults

Iceland publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Iceland's traffic factor **≈ 0.933** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.933 ≈ 27,990 |
| Trunk | 15,000 × 0.933 ≈ 13,995 |
| Primary | 9,000 × 0.933 ≈ 8,397 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Iceland has NEVER had a railway

Iceland is the **only country in Europe that has never had a railway** — no historic, no dismantled, no narrow gauge, no heritage. The only "rail" that ever existed was a temporary construction railway for Reykjavík harbour (1913-1928, ~2 km). Proposals for a Reykjavík light rail exist but have never been built. Railway enrichment is **skipped entirely**.

## Buildings

Overture Maps Foundation global footprints (per-building heights where tagged; GHSL Built-H 100 m raster only as a sparse seed).

## Industrial

### GEM Global Integrated Power — 45 plants, 34 operating, ~2.71 GW

**100% RENEWABLE — geothermal 24 + hydropower 10. ZERO fossil fuel, ZERO nuclear, ZERO wind, ZERO solar.** Unique globally alongside Albania and Nepal as 100% renewable GEM fleets, but Iceland is the **only one powered by geothermal+hydro exclusively** (no solar at all — 64°N latitude + cloudy climate).

**Iceland has the world's HIGHEST per-capita electricity consumption** (~55,000 kWh/person/year — ~5× EU average). Most goes to **3 aluminium smelters** that consume ~75% of national electricity.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Fljótsdalur/Kárahnjúkar** | 690 | hydropower | **Built for Alcoa Fjarðaál** aluminium smelter (controversial — flooded pristine Icelandic highlands, Vatnajökull area) |
| **Búrfell I+II** | 370 | hydropower | Þjórsá River |
| **Hellisheiði** | **303** (7 units) | geothermal | **World's 2nd largest geothermal plant** (Hengill volcanic system). Also hosts **Orca** — world's first commercial direct air CO₂ capture plant (Climeworks) |
| **Hrauneyjafoss** | 210 | hydropower | |
| **Blanda** | 150 | hydropower | |
| **Reykjanes** | 130 (3 units) | geothermal | Reykjanes Peninsula (active volcanic zone, 2021-2024 eruptions nearby) |
| **Nesjavellir** | 120 (4 units) | geothermal | Supplies hot water to Reykjavík area |
| **Svartsengi** | 101 (5 units) | geothermal | **Heats the Blue Lagoon** (one of Iceland's top tourist attractions — the milky-blue water is Svartsengi's waste water) |
| **Þeistareykir** | 90 (2 units) | geothermal | NE Iceland |
| **Krafla** | 60 (2 units) | geothermal | Near Mývatn (1975-1984 "Krafla Fires" eruption series) |

All operating plants map to **NACE 35**.

### Iceland does NOT have

- **No open AADT** (Vegagerðin has some data but not integrated)
- **NO RAILWAY** — never had one (only European country)
- **Alcoa Fjarðaál** (Reyðarfjörður) not NACE 24 — 346 ktpa aluminium, **Fljótsdalur hydro was purpose-built for it**
- **Rio Tinto ISAL** (Hafnarfjörður, near Reykjavík) not NACE 24 — 200 ktpa aluminium
- **Century Aluminum Norðurál** (Grundartangi) not NACE 24 — 315 ktpa aluminium
- **These 3 smelters consume ~75% of Iceland's total electricity** — extreme industrial concentration
- **Climeworks Orca** — world's first commercial direct air CO₂ capture plant (at Hellisheiði geothermal)
- **No oil/gas production** — Iceland imports all petroleum
- **No coal** — never had any
- **Reykjanes volcanic eruptions 2021-2024** — ongoing eruptions near Svartsengi/Grindavík (threatening geothermal infrastructure)

## Validation

Iceland implements environmental protection via:

- **Umhverfisstofnun** (Environment Agency of Iceland)
- **Act on Noise Prevention (1988)**
- **EEA member** — follows EU Environmental Noise Directive (END) for strategic noise maps
- Reykjavík has produced END strategic noise maps

Notable noise zones:

- **Reykjanesbaut motorway** (Reykjavík↔Keflavík airport)
- **Reykjavík** (Capital Region — 63% of population concentrated)
- **Route 1 Ring Road** (1,322 km backbone)
- **Keflavík International (KEF/BIKF)** — covered by global aircraft layer
- **Hellisheiði geothermal** (303 MW + Climeworks Orca DAC)
- **Fljótsdalur/Kárahnjúkar hydro** (690 MW — Alcoa smelter)
- **ISAL Hafnarfjörður** (aluminium smelter within Reykjavík metro — noise+industrial proximity to residential)
- **Svartsengi geothermal** (101 MW — Blue Lagoon, Reykjanes eruption zone)
