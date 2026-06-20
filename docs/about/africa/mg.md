---
title: Madagascar
intro: Noise mapping data sources for Madagascar.
map: { center: [47, -19], zoom: 5 }
---

## Road traffic

### Road defaults

Madagascar publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Madagascar's traffic factor **≈ 0.701** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 0.701 ≈ 21,030 |
| Trunk | 15,000 × 0.701 ≈ 10,515 |
| Primary | 9,000 × 0.701 ≈ 6,309 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **RN2** — Antananarivo ↔ Moramanga ↔ Toamasina (**main port freight corridor**, parallel to TCE railway)
- **RN7** — Antananarivo ↔ Antsirabe ↔ Ambositra ↔ Fianarantsoa ↔ Tuléar (**scenic southern route**, major tourist corridor)
- **RN4** — Antananarivo ↔ Mahajanga (NW)
- **RN1** — Antananarivo ↔ Tsiroanomandidy (western interior)
- **RN5** — Toamasina ↔ Maroantsetra (NE coast)
- **RN6** — Ambanja ↔ Antsiranana (far north)

## Railway

### Malagasy rail context

Madagascar has **two narrow-gauge railway lines** operated by **Madarail** (private concession since 2003, originally French colonial-era) plus one heritage line:

### TCE (Tana-Côte Est)
- **Antananarivo ↔ Moramanga ↔ Toamasina (Tamatave)** — 370 km, meter gauge.
- **Madagascar's most important freight railway** — carries chrome, nickel general cargo, vanilla, fuel imports from Toamasina port
- Built 1901-1913 by French colonial Madagascar
- Traverses the dramatic **Mandraka escarpment** (steep tropical rainforest)

### TA (Tana-Antsirabe)
- **Antananarivo ↔ Ambatolampy ↔ Antsirabe** — 160 km, meter gauge
- Mostly freight (cement, agricultural, Holcim Ibity)

### FCE (Fianarantsoa-Côte Est)
- **Fianarantsoa ↔ Manakara** — 163 km, meter gauge (1,000 mm)
- **Tourist/heritage line** — scenic passage through eastern tropical forest. **Very slow (12+ hours for 163 km)**. Not operated by Madarail. SNCF heritage.

**No other railways, no metros, no trams**.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 20 plants, 11 operating, ~456 MW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Madagascar'`

**Operating fuel**: solar 4 + coal 3 (Ambatovy captive) + oil/gas 2 + hydropower 2. **JIRAMA** (state utility) is severely underfunded with frequent blackouts.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Ambohimanambola (Trigu+Aksaf)** | 171 (105+66) | oil/gas | Near Antananarivo — capital's main thermal cluster |
| **Andekaleka** | 91 | hydropower | Vohitra River — **Madagascar's largest hydro** |
| **Ambatovy Nickel** | 120 (3× 40) | coal (captive) | Dedicated to **one of world's largest nickel laterite mines** ($8B, Sumitomo/KORAM). Connected to Toamasina by 220 km slurry pipeline |
| **Mandraka** | 24 | hydropower | Mandraka Falls, Tana-Tamatave road |
| **Ambatolampy Solar** | 40 (2× 20) | solar | Madagascar's largest solar |
| **Ehoala Solar** | 8 | solar | Fort Dauphin, near QMM ilmenite mine |

All operating plants map to **NACE 35**.

### Madagascar does NOT have

- **No ARM AADT** — zero open traffic data
- **No Madarail GTFS**
- **Ambatovy** (Moramanga) not NACE 07/24 — **one of world's largest nickel laterite mines** ($8B, Sumitomo/KORAM). Nickel + cobalt + ammonium sulphate. 220 km slurry pipeline to Toamasina
- **QMM / Fort Dauphin ilmenite** (Rio Tinto) not NACE 07 — heavy mineral sands (ilmenite for TiO₂), Anosy region SE Madagascar
- **Kraoma chromite** (Brieville/Andriamena, Betsiboka region) not NACE 07 — one of Africa's larger chromite producers
- **Graphite**: Tirupati (Vatomina), NextSource (Molo) — rapidly expanding sector
- **Vanilla**: SAVA region — **Madagascar produces ~80% of world's vanilla** (after saffron, the world's most expensive spice by weight)
- **Cloves**: East coast — world's #2 clove producer
- **Cement**: Holcim Madagascar (Ibity/Antsirabe)
- **GALANA refinery** (Toamasina, small fuel distribution)
- **Toamasina Port** — Madagascar's main port

## Validation

Madagascar implements environmental protection via:

- **ONE** (Office National pour l'Environnement) — EIA authority
- **MEDD** (Ministère de l'Environnement et du Développement Durable)
- **Charte de l'Environnement (1990)** — framework
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **RN2 Tana↔Toamasina** — main port freight corridor
- **RN7 Tana↔Antsirabe↔Tuléar** — scenic south backbone
- **Antananarivo** — highland capital, dense urban core
- **TCE railway** (Tana↔Toamasina, Madarail)
- **FCE scenic railway** (Fianarantsoa↔Manakara)
- **Ivato International (TNR/FMMI Antananarivo)**, **Fascene (NOS/FMNN Nosy Be)**, **Toamasina (TMM/FMMT)**, **Mahajanga (MJN/FMMG)**, **Fort Dauphin (FTU/FMSD)**, **Antsiranana (DIE/FMNA)** — covered by global aircraft layer
- **Ambohimanambola thermal** (171 MW, Tana)
- **Andekaleka hydro** (91 MW, Mangoro River)
- **Ambatovy nickel mine + captive coal plant** (120 MW, Moramanga)
- **QMM Fort Dauphin ilmenite** (Rio Tinto)
- **Kraoma chromite** (Brieville/Andriamena, Betsiboka)
- **Toamasina port**
