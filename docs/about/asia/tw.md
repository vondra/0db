---
title: Taiwan
intro: Noise mapping data sources for Taiwan.
map: { center: [121.0, 23.7], zoom: 7 }
---

## Road traffic

### Data exists but no spatial join

Taiwan's [Highway Bureau (THB)](https://www.thb.gov.tw/) and [Freeway Bureau](https://www.freeway.gov.tw/) publish per-segment AADT for the national freeway and provincial highway network:

- **Freeway AADT** at [freeway.gov.tw](https://www.freeway.gov.tw/Download_File.ashx?id=6642&FileConditionsID=1) — 28 KB BIG5 CSV with 395 records covering 國道1, 國道3, 國道5 (Taiwan's three main freeways). Per-segment: weekday + Saturday + Sunday daily traffic.
- **Road centerlines (國省道 national + provincial)** at [opdadm.moi.gov.tw](https://opdadm.moi.gov.tw/) — 7.6 MB SHP in EPSG:3826 (TWD97/TM2)
- **Provincial highway AADT** at [data.gov.tw/dataset/46754](https://data.gov.tw/dataset/46754) — Imperva WAF-protected

**Critical limitation**: The freeway AADT CSV has **no coordinates** — only route name + section text (e.g. "國1南向 基隆-八堵"). Joining to OSM road geometry requires ref-based matching against `ref=國道1號`. Not implemented in this enrichment pass.

Taiwan roads currently use OSM `maxspeed` + class defaults.

## Railway

### Critical pipeline limitation: Taipei Metro & Kaohsiung Metro missing

The pipeline's OSM extractor only accepts `rail | tram | light_rail | narrow_gauge | funicular`. **Taiwan's metro systems tagged as `railway=subway` in OSM are NOT extracted into railways.arrow**:

- **Taipei Metro (TRTC)** — 6 lines (文湖 Wenshan-Neihu, 淡水信義 Tamsui-Xinyi, 松山新店 Songshan-Xindian, 中和新蘆 Zhonghe-Xinlu, 板南 Bannan, 環狀 Circular)
- **Kaohsiung Metro (KRTC)** — 3 lines (Red, Orange, Circular)

This is the same pipeline bug affecting Korea, Singapore, Japan, and Hong Kong.

### CNOSSOS class defaults applied

For the rail segments that ARE extracted (TRA conventional rail, THSR high-speed, Taoyuan Airport MRT, Taichung MRT light rail, Alishan Forest Railway), this script applies CNOSSOS-EU class defaults:

| rail_type | usage | trains/day |
|---|---|---|
| 0 (rail) | 0 (main) | 250 (TRA mainline + THSR) |
| 0 (rail) | 1 (branch) | 80 (TRA branches) |
| 2 (light_rail) | * | 350 (Taoyuan Airport MRT, Taichung MRT, Kaohsiung Circular, Wenshan-Neihu) |
| 1 (tram) | * | 200 |
| 3 (narrow_gauge) | * | 30 (Alishan Forest Railway) |

- **Result**: 31,275 segments enriched across 27 of 27 TW hexes (69.94%)

### TDX GTFS gap

[Transport Data eXchange (TDX)](https://tdx.transportdata.tw/) at the Ministry of Transportation is Taiwan's central transit data hub. Publishes GTFS for all operators (TRA, THSR, Taipei Metro, Kaohsiung Metro, Taoyuan Airport MRT, Taichung MRT, city buses) but requires free OAuth registration. Not implemented in this session.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints (already in `/enrich-global`). Taiwan's TGOS (Taiwan Geospatial One-Stop) building cadastre requires authentication.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers Taiwan plants. Major sources of industrial noise:

- **Coal**: Taichung Power Plant (5.5 GW, the largest in Asia by capacity), Mailiao, Hsinta, Taipower Linkou
- **Nuclear**: Maanshan (1.9 GW), Kuosheng, Chinshan (decommissioning)
- **Gas**: Datan, Tatan, Tunghsiao, Taichung
- **Hydroelectric**: Mingtan (1.6 GW pumped storage), Sun Moon Lake, Daguan
- **Wind (offshore)**: Formosa 1, Greater Changhua, Yunlin, Taipower Phase 1 (Changhua Strait)

### Wind turbines

Taiwan has ~3 GW installed wind capacity, dominated by **offshore wind in the Taiwan Strait** (Changhua coast). Taipower publishes a small CSV with ~99 of its own wind + solar sites at [taipower.com.tw](https://service.taipower.com.tw/data/opendata/apply/file/d693002/001.csv) but it's address-only (no coordinates) and excludes private offshore farms. OSM has good coverage of Changhua offshore wind farms via `power=generator`.

### Factory directory (gap)

[經濟部產業發展署](https://serv.gcis.nat.gov.tw/) (MOEA Industrial Dev Admin) publishes [生產中工廠清冊](https://serv.gcis.nat.gov.tw/RDownLoad/Data/statistical/) — 99,913 factory records with name, address, industry category. **No coordinates** — would require address geocoding. Not implemented.

## Validation

Taiwan implements noise regulation via:

- **環境部 (Ministry of Environment, MOENV)** noise standards
- **空氣污染防制法 + 噪音管制法** (Air Pollution Control Act + Noise Control Act)
- **Taipei City, Kaohsiung City, Taichung City** publish urban noise maps via municipal environment departments

Noise hotspots include:
- **National Freeway 1 (中山高)** through Taipei
- **Taoyuan Airport MRT** elevated sections
- **TRA Main Line** Tainan-Kaohsiung corridor (mixed passenger + freight)
- **Taichung Power Plant** area (Asia's largest coal plant)
