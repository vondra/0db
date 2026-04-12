---
title: Oceania
intro: Noise mapping overview for Oceania — Australian rail enrichment + Overture building heights.
map: { center: [140, -25], zoom: 3 }
---

## Data situation

Australia has excellent open data infrastructure — GTFS feeds are freely available for most states. New Zealand data exists but URLs have changed. Pacific Island nations have no transit data.

## Continental enrichment

### Applied datasets

| Dataset | Coverage | Impact | Status |
|---------|----------|--------|--------|
| **PTV Metro Trains** | Melbourne metro + V/Line regional (109 stops) | Real train frequencies | Applied — 16.7K segments |
| **TransLink QLD** | Brisbane CityTrain + QR regional (331 stops) | Real train frequencies | Applied — with VIC batch |
| **Overture Buildings** | Sydney 57.7% height coverage | Per-building screening heights | Applied in /enrich-global |

### Victoria (Melbourne)

Source: PTV (Public Transport Victoria) GTFS from data.ptv.vic.gov.au. 13 rail routes, 109 stops, 392 daily trains. Busiest: Southern Cross Station (386 trains/day), Footscray (289), Sunshine (228).

### Queensland (Brisbane / SEQ)

Source: TransLink GTFS from translink.com.au. 682 rail routes (CityTrain + QR regional), 331 stops, 843 daily trains. Busiest: South Brisbane (423 trains/day), Fortitude Valley (269), Bowen Hills (268).

### Known gaps

- **NSW (Sydney)** — Transport for NSW GTFS requires API key registration at opendata.transport.nsw.gov.au. Would cover Sydney Trains, NSW TrainLink, Sydney Metro.
- **South Australia (Adelaide)** — GTFS URL changed (404). Adelaide Metro has limited rail.
- **Western Australia (Perth)** — Transperth GTFS URL changed (404). Perth has Transperth rail.
- **New Zealand** — Auckland AT GTFS and Wellington Metlink both returned 404/timeout. NZ has good open data but URLs change frequently.
- **Pacific Islands** — No transit data.

## What the map uses

- **DEM**: Copernicus GLO-30 (30m) — terrain diffraction
- **Buildings**: GHSL 100m + Overture Maps 30m (Sydney 57.7% height coverage)
- **Forest**: ESA WorldCover 10m — vegetation attenuation
- **Ground**: WorldCover-derived G-factor
- **Industrial**: GPPD power plants — AU 203, NZ 34 plants
- **Railway**: Melbourne Metro + Brisbane CityTrain real frequencies; other rail uses OSM defaults
- **Traffic**: OSM road class defaults (no AADT enrichment)

## Per-country enrichment priority

1. **Australia (NSW)** — Sydney Trains GTFS (needs API registration). NSW has the most rail traffic in AU.
2. **New Zealand** — Find current GTFS URLs for Auckland AT and Wellington Metlink.
3. **Australia (WA/SA)** — Find current Perth Transperth and Adelaide Metro GTFS URLs.

## Per-country enrichment status

1. **Fiji** ✅ — FRA publishes no open AADT. GEM-only (2 plants / ~90 MW) — **Wailoa 80 MW hydro** (Monasavu Dam, Viti Levu — Fiji's largest) + **Butoni Wind Farm 10 MW**. **NO public railway** (only defunct FSC sugar cane tramways). **First Pacific Island country enriched**. Island nation — 100% road coverage. **Antimeridian handling** (Fiji straddles ~180° longitude). **Suva ~180k** capital (Viti Levu SE). **Nadi** — tourism/airport gateway. Left-hand traffic (British heritage), Japanese used car imports. Sugar (FSC 4 mills), Vatukoula gold, Fiji Water, PAFCO tuna, tourism #1. **~240k road segments enriched (100%)**. See [Fiji page](fj).

2. **Papua New Guinea** ✅ — DoW publishes no open AADT. GEM-only (6 plants / ~277 MW) — **Ramu 1 hydro 77 MW** + **Kanudi 58 MW** (LNG gas) + **Ok Menga hydro 57 MW** + **Edevu hydro 54 MW** + **Lihir geothermal 30 MW** (inside volcanic caldera, powers **one of world's largest gold mines**) + Daru solar 1 MW. **NO public railway — NEVER had one**. **PNG LNG** (ExxonMobil 2014, ~8.3 Mtpa). **Lihir/Porgera/Ok Tedi gold mines** + **Ramu NiCo** (MCC). **Highlands Highway** (Lae↔Mt Hagen) — PNG's most critical road, 55% heavy mining/agriculture freight. **Port Moresby ~400k** — isolated capital (no road to rest of PNG until recently). **~840 languages** (most linguistically diverse country on Earth). **~577k road segments enriched (98%)**. See [Papua New Guinea page](pg).

3. **New Caledonia** ✅ — DITTT publishes no open AADT. GEM (39 plants / **~970 MW — highest plant count per capita of any enriched territory**, 270k people!) — **Nickel capital of the Pacific** (~25% of world's nickel reserves, #4 producer). **Doniambo 340 MW** (SLN/Eramet fuel oil, Nouméa — operating since **1910**) + **Koniambo 270 MW** (Glencore/SMSP 2013) + **Goro 100 MW** (Prony Resources/Vale, $9B troubled project) + **Yaté 68 MW** hydro + Jacques Lekawe 55 diesel + **~39 MW wind** (Col de Prony, Kafeate, Negandi) + **~90 MW solar** (20+ projects). **NO railway**. French *sui generis* collectivity — drives right, good infrastructure. **169 NACE matches** (highest for Oceania — nickel industry well-mapped). **World's largest lagoon** (UNESCO). 2024 political crisis. **~134k road segments enriched (100%)**. See [New Caledonia page](nc).

4. **Samoa** ✅ — LTA publishes nothing. GEM-only (4 tiny solar plants / ~8 MW — Satapuala 2.6+2.0, Faleolo Airport 2.1, Faleata 1.4). **NO railway**. ~200k population, 2 islands (Upolu + Savai'i — largest Polynesian island). **Left-hand traffic since 2009** (only 21st-century driving side switch, aligned with AU/NZ). Colorful wooden **"aiga" buses**. Yazaki wiring factory (only manufacturer). **~21.8k road segments enriched (100%)**. See [Samoa page](ws).

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation.
