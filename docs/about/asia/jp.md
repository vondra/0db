---
title: Japan
intro: Noise mapping data sources for Japan.
map: { center: [137.0, 36.5], zoom: 5 }
---

## Road traffic

### MLIT 道路交通センサス令和3年度 — applied by name/ref join

[MLIT](https://www.mlit.go.jp/) (Ministry of Land, Infrastructure, Transport and Tourism) publishes the **道路交通センサス** (Road Traffic Census) every 5 years. The latest is **令和3年度** (Reiwa 3 = 2021) with ~230,000 surveyed road sections across all 47 prefectures.

- **Per-prefecture CSVs**: `https://www.mlit.go.jp/road/census/r3/data/csv/kasyo{01..47}.csv`
- **Cache**: `data/enrichment/2026/jp/kasyo{01..47}.csv` (Shift-JIS, 159 columns)
- **Fields used**: 24h two-way 自動車類 count split into 小型車 (small) / 大型車 (large), plus 道路種別 (road type), 路線番号 (route number), 路線名 (route name)
- **License**: Government of Japan Standard Terms of Use v2.0 (CC-BY-4.0 compatible)

**Why a name/ref join, not a spatial one**: the census is keyed by 交通調査基本区間番号 (kasyo section ID), which resolves to geometry only through the proprietary **DRM (Digital Road Map)** by 道路地図センター — paid. KSJ N13 (road network) carries no kasyo ID either, so there is no open geometry to place a measured section on. What the census *does* carry is each road's identity, and Japanese OSM tags major roads with exactly those, so we join by identity:

| 道路種別 (census road type) | OSM class | Join key |
|---|---|---|
| 1 / 2 — national + urban expressway | motorway | 路線名 (expressway name) |
| 3 — 一般国道 general national highway | trunk / primary | 国道番号 (route ref) |
| 4 / 6 — 主要地方道 / 一般県道 | secondary / tertiary | census class-median fallback |

**Limitation — national-median collapse**: each matched road gets the **national median** of its route's measured sections. A route's AADT varies along its length (国道1号 ≈ 60k in Tokyo, ≈ 15k rural) and without geometry we cannot place an OSM segment on the route, so it collapses to one median. The median still lands far closer than the global default (21.6k) on the urban corridors where population and exposure concentrate. Major roads with no name/ref match fall back to the census-measured median for their OSM class.

**Vehicle split**: 小型車 → light (CNOSSOS Cat1); 大型車 (buses + large trucks) → medium/heavy at 25/75 (the census gives no axle split; the large-vehicle stream is truck-dominated). Motorcycles are not in the 自動車類 24h count, so moto = 0. Residential/service roads keep the global service-tree heuristic — the census never surveyed them.

## Railway

### Generic CNOSSOS class defaults (no bespoke Japanese enricher)

There is **no Japan-specific rail enricher**. Japan publishes no public GTFS for its major operators without API-key registration ([ODPT](https://developer.odpt.org/) requires auth), and the open geometry dataset — MLIT National Land Numerical Information **N02-24 鉄道** ([GML zip](https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip), 21,932 rail line sections + 10,235 stations, JGD2011, CC-BY-4.0) — carries no train-frequency attribute. So Japanese rail (JR East/Central/West/Kyushu/Hokkaido/Shikoku, the Tokyo/Osaka private railways and subways, the Shinkansen) falls back to the engine's **generic CNOSSOS class defaults**, keyed only by OSM `rail_type` + `usage`:

| rail_type | usage | pax/day | frt/day |
|---|---|---:|---:|
| 0 (rail) | main | 80 | 20 |
| 0 (rail) | branch | 30 | 5 |
| 1 (tram) | - | 120 | 0 |
| 2 (light_rail) | - | 80 | 0 |

These are the same global defaults applied everywhere without a national rail dataset — not tuned to Japanese operator frequencies (a real Tokyo Metro line runs far more than 80 trains/day). N02 could supply geometry and station density for a future enricher, and ODPT developer registration would unlock real GTFS schedules for Tokyo Metro / Toei / JR East / JR West / JR Central — neither is implemented yet. Subway lines tagged `railway=subway` in OSM are additionally not extracted (the subway-extraction limitation shared with Seoul / Bangkok / Delhi).

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture/Microsoft Building Footprints (already in `/enrich-global`). GSI (Geospatial Information Authority of Japan) publishes building data via PSGI tiles but no per-building heights in open form.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers Japanese plants. Major sources of industrial noise:

- **Nuclear**: Kashiwazaki-Kariwa (8.2 GW, world's largest by capacity), Fukushima Daiichi/Daini (decommissioning), Sendai, Genkai, Ikata, Ohi, Takahama
- **Thermal coal/gas**: Kashima, Hekinan, Hirono, Hitachinaka, Tachibanawan
- **Hydroelectric**: Kurobe Dam, Okutadami, Tagokura

### Wind turbines

Japan has ~5 GW installed wind capacity (small for a G7 country due to terrain + grid constraints). The KSJ P03-13 dataset (2013, 417 wind plants) is too stale to be useful — Japan's fleet has grown significantly post-FIT 2012.

OSM has ~14,320 wind turbines in Japan but only 8.6% currently have specs. No per-turbine open registry exists from NEDO/METI.

### PRTR-Japan (gap)

Environment Ministry PRTR (令和6年度, FY2024) is downloadable as Shift-JIS CSV from [env.go.jp/chemi/prtr/kaiji/data/R06PRTRdata.zip](https://www.env.go.jp/chemi/prtr/kaiji/data/R06PRTRdata.zip) (~35,000 facilities with NAICS-equivalent codes + coordinates). Not yet implemented — would require Shift-JIS parsing + Japan industry code → NACE mapping.

## Validation

Japan does not implement END (the EU Environmental Noise Directive). Domestic noise regulation is fragmented:

- **環境基本法** (Environment Basic Law) — federal noise standards
- **MOE 環境省** (Ministry of Environment) — environmental noise standards (50/55/60 dB Lden zones)
- **MLIT 国土交通省** — road and railway noise standards along major corridors
- **Prefectural and municipal noise bylaws** — Tokyo, Kanagawa, Osaka, Aichi publish per-municipality noise complaint statistics

Notable noise studies: Tokyo Metropolitan Government publishes Shinkansen noise contours along the Tokaido Shinkansen; Osaka Prefecture monitors Hanshin Expressway and Osaka Metro Midosuji Line.
