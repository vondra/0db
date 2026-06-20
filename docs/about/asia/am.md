---
title: Armenia
intro: Noise mapping data sources for Armenia.
map: { center: [44.8, 40], zoom: 7 }
---

## Road traffic

### Road defaults

Armenia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Armenia's traffic factor **≈ 1.287** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.287 ≈ 38,610 |
| Trunk | 15,000 × 1.287 ≈ 19,305 |
| Primary | 9,000 × 1.287 ≈ 11,583 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

## Railway

### Armenian rail context

**South Caucasus Railway** (RZHD/Russian Railways subsidiary concession) operates **~780 km** of **broad gauge (1,520 mm)**. **Turkey and Azerbaijan borders are CLOSED since 1993** — no cross-border rail except to Georgia.

### Yerevan Metro
- **Opened 1981** — Soviet-era, **1 line, ~13.4 km, 10 stations**, ~50k daily

### Main line
- **Yerevan ↔ Gyumri ↔ Akhuryan ↔ Georgia border** — only international rail connection

### Sevan branch
- **Yerevan ↔ Lake Sevan** — seasonal tourist + limited freight

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 73 plants, 50 operating, ~2.61 GW

**Operating fuel**: solar 38 + hydropower 7 + oil/gas 4 + nuclear 1.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Metsamor (Armenian NPP)** | **448** | nuclear | **Soviet VVER-440** — **only nuclear plant in the Caucasus**. Sits in **seismic zone** (1988 earthquake closed it temporarily). Controversial — EU has urged closure. Provides ~30-40% of Armenia's electricity. |
| **Hrazdan** | 631 (431+200) | oil/gas | Soviet-era thermal, Russian gas |
| **Yerevan 1+2** | 496 (242+254) | oil/gas | Capital thermal |
| **Shamb (Vorotan)** | 171 | hydropower | **Vorotan cascade** (Spandaryan 76 + Shamb 171 + Tatev 157 ≈ 404 MW, ContourGlobal) |
| **Tatev (Vorotan)** | 157 | hydropower | Near Tatev Monastery (world's longest reversible aerial tramway nearby) |
| **Spandaryan (Vorotan)** | 76 | hydropower | Top of the Vorotan cascade |
| **Kanaker** | 102 | hydropower | Hrazdan River, Yerevan area |
| **38 solar plants** | ~180 total | solar | All small (<15 MW), recent growth |

All operating plants map to **NACE 35**.

### Armenia does NOT have

- **No open AADT** — Road Department publishes nothing
- **No South Caucasus Railway GTFS**
- **Zangezur copper-molybdenum** (Kajaran/Kapan) not NACE 07 — one of world's largest Cu-Mo deposits
- **Armenian Molybdenum Production** (Yerevan) not NACE 24
- **Ararat Cement** (old + new plant) not NACE 23
- **Nairit rubber** (Yerevan, Soviet-era, **closed** — former chemical weapons component, environmental legacy)
- **ArArAt brandy** — world-famous (Winston Churchill reportedly preferred it to Cognac)
- **No oil/gas production** — Armenia depends entirely on Russian/Iranian gas imports (pipeline via Georgia)
- **Borders with Turkey + Azerbaijan CLOSED since 1993** — geopolitical isolation limits transit

## Validation

Armenia implements environmental protection via:

- **Ministry of Environment**
- **Law on Environmental Impact Assessment (2014)**
- Noise standards: based on Soviet-era GOST + WHO guidelines

Notable noise zones:

- **Yerevan** — capital, ~37% of all Armenians (extreme primacy)
- **M2 Yerevan↔Sevan highway** (Iran transit freight)
- **Yerevan Metro** (1981, Soviet)
- **Zvartnots International (EVN/UDYZ Yerevan)**, **Gyumri Shirak (LWN/UDSG)** — covered by global aircraft layer
- **Metsamor Nuclear** (448 MW — only nuclear in Caucasus, seismic zone)
- **Hrazdan + Yerevan thermal** (Russian gas)
- **Vorotan hydro cascade** (Tatev/Shamb/Spandaryan)
- **Zangezur copper-molybdenum** (Kajaran mines)
